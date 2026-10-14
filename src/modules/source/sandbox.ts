import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import log4js from 'log4js'
import { getSourceSettings } from './config'
import { BlockedAddressError, safeRequest } from './httpClient'
import { SOURCE_LIMITS } from './protocol'
import { normalizeInitedSources, type SourceScriptView } from './scriptManage'
import type { MainToWorkerMessage } from './worker'

const logger = log4js.getLogger('source')

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

type PendingHttp = {
  abort: () => void
}

export interface ScriptRuntimeState {
  view: SourceScriptView
}

const workerFile = () => {
  const file = __filename.endsWith('.ts') ? 'worker.ts' : 'worker.js'
  return path.join(__dirname, file)
}

const defaultHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36',
  Accept: 'application/json',
}

const buildRequestBody = (options: Record<string, unknown>) => {
  let method = String(options.method ?? 'get').toLowerCase()
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> | undefined) }
  let body: string | Buffer | undefined
  if (method == 'post' && !headers['Content-Type']) {
    if (options.form && typeof options.form == 'object') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = Object.entries(options.form as Record<string, string>)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    } else if (options.formData != null) {
      headers['Content-Type'] = 'multipart/form-data'
      body = String(options.formData)
    } else if (options.body != null) {
      headers['Content-Type'] = 'application/json'
      body = typeof options.body == 'string' ? options.body : JSON.stringify(options.body)
    }
  } else if (headers['Content-Type'] == 'application/json' && options.body != null && typeof options.body != 'string') {
    body = JSON.stringify(options.body)
  } else if (options.body != null) {
    body = typeof options.body == 'string' ? options.body : JSON.stringify(options.body)
  }
  return { method: method.toUpperCase(), headers: { ...defaultHeaders, ...headers }, body, binary: options.binary === true }
}

export class ScriptSandboxHost {
  private worker: Worker | null = null
  private callSeq = 0
  private httpSeq = 0
  private pendingCalls = new Map<number, PendingCall>()
  private pendingHttp = new Map<number, PendingHttp>()
  private heartbeatTimer: NodeJS.Timeout | null = null
  private lastPong = Date.now()
  private restartAttempts = 0
  private restarting: Promise<void> | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private allowAutoRestart = true
  /** Set when the worker posts type:error (uncaught/unhandled); survives exit/restart formatting. */
  private lastWorkerFatalError: string | null = null
  private initWait: { resolve: () => void, reject: (err: Error) => void, timer: NodeJS.Timeout } | null = null
  private logLines: string[] = []
  readonly id: string
  view: SourceScriptView
  private readonly script: string
  private readonly onStateChange: () => void

  constructor(id: string, script: string, entryView: SourceScriptView, onStateChange: () => void) {
    this.id = id
    this.script = script
    this.view = { ...entryView, status: 'initializing', error: null, sources: {}, updateAlert: null }
    this.onStateChange = onStateChange
  }

  getRuntime(): ScriptRuntimeState {
    return { view: this.view }
  }

  private pushLog(line: string) {
    this.logLines.push(line)
    if (this.logLines.length > SOURCE_LIMITS.logLines) this.logLines.shift()
  }

  private setView(patch: Partial<SourceScriptView>) {
    this.view = { ...this.view, ...patch }
    this.onStateChange()
  }

