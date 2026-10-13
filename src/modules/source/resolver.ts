import { getSourceSettings } from './config'
import { getSourceCache, setSourceCache, type SourceCacheKind } from './cache'
import { QUALITY_FALLBACK_ORDER, SOURCE_LIMITS, TOTAL_TIMEOUT_FACTOR } from './protocol'
import { scriptPriority } from './priority'
import { getReadyHosts } from './registry'
import type { ScriptSandboxHost } from './sandbox'
import {
  parseMusicInfoOnline,
  parseQuality,
  parseToggleCandidates,
  validateLyricInfo,
  validateMusicUrl,
} from './validate'
import { createStreamToken } from './streamToken'

type Action = LX.Sync.Source.Action

const socketAbort = new WeakMap<LX.Socket, AbortController>()

export const bindSocketAbort = (socket: LX.Socket) => {
  const controller = new AbortController()
  socketAbort.set(socket, controller)
  return () => {
    controller.abort()
    socketAbort.delete(socket)
  }
}

const fail = <T>(code: LX.Sync.LuxErrorCode, message: string, detail?: unknown): LX.Sync.LuxResult<T> => ({
  ok: false,
  code,
  message,
  detail,
})

const ok = <T>(data: T): LX.Sync.LuxResult<T> => ({ ok: true, data })

const pickQuality = (host: ScriptSandboxHost, source: LX.OnlineSource, musicInfo: LX.Music.MusicInfoOnline, desired: LX.Quality): LX.Quality | null => {
  const cap = host.view.sources[source]
  if (!cap) return null
  const metaQs = musicInfo.meta?._qualitys as Partial<Record<LX.Quality, unknown>> | undefined
  const start = QUALITY_FALLBACK_ORDER.indexOf(desired)
  const order = start >= 0 ? QUALITY_FALLBACK_ORDER.slice(start) : [...QUALITY_FALLBACK_ORDER]
  if (!order.includes('128k')) order.push('128k')
  for (const q of order) {
    if (!cap.qualitys.includes(q)) continue
    if (q == '128k' || (metaQs && metaQs[q] != null)) return q
  }
  return cap.qualitys.includes('128k') ? '128k' : null
}

const hostsFor = (source: LX.OnlineSource, action: Action) =>
  getReadyHosts()
    .filter(h => h.view.sources[source]?.actions.includes(action))
    .sort((a, b) => scriptPriority(a.id) - scriptPriority(b.id))

const inFlight = new Map<string, Promise<LX.Sync.LuxResult<unknown>>>()

const runDeduped = <T>(key: string, task: () => Promise<LX.Sync.LuxResult<T>>) => {
  const existing = inFlight.get(key) as Promise<LX.Sync.LuxResult<T>> | undefined
  if (existing) return existing
  const promise = task().finally(() => inFlight.delete(key))
  inFlight.set(key, promise as Promise<LX.Sync.LuxResult<unknown>>)
  return promise
}

interface AttemptCtx {
  action: Action
  startedAt: number
  deadline: number
  perCallTimeout: number
  attempts: LX.Sync.Source.AttemptError[]
  sawTimeout: boolean
}

type ScriptAttemptResult =
  | { action: 'musicUrl', host: ScriptSandboxHost, musicInfo: LX.Music.MusicInfoOnline, quality: LX.Quality, url: string }
  | { action: 'lyric', host: ScriptSandboxHost, musicInfo: LX.Music.MusicInfoOnline, lyric: LX.Music.LyricInfo }
  | { action: 'pic', host: ScriptSandboxHost, musicInfo: LX.Music.MusicInfoOnline, url: string }

const attemptScripts = async(
  ctx: AttemptCtx,
  musicInfo: LX.Music.MusicInfoOnline,
  quality: LX.Quality | undefined,
): Promise<ScriptAttemptResult | null> => {
  const hosts = hostsFor(musicInfo.source, ctx.action)
  if (!hosts.length) return null
  for (const host of hosts) {
    if (Date.now() > ctx.deadline) {
      ctx.sawTimeout = true
      break
    }
    let q: LX.Quality | undefined
    if (ctx.action == 'musicUrl') {
      q = pickQuality(host, musicInfo.source, musicInfo, quality!) ?? undefined
      if (!q) continue
    }
    const info = ctx.action == 'musicUrl' ? { type: q, musicInfo } : { musicInfo }
    try {
      const remaining = ctx.deadline - Date.now()
      const timeout = Math.min(ctx.perCallTimeout, remaining)
      if (timeout <= 0) {
        ctx.sawTimeout = true
        break
      }
      const raw = await host.callAction(ctx.action, musicInfo.source, info, timeout)
      if (ctx.action == 'musicUrl') return { action: 'musicUrl', host, musicInfo, quality: q!, url: validateMusicUrl(raw) }
      if (ctx.action == 'lyric') return { action: 'lyric', host, musicInfo, lyric: validateLyricInfo(raw) }
      return { action: 'pic', host, musicInfo, url: validateMusicUrl(raw) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message == 'TIMEOUT' || message.includes('timeout')) ctx.sawTimeout = true
      ctx.attempts.push({
        scriptId: host.id,
        source: musicInfo.source,
        songId: musicInfo.id,
        quality: q,
        message,
      })
    }
  }
  return null
}

