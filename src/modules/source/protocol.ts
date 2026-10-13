/**
 * Lux server-side source resolution contract (see listen-together-protocol.md §3).
 * Message names are single-segment message2call paths. Legacy LX clients never enable this feature.
 */
export const SOURCE_FEATURE_VERSION = 1

export const SOURCE_GET_INFO = 'source:getInfo' as const
export const SOURCE_RESOLVE_MUSIC_URL = 'source:resolveMusicUrl' as const
export const SOURCE_RESOLVE_LYRIC = 'source:resolveLyric' as const
export const SOURCE_RESOLVE_PIC = 'source:resolvePic' as const
export const SOURCE_ON_INFO_CHANGED = 'source:onInfoChanged' as const

export const ONLINE_SOURCES: readonly LX.OnlineSource[] = ['kw', 'kg', 'tx', 'wy', 'mg']
export const ALL_QUALITYS: readonly LX.Quality[] = ['128k', '320k', 'flac', 'flac24bit', '192k', 'ape', 'wav']
/** Qualities a script may declare, in ascending order. */
export const SCRIPT_QUALITYS: readonly LX.Quality[] = ['128k', '320k', 'flac', 'flac24bit']
/** Descending preference used when picking a quality for a script. */
export const QUALITY_FALLBACK_ORDER: readonly LX.Quality[] = ['flac24bit', 'flac', '320k', '128k']
export const SCRIPT_ACTIONS: readonly LX.Sync.Source.Action[] = ['musicUrl', 'lyric', 'pic']

export const SOURCE_LIMITS = {
  maxToggleCandidates: 10,
  maxUrlLength: 2048,
  lyric: 51200,
  tlyric: 5120,
  rlyric: 5120,
  lxlyric: 8192,
  updateAlertLog: 1024,
  scriptChars: 1024 * 1024,
  requestBodyBytes: 5 * 1024 * 1024,
  requestDefaultTimeoutMs: 13_000,
  requestMaxTimeoutMs: 60_000,
  logLines: 100,
} as const

export const SOURCE_CACHE = {
  max: 2000,
  urlTtlMs: 20 * 60 * 1000,
  lyricTtlMs: 24 * 60 * 60 * 1000,
  picTtlMs: 24 * 60 * 60 * 1000,
} as const

/** Total budget for one resolve request, as a multiple of LUX_SOURCE_TIMEOUT_MS. */
export const TOTAL_TIMEOUT_FACTOR = 3
