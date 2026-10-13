import { ONLINE_SOURCES, SCRIPT_QUALITYS, SOURCE_LIMITS } from './protocol'

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v == 'object' && v != null && !Array.isArray(v)

export const isOnlineSource = (source: unknown): source is LX.OnlineSource =>
  typeof source == 'string' && (ONLINE_SOURCES as readonly string[]).includes(source)

export const parseMusicInfoOnline = (input: unknown): LX.Music.MusicInfoOnline => {
  if (!isPlain(input)) throw new Error('musicInfo must be an object')
  if (!isOnlineSource(input.source)) throw new Error('musicInfo.source must be an online source')
  if (typeof input.id != 'string' || !input.id) throw new Error('musicInfo.id must be a string')
  if (typeof input.name != 'string') throw new Error('musicInfo.name must be a string')
  if (!isPlain(input.meta)) throw new Error('musicInfo.meta must be an object')
  return input as unknown as LX.Music.MusicInfoOnline
}

export const parseQuality = (input: unknown): LX.Quality => {
  if (typeof input != 'string' || !(SCRIPT_QUALITYS as readonly string[]).includes(input)) {
    throw new Error('quality is invalid')
  }
  return input as LX.Quality
}

export const parseToggleCandidates = (reqSource: LX.OnlineSource, reqId: string, input: unknown): LX.Music.MusicInfoOnline[] => {
  if (input == null) return []
  if (!Array.isArray(input)) throw new Error('toggleCandidates must be an array')
  if (input.length > SOURCE_LIMITS.maxToggleCandidates) throw new Error('toggleCandidates exceeds limit')
  const out: LX.Music.MusicInfoOnline[] = []
  for (const item of input) {
    const info = parseMusicInfoOnline(item)
    if (info.source == reqSource && info.id == reqId) continue
    out.push(info)
  }
  return out
}

export const validateMusicUrl = (value: unknown): string => {
  if (typeof value != 'string' || value.length > SOURCE_LIMITS.maxUrlLength || !/^https?:/.test(value)) {
    throw new Error('invalid music url result')
  }
  return value
}

export const validateLyricInfo = (value: unknown): LX.Music.LyricInfo => {
  if (!isPlain(value) || typeof value.lyric != 'string' || value.lyric.length > SOURCE_LIMITS.lyric) {
    throw new Error('invalid lyric result')
  }
  const trimOpt = (field: 'tlyric' | 'rlyric' | 'lxlyric', max: number) => {
    const v = value[field]
    if (v == null) return null
    if (typeof v != 'string') return null
    if (v.length > max) return null
    return v
  }
  return {
    lyric: value.lyric,
    tlyric: trimOpt('tlyric', SOURCE_LIMITS.tlyric),
    rlyric: trimOpt('rlyric', SOURCE_LIMITS.rlyric),
    lxlyric: trimOpt('lxlyric', SOURCE_LIMITS.lxlyric),
  }
}