const buildCandidates = (
  primary: LX.Music.MusicInfoOnline,
  allowToggle: boolean,
  toggleCandidates?: LX.Music.MusicInfoOnline[],
) => {
  const list = [primary]
  if (allowToggle && toggleCandidates?.length) list.push(...toggleCandidates)
  return list
}

export const resolveMusicUrl = async(socket: LX.Socket, req: LX.Sync.Source.MusicUrlRequest): Promise<LX.Sync.LuxResult<LX.Sync.Source.MusicUrlResult>> => {
  try {
    const musicInfo = parseMusicInfoOnline(req.musicInfo)
    const quality = parseQuality(req.quality)
    const allowToggle = req.allowToggleSource !== false
    const toggles = allowToggle ? parseToggleCandidates(musicInfo.source, musicInfo.id, req.toggleCandidates) : []
    const cacheKey = `url:${musicInfo.source}:${musicInfo.id}:${quality}`
    if (!req.isRefresh) {
      const hit = getSourceCache<LX.Sync.Source.MusicUrlResult>('url', cacheKey)
      if (hit) return ok({ ...hit.value, fromCache: true, expiresAt: hit.expiresAt })
    }
    return await runDeduped(`resolve:${cacheKey}:${req.isRefresh ? '1' : '0'}`, async() => {
      const settings = getSourceSettings()
      const ctx: AttemptCtx = {
        action: 'musicUrl',
        startedAt: Date.now(),
        deadline: Date.now() + settings.timeoutMs * TOTAL_TIMEOUT_FACTOR,
        perCallTimeout: settings.timeoutMs,
        attempts: [],
        sawTimeout: false,
      }
      const candidates = buildCandidates(musicInfo, allowToggle, toggles)
      let toggled = false
      for (const candidate of candidates) {
        if (Date.now() > ctx.deadline) { ctx.sawTimeout = true; break }
        const result = await attemptScripts(ctx, candidate, quality)
        if (!result || result.action != 'musicUrl') continue
        toggled = candidate.id != musicInfo.id || candidate.source != musicInfo.source
        let url = result.url
        let proxied = false
        if (settings.proxyStream) {
          url = createStreamToken(url, 'url')
          proxied = true
        }
        const payload: LX.Sync.Source.MusicUrlResult = {
          url,
          proxied,
          quality: result.quality,
          musicInfo: result.musicInfo,
          toggled,
          fromCache: false,
          expiresAt: 0,
        }
        const actualKey = `url:${result.musicInfo.source}:${result.musicInfo.id}:${result.quality}`
        const expiresAt = setSourceCache('url', actualKey, payload, Date.now())
        if (actualKey != cacheKey) setSourceCache('url', cacheKey, payload, Date.now())
        payload.expiresAt = expiresAt
        return ok(payload)
      }
      if (!getReadyHosts().some(h => h.view.sources[musicInfo.source]?.actions.includes('musicUrl'))) {
        return fail('NO_SOURCE', 'no script supports this source', ctx.attempts)
      }
      if (ctx.sawTimeout || Date.now() - ctx.startedAt > settings.timeoutMs * TOTAL_TIMEOUT_FACTOR) {
        return fail('TIMEOUT', 'resolve timed out', ctx.attempts)
      }
      return fail('SOURCE_FAILED', 'all scripts failed', ctx.attempts)
    })
  } catch (err) {
    return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err))
  }
}

export const resolveLyric = async(_socket: LX.Socket, req: LX.Sync.Source.LyricRequest): Promise<LX.Sync.LuxResult<LX.Sync.Source.LyricResult>> => {
  try {
    const musicInfo = parseMusicInfoOnline(req.musicInfo)
    const allowToggle = req.allowToggleSource !== false
    const toggles = allowToggle ? parseToggleCandidates(musicInfo.source, musicInfo.id, req.toggleCandidates) : []
    const cacheKey = `lyric:${musicInfo.source}:${musicInfo.id}`
    if (!req.isRefresh) {
      const hit = getSourceCache<LX.Sync.Source.LyricResult>('lyric', cacheKey)
      if (hit) return ok({ ...hit.value, fromCache: true, expiresAt: hit.expiresAt })
    }
    const settings = getSourceSettings()
    const ctx: AttemptCtx = {
      action: 'lyric',
      startedAt: Date.now(),
      deadline: Date.now() + settings.timeoutMs * TOTAL_TIMEOUT_FACTOR,
      perCallTimeout: settings.timeoutMs,
      attempts: [],
      sawTimeout: false,
    }
    if (!getReadyHosts().some(h => h.view.sources[musicInfo.source]?.actions.includes('lyric'))) {
      return fail('ACTION_UNSUPPORTED', 'lyric action is not available for this source')
    }
    for (const candidate of buildCandidates(musicInfo, allowToggle, toggles)) {
      const result = await attemptScripts(ctx, candidate, undefined)
      if (!result || result.action != 'lyric') continue
      const toggled = candidate.id != musicInfo.id || candidate.source != musicInfo.source
      const payload: LX.Sync.Source.LyricResult = {
        lyric: result.lyric,
        musicInfo: result.musicInfo,
        toggled,
        fromCache: false,
        expiresAt: 0,
      }
      payload.expiresAt = setSourceCache('lyric', cacheKey, payload)
      return ok(payload)
    }
    if (ctx.sawTimeout) return fail('TIMEOUT', 'resolve timed out', ctx.attempts)
    return fail('SOURCE_FAILED', 'all scripts failed', ctx.attempts)
  } catch (err) {
    return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err))
  }
}

