/**
 * Runs inside a worker_threads Worker, one per enabled script.
 * The user script lives in a separate vm context and only ever receives values created in its own realm:
 * every bridge call takes and returns JSON strings / numbers, so no host object (and no host Function
 * constructor) is reachable from script code.
 */
import crypto from 'node:crypto'
import vm from 'node:vm'
import { parentPort, workerData } from 'node:worker_threads'
import zlib from 'node:zlib'

export interface WorkerInitData {
  script: string
  scriptInfo: { name: string, description: string, version: string, author: string, homepage: string }
  timeoutMs: number
}

export type MainToWorkerMessage =
  | { type: 'call', id: number, action: string, source: string, info: unknown }
  | { type: 'response', id: number, error?: string, response?: { statusCode: number, statusMessage: string, headers: Record<string, string>, body: string | Uint8Array, binary: boolean } }
  | { type: 'ping', t: number }

export type WorkerToMainMessage =
  | { type: 'pong', t: number }
  | { type: 'bridge', name: string, json: string }
  | { type: 'error', message: string }

const MAX_BRIDGE_JSON = 8 * 1024 * 1024
const MAX_UTIL_INPUT = 1024 * 1024

const PRELOAD = String.raw`'use strict';
(function(bridge, scriptInfoJson) {
  const post = bridge.post
  const util = bridge.util
  const setTimer = bridge.setTimer
  const clearTimer = bridge.clearTimer
  const g = globalThis

  const callUtil = (op, args) => {
    const result = JSON.parse(util(op, JSON.stringify(args)))
    if (!result.ok) throw new Error(result.message)
    return result.data
  }
  const isBytes = v => ArrayBuffer.isView(v) || v instanceof ArrayBuffer
  const bytesToArray = v => {
    if (Array.isArray(v)) return v
    if (v instanceof ArrayBuffer) return Array.from(new Uint8Array(v))
    if (ArrayBuffer.isView(v)) return Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
    throw new Error('Input is not a valid buffer')
  }
  const dataArg = v => typeof v === 'string' ? { s: v } : { b: bytesToArray(v) }

  const format = args => args.map(a => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return a.stack || a.message
    try { return JSON.stringify(a) } catch (_) { return String(a) }
  }).join(' ')
  const log = level => (...args) => { post('log', JSON.stringify({ level, text: format(args) })) }
  const console = Object.freeze({ log: log('info'), info: log('info'), debug: log('debug'), warn: log('warn'), error: log('error') })

  const makeTimer = repeat => (callback, timeout = 0, ...params) => {
    if (typeof callback !== 'function') throw new Error('callback required a function')
    const ms = typeof timeout === 'number' && timeout > 0 ? timeout : 0
    return setTimer(() => { callback(...params) }, ms, repeat)
  }
  const _clearTimer = id => { if (typeof id === 'number') clearTimer(id) }

  const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }
  let requestHandler = null
  let inited = false
  let alerted = false
  const requests = new Map()
  let requestSeq = 0

  const request = (url, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {} }
    if (typeof callback !== 'function') throw new Error('callback required a function')
    const opts = options || {}
    let body = opts.body
    if (body != null && isBytes(body)) body = { __bytes: bytesToArray(body) }
    const id = ++requestSeq
    requests.set(id, callback)
    post('request', JSON.stringify({
      id,
      url: String(url),
      options: {
        method: opts.method,
        timeout: opts.timeout,
        headers: opts.headers,
        body,
        form: opts.form,
        formData: opts.formData,
        binary: opts.binary === true,
      },
    }))
    return () => {
      if (requests.delete(id)) post('abort', JSON.stringify({ id }))
    }
  }
  const handleResponse = ({ id, error, response }) => {
    const callback = requests.get(id)
    if (!callback) return
    requests.delete(id)
    try {
      if (error != null) {
        callback(new Error(error), null, null)
        return
      }
      let body = response.body
      if (response.binary) {
        body = new Uint8Array(JSON.parse(body))
      } else {
        try { body = JSON.parse(body) } catch (_) {}
      }
      const resp = { statusCode: response.statusCode, statusMessage: response.statusMessage, headers: response.headers, body }
      callback(null, resp, body)
    } catch (err) {
      console.error('request callback error:', err)
    }
  }

  const send = (eventName, data) => new Promise((resolve, reject) => {
    switch (eventName) {
      case EVENT_NAMES.inited:
        if (inited) return reject(new Error('Script is inited'))
        inited = true
        post('inited', JSON.stringify(data === undefined ? null : data))
        return resolve()
      case EVENT_NAMES.updateAlert:
        if (alerted) return reject(new Error('The update alert can only be called once.'))
        alerted = true
        post('updateAlert', JSON.stringify(data === undefined ? null : data))
        return resolve()
      default:
        return reject(new Error('The event is not supported: ' + eventName))
    }
  })
  const on = (eventName, handler) => {
    if (eventName !== EVENT_NAMES.request) return Promise.reject(new Error('The event is not supported: ' + eventName))
    if (typeof handler !== 'function') return Promise.reject(new Error('handler required a function'))
    requestHandler = handler
    return Promise.resolve()
  }

  const utils = {
    crypto: {
      aesEncrypt(buffer, mode, key, iv) {
        if (mode !== 'aes-128-cbc' && mode !== 'aes-128-ecb') throw new Error('Unsupported aes mode: ' + mode)
        return new Uint8Array(callUtil('aesEncrypt', [dataArg(buffer), mode, dataArg(key), iv == null || iv === '' ? null : dataArg(iv)]))
      },
      rsaEncrypt(buffer, key) {
        if (typeof key !== 'string') throw new Error('Invalid RSA key')
        return new Uint8Array(callUtil('rsaEncrypt', [dataArg(buffer), key]))
      },
      randomBytes(size) {
        return new Uint8Array(callUtil('randomBytes', [size]))
      },
      md5(str) {
        if (typeof str !== 'string') throw new Error('param required a string')
        return callUtil('md5', [str])
      },
    },
    buffer: {
      from(input, encoding) {
        if (typeof input === 'string') {
          if (encoding === 'binary') throw new Error('Binary encoding is not supported for input strings')
          return new Uint8Array(callUtil('bufferFrom', [input, encoding || 'utf8']))
        }
        if (Array.isArray(input) || isBytes(input)) return new Uint8Array(bytesToArray(input))
        throw new Error('Unsupported input type: ' + input + ' encoding: ' + encoding)
      },
      bufToString(buf, format) {
        if (!(Array.isArray(buf) || isBytes(buf))) throw new Error('Input is not a valid buffer: ' + buf + ' format: ' + format)
        if (format === 'binary') return buf
        return callUtil('bufToString', [bytesToArray(buf), format || 'utf8'])
      },
    },
    zlib: {
      inflate(buf) {
        return new Promise((resolve, reject) => {
          try { resolve(new Uint8Array(callUtil('inflate', [bytesToArray(buf)]))) } catch (err) { reject(err) }
        })
      },
      deflate(buf) {
        return new Promise((resolve, reject) => {
          try { resolve(new Uint8Array(callUtil('deflate', [bytesToArray(buf)]))) } catch (err) { reject(err) }
        })
      },
    },
  }

  const lx = {
    EVENT_NAMES,
    request,
    send,
    on,
    utils,
    currentScriptInfo: JSON.parse(scriptInfoJson),
    version: '2.0.0',
    env: 'mobile',
  }
  const deepFreeze = obj => {
    if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function') || Object.isFrozen(obj)) return
    Object.freeze(obj)
    for (const value of Object.values(obj)) deepFreeze(value)
  }
  deepFreeze(lx)

  const define = (name, value) => Object.defineProperty(g, name, { value, writable: false, configurable: false, enumerable: true })
  define('lx', lx)
  define('console', console)
  define('setTimeout', makeTimer(false))
  define('setInterval', makeTimer(true))
  define('clearTimeout', _clearTimer)
  define('clearInterval', _clearTimer)
  define('eval', function() { throw new Error('eval is not available') })
  const blocked = new Proxy(Function.prototype.constructor, {
    apply() { throw new Error('Dynamic code execution is not allowed.') },
    construct() { throw new Error('Dynamic code execution is not allowed.') },
  })
  Object.defineProperty(Function.prototype, 'constructor', { value: blocked, writable: false, configurable: false, enumerable: false })
  define('Function', blocked)

  const handleCall = ({ id, action, source, info }) => {
    const reply = (ok, value) => {
      let json
      try {
        json = JSON.stringify(ok
          ? { id, ok: true, data: value === undefined ? null : value }
          : { id, ok: false, message: String((value && value.message) || value || 'failed') })
      } catch (_) {
        json = JSON.stringify({ id, ok: false, message: 'result is not serializable' })
      }
      post('result', json)
    }
    if (!requestHandler) return reply(false, new Error('Request event is not defined'))
    try {
      Promise.resolve(requestHandler.call(lx, { source, action, info })).then(v => reply(true, v), e => reply(false, e))
    } catch (err) {
      reply(false, err)
    }
  }

  return (type, json) => {
    const data = JSON.parse(json)
    if (type === 'call') handleCall(data)
    else if (type === 'response') handleResponse(data)
  }
})`