  async start(): Promise<void> {
    this.allowAutoRestart = true
    const settings = getSourceSettings()
    this.setView({ status: 'initializing', error: null, sources: {}, updateAlert: null })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('script init timeout')), settings.timeoutMs)
        this.initWait = { resolve: () => { clearTimeout(timer); resolve() }, reject: (err) => { clearTimeout(timer); reject(err) }, timer }
        void this.spawnWorker().catch(err => {
          this.initWait?.reject(err instanceof Error ? err : new Error(String(err)))
          this.initWait = null
        })
      })
    } catch (err) {
      this.allowAutoRestart = false
      await this.stop(false)
      throw err
    } finally {
      this.initWait = null
    }
  }

  async stop(markDisabled = true) {
    this.allowAutoRestart = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.restarting = null
    this.clearHeartbeat()
    for (const pending of this.pendingCalls.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('worker stopped'))
    }
    this.pendingCalls.clear()
    for (const http of this.pendingHttp.values()) http.abort()
    this.pendingHttp.clear()
    if (this.worker) {
      await this.worker.terminate().catch(() => undefined)
      this.worker = null
    }
    if (markDisabled) this.setView({ status: 'disabled', error: null })
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private heartbeatStuckMs(settings: ReturnType<typeof getSourceSettings>) {
    if (this.view.status == 'initializing') return settings.timeoutMs
    if (this.pendingHttp.size > 0) return settings.timeoutMs
    return 500
  }

  private workerFailureDetail(code: number | null, fallback: string) {
    return this.lastWorkerFatalError ?? fallback ?? `worker exited with code ${code ?? 1}`
  }

  private async spawnWorker(): Promise<void> {
    this.lastWorkerFatalError = null
    const settings = getSourceSettings()
    const meta = {
      name: this.view.name,
      description: this.view.description,
      version: this.view.version,
      author: this.view.author,
      homepage: this.view.homepage,
    }
    const worker = new Worker(workerFile(), {
      workerData: { script: this.script, scriptInfo: meta, timeoutMs: settings.timeoutMs },
      resourceLimits: {
        maxOldGenerationSizeMb: settings.memoryMb,
        maxYoungGenerationSizeMb: 16,
      },
      execArgv: __filename.endsWith('.ts')
        ? ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register']
        : undefined,
    })
    this.worker = worker
    this.lastPong = Date.now()
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (!this.worker) return
      const stuckMs = this.heartbeatStuckMs(settings)
      if (Date.now() - this.lastPong > stuckMs) void this.handleWorkerStuck()
      else this.worker.postMessage({ type: 'ping', t: Date.now() } satisfies MainToWorkerMessage)
    }, 200)

    worker.on('message', (msg: { type: string, name?: string, json?: string, t?: number, message?: string }) => {
      if (msg.type == 'pong') {
        this.lastPong = Date.now()
        return
      }
      if (msg.type == 'error') {
        const message = msg.message ?? 'worker error'
        this.lastWorkerFatalError = message
        this.allowAutoRestart = false
        this.setView({ status: 'error', error: message })
        this.initWait?.reject(new Error(message))
        return
      }
      if (msg.type == 'bridge') this.handleBridge(msg.name!, msg.json!)
    })

    worker.on('error', err => {
      const error = err instanceof Error ? err : new Error(String(err))
      this.setView({ status: 'error', error: error.message })
      this.initWait?.reject(error)
    })

    worker.on('exit', code => {
      if (code == 0 || this.view.status == 'disabled') return
      const fallback = `worker exited with code ${code}`
      const detail = this.workerFailureDetail(code, fallback)
      if (this.initWait) {
        this.allowAutoRestart = false
        this.setView({ status: 'error', error: detail })
        this.initWait.reject(new Error(detail))
        return
      }
      void this.handleWorkerExit(detail)
    })
  }

  private async handleWorkerExit(reason: string) {
    if (this.view.status == 'disabled' || !this.allowAutoRestart) return
    const detail = this.workerFailureDetail(null, reason)
    this.setView({ status: 'error', error: detail })
    await this.scheduleRestart(detail)
  }

  private async handleWorkerStuck() {
    if (!this.worker || this.view.status == 'disabled') return
    logger.warn(`script ${this.id} heartbeat timeout, terminating worker`)
    await this.worker.terminate().catch(() => undefined)
    this.worker = null
    await this.handleWorkerExit('worker heartbeat timeout')
  }

  private async scheduleRestart(reason: string) {
    if (this.restarting) return this.restarting
    this.restartAttempts++
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.restartAttempts - 1, 6))
    const detail = this.workerFailureDetail(null, reason)
    this.setView({ status: 'error', error: `${detail}; restarting in ${delay}ms` })
    this.restarting = new Promise(resolve => {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        this.restarting = null
        if (this.view.status == 'disabled') {
          resolve()
          return
        }
        this.setView({ status: 'initializing', error: null })
        void this.spawnWorker().catch(err => {
          this.setView({ status: 'error', error: err.message })
        }).finally(resolve)
      }, delay)
    })
    return this.restarting
  }

  private handleBridge(name: string, json: string) {
    let data: any
    try {
      data = JSON.parse(json)
    } catch {
      return
    }
    switch (name) {
      case 'log': {
        const text = `[${data.level}] ${data.text}`
        logger.info(`script ${this.id}: ${text}`)
        this.pushLog(text)
        return
      }
      case 'inited':
        try {
          const sources = normalizeInitedSources(data)
          this.setView({ status: 'ready', error: null, sources })
          this.restartAttempts = 0
          this.initWait?.resolve()
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.setView({ status: 'error', error: message })
          this.initWait?.reject(new Error(message))
        }
        return
      case 'updateAlert': {
        let log = typeof data?.log == 'string' ? data.log : ''
        if (log.length > SOURCE_LIMITS.updateAlertLog) log = `${log.slice(0, SOURCE_LIMITS.updateAlertLog)}...`
        const updateUrl = typeof data?.updateUrl == 'string' ? data.updateUrl : undefined
        this.setView({ updateAlert: { log, updateUrl } })
        return
      }
      case 'request':
        void this.handleHttpRequest(data)
        return
      case 'abort': {
        const http = this.pendingHttp.get(data.id)
        if (http) {
          http.abort()
          this.pendingHttp.delete(data.id)
        }
        return
      }
      case 'result':
        this.finishCall(data.id, data.ok, data.ok ? data.data : data.message)
        return
    }
  }

  private finishCall(id: number, ok: boolean, payload: unknown) {
    const pending = this.pendingCalls.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingCalls.delete(id)
    if (ok) pending.resolve(payload)
    else pending.reject(new Error(String(payload ?? 'failed')))
  }

  private async handleHttpRequest(data: { id: number, url: string, options: Record<string, unknown> }) {
    const settings = getSourceSettings()
    const built = buildRequestBody(data.options ?? {})
    const timeoutMs = Math.min(
      typeof data.options?.timeout == 'number' && data.options.timeout > 0 ? data.options.timeout : SOURCE_LIMITS.requestDefaultTimeoutMs,
      SOURCE_LIMITS.requestMaxTimeoutMs,
    )
    const respond = (error: string | null, response?: { statusCode: number, statusMessage: string, headers: Record<string, string>, body: string | Uint8Array, binary: boolean }) => {
      this.worker?.postMessage({
        type: 'response',
        id: data.id,
        error: error ?? undefined,
        response,
      } satisfies MainToWorkerMessage)
    }
    this.pendingHttp.set(data.id, { abort: () => undefined })
    try {
      const result = await safeRequest(data.url, {
        method: built.method,
        headers: built.headers,
        body: built.body,
        timeoutMs,
        maxBytes: SOURCE_LIMITS.requestBodyBytes,
      })
      let body: string | Uint8Array
      if (built.binary) body = result.body
      else body = JSON.stringify(result.body.toString('utf8'))
      respond(null, {
        statusCode: result.statusCode,
        statusMessage: result.statusMessage,
        headers: result.headers,
        body,
        binary: built.binary,
      })
    } catch (err) {
      const message = err instanceof BlockedAddressError ? err.message : (err instanceof Error ? err.message : String(err))
      respond(message)
    } finally {
      this.pendingHttp.delete(data.id)
    }
  }

  async callAction(action: string, source: string, info: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.worker || this.view.status != 'ready') throw new Error('script not ready')
    const id = ++this.callSeq
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingCalls.has(id)) return
        this.pendingCalls.delete(id)
        reject(new Error('TIMEOUT'))
      }, Math.max(1, timeoutMs))
      this.pendingCalls.set(id, { resolve, reject, timer })
      this.worker!.postMessage({ type: 'call', id, action, source, info } satisfies MainToWorkerMessage)
    })
  }

  cancelPendingCalls() {
    for (const pending of this.pendingCalls.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('cancelled'))
    }
    this.pendingCalls.clear()
  }
}

export const readWorkerFileExists = () => fs.existsSync(workerFile())