export const resolvePic = async(_socket: LX.Socket, req: LX.Sync.Source.PicRequest): Promise<LX.Sync.LuxResult<LX.Sync.Source.PicResult>> => {
  try {
    const musicInfo = parseMusicInfoOnline(req.musicInfo)
    const allowToggle = req.allowToggleSource !== false
    const toggles = allowToggle ? parseToggleCandidates(musicInfo.source, musicInfo.id, req.toggleCandidates) : []
    const cacheKey = `pic:${musicInfo.source}:${musicInfo.id}`
    const picUrl = musicInfo.meta?.picUrl
    if (!req.isRefresh && typeof picUrl == 'string' && /^https?:/.test(picUrl)) {
      const expiresAt = setSourceCache('pic', cacheKey, { url: picUrl, from: 'meta' as const, musicInfo, toggled: false, fromCache: false, expiresAt: 0 })
      return ok({ url: picUrl, from: 'meta', musicInfo, toggled: false, fromCache: false, expiresAt })
    }
    if (!req.isRefresh) {
      const hit = getSourceCache<LX.Sync.Source.PicResult>('pic', cacheKey)
      if (hit) return ok({ ...hit.value, fromCache: true, expiresAt: hit.expiresAt })
    }
    if (!getReadyHosts().some(h => h.view.sources[musicInfo.source]?.actions.includes('pic'))) {
      return fail('ACTION_UNSUPPORTED', 'pic action is not available for this source')
    }
    const settings = getSourceSettings()
    const ctx: AttemptCtx = {
      action: 'pic',
      startedAt: Date.now(),
      deadline: Date.now() + settings.timeoutMs * TOTAL_TIMEOUT_FACTOR,
      perCallTimeout: settings.timeoutMs,
      attempts: [],
      sawTimeout: false,
    }
    for (const candidate of buildCandidates(musicInfo, allowToggle, toggles)) {
      const result = await attemptScripts(ctx, candidate, undefined)
      if (!result || result.action != 'pic') continue
      const toggled = candidate.id != musicInfo.id || candidate.source != musicInfo.source
      const payload: LX.Sync.Source.PicResult = {
        url: result.url,
        from: 'script',
        musicInfo: result.musicInfo,
        toggled,
        fromCache: false,
        expiresAt: 0,
      }
      payload.expiresAt = setSourceCache('pic', cacheKey, payload)
      return ok(payload)
    }
    if (ctx.sawTimeout) return fail('TIMEOUT', 'resolve timed out', ctx.attempts)
    return fail('SOURCE_FAILED', 'all scripts failed', ctx.attempts)
  } catch (err) {
    return fail('INVALID_PARAMS', err instanceof Error ? err.message : String(err))
  }
}

export const testScriptAction = async(
  scriptId: string,
  action: Action,
  musicInfo: LX.Music.MusicInfoOnline,
  quality?: LX.Quality,
) => {
  const host = getReadyHosts().find(h => h.id == scriptId)
  if (!host) throw new Error('script is not ready')
  const started = Date.now()
  try {
    const q = action == 'musicUrl' ? pickQuality(host, musicInfo.source, musicInfo, quality ?? '128k') : undefined
    if (action == 'musicUrl' && !q) throw new Error('quality not supported')
    const info = action == 'musicUrl' ? { type: q, musicInfo } : { musicInfo }
    const settings = getSourceSettings()
    const raw = await host.callAction(action, musicInfo.source, info, settings.timeoutMs)
    const durationMs = Date.now() - started
    if (action == 'lyric') return { ok: true as const, durationMs, result: validateLyricInfo(raw) }
    return { ok: true as const, durationMs, result: validateMusicUrl(raw) }
  } catch (err) {
    return { ok: false as const, durationMs: Date.now() - started, message: err instanceof Error ? err.message : String(err) }
  }
}