/** Script errors come from another realm, so `instanceof Error` is false for them. */
const errorText = (err: unknown, withStack = false) => {
  if (err && typeof err == 'object') {
    const { message, stack } = err as { message?: unknown, stack?: unknown }
    if (withStack && typeof stack == 'string') return stack
    if (typeof message == 'string') return message
  }
  return String(err)
}

const run = () => {
  const port = parentPort
  if (!port) throw new Error('worker.ts must run inside a worker thread')
  const { script, scriptInfo, timeoutMs } = workerData as WorkerInitData

  const ok = (data: unknown) => JSON.stringify({ ok: true, data })
  const fail = (err: unknown) => JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err) })

  const decodeData = (value: unknown): Buffer => {
    if (value && typeof value == 'object') {
      const v = value as { s?: unknown, b?: unknown }
      if (typeof v.s == 'string') {
        if (v.s.length > MAX_UTIL_INPUT) throw new Error('Input too long')
        return Buffer.from(v.s, 'utf8')
      }
      if (Array.isArray(v.b)) {
        if (v.b.length > MAX_UTIL_INPUT * 4) throw new Error('Input too long')
        return Buffer.from(v.b as number[])
      }
    }
    throw new Error('invalid data')
  }
  const toArray = (buf: Buffer) => Array.from(buf)

  const utilOps: Record<string, (args: any[]) => unknown> = {
    aesEncrypt([buffer, mode, key, iv]) {
      const cipher = crypto.createCipheriv(mode as string, decodeData(key), iv == null ? null : decodeData(iv))
      return toArray(Buffer.concat([cipher.update(decodeData(buffer)), cipher.final()]))
    },
    rsaEncrypt([buffer, key]) {
      let pem = String(key).trim()
      if (!pem.includes('-----BEGIN')) pem = `-----BEGIN PUBLIC KEY-----\n${pem}\n-----END PUBLIC KEY-----`
      return toArray(crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_NO_PADDING }, decodeData(buffer)))
    },
    randomBytes([size]) {
      if (typeof size != 'number' || !Number.isInteger(size) || size < 0 || size > 65536) throw new Error('invalid size')
      return toArray(crypto.randomBytes(size))
    },
    md5([str]) {
      if (typeof str != 'string' || str.length > MAX_UTIL_INPUT) throw new Error('param required a string')
      return crypto.createHash('md5').update(encodeURIComponent(str)).digest('hex')
    },
    bufferFrom([input, encoding]) {
      if (typeof input != 'string' || input.length > MAX_UTIL_INPUT * 4) throw new Error('Input too long')
      switch (encoding) {
        case 'base64': return toArray(Buffer.from(input, 'base64'))
        case 'hex': return toArray(Buffer.from(input, 'hex'))
        default: return toArray(Buffer.from(input, 'utf8'))
      }
    },
    bufToString([arr, format]) {
      const buf = decodeData({ b: arr })
      switch (format) {
        case 'hex': return buf.toString('hex')
        case 'base64': return buf.toString('base64')
        default: return buf.toString('utf8')
      }
    },
    inflate([arr]) {
      return toArray(zlib.inflateSync(decodeData({ b: arr }), { maxOutputLength: 5 * 1024 * 1024 }))
    },
    deflate([arr]) {
      return toArray(zlib.deflateSync(decodeData({ b: arr })))
    },
  }

  const timers = new Map<number, NodeJS.Timeout>()
  let timerSeq = 0

  const reportError = (prefix: string, err: unknown) => {
    const text = `${prefix}${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
    port.postMessage({ type: 'bridge', name: 'log', json: JSON.stringify({ level: 'error', text }) } satisfies WorkerToMainMessage)
  }

  const bridge = Object.freeze({
    post(name: string, json: string) {
      if (typeof name != 'string' || typeof json != 'string') return
      if (json.length > MAX_BRIDGE_JSON) {
        reportError('', new Error(`${name} payload too large`))
        return
      }
      port.postMessage({ type: 'bridge', name, json } satisfies WorkerToMainMessage)
    },
    util(op: string, json: string) {
      try {
        const fn = utilOps[op]
        if (!fn || typeof json != 'string' || json.length > MAX_BRIDGE_JSON) throw new Error('invalid util call')
        return ok(fn(JSON.parse(json) as any[]))
      } catch (err) {
        return fail(err)
      }
    },
    setTimer(callback: () => void, ms: number, repeat: boolean) {
      const id = ++timerSeq
      const fire = () => {
        if (!repeat) timers.delete(id)
        try {
          callback()
        } catch (err) {
          reportError('timer callback error: ', err)
        }
      }
      timers.set(id, repeat ? setInterval(fire, ms) : setTimeout(fire, ms))
      return id
    },
    clearTimer(id: number) {
      const timer = timers.get(id)
      if (!timer) return
      clearTimeout(timer)
      timers.delete(id)
    },
  })

  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } })
  const setup = vm.runInContext(PRELOAD, context, { filename: 'lux-preload.js' }) as (b: typeof bridge, info: string) => (type: string, json: string) => void
  const dispatch = setup(bridge, JSON.stringify({ ...scriptInfo, rawScript: script }))

  port.on('message', (msg: MainToWorkerMessage) => {
    switch (msg.type) {
      case 'ping':
        port.postMessage({ type: 'pong', t: msg.t } satisfies WorkerToMainMessage)
        return
      case 'call':
        try {
          dispatch('call', JSON.stringify({ id: msg.id, action: msg.action, source: msg.source, info: msg.info }))
        } catch (err) {
          port.postMessage({ type: 'bridge', name: 'result', json: JSON.stringify({ id: msg.id, ok: false, message: err instanceof Error ? err.message : String(err) }) } satisfies WorkerToMainMessage)
        }
        return
      case 'response':
        try {
          const response = msg.response && {
            ...msg.response,
            body: typeof msg.response.body == 'string' ? msg.response.body : JSON.stringify(Array.from(msg.response.body)),
          }
          dispatch('response', JSON.stringify({ id: msg.id, error: msg.error, response }))
        } catch (err) {
          reportError('response dispatch error: ', err)
        }
    }
  })

  const reportFatal = (label: string, err: unknown) => {
    const message = errorText(err, true)
    port.postMessage({ type: 'error', message: `${label}${message}` } satisfies WorkerToMainMessage)
  }

  process.on('uncaughtException', err => {
    reportFatal('uncaughtException: ', err)
    process.exit(1)
  })
  process.on('unhandledRejection', reason => {
    reportFatal('unhandledRejection: ', reason)
    process.exit(1)
  })

  try {
    new vm.Script(script, { filename: 'user-api.js' }).runInContext(context, { timeout: timeoutMs })
  } catch (err) {
    reportFatal('', err)
  }
}

if (parentPort) run()
