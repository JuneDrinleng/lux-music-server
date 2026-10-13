import { INVITE_CODE_REGEXP } from './protocol'

const ONLINE_SOURCES = new Set<string>(['kw', 'kg', 'tx', 'wy', 'mg'])
const QUALITIES = new Set<string>(['128k', '320k', 'flac', 'flac24bit', '192k', 'ape', 'wav'])

export const isRecord = (value: unknown): value is Record<string, any> => (
  typeof value == 'object' && value != null && !Array.isArray(value)
)

export const isFiniteNumber = (value: unknown): value is number => typeof value == 'number' && Number.isFinite(value)

export const isNonNegativeNumber = (value: unknown): value is number => isFiniteNumber(value) && value >= 0

export const isQuality = (value: unknown): value is LX.Quality => typeof value == 'string' && QUALITIES.has(value)

/** Returns a detached copy, or null when the song is local or malformed. Drops mobile-only `meta.toggleMusicInfo`. */
export const sanitizeMusicInfo = (value: unknown): LX.Music.MusicInfoOnline | null => {
  if (!isRecord(value)) return null
  if (typeof value.source != 'string' || !ONLINE_SOURCES.has(value.source)) return null
  if (typeof value.id != 'string' || !value.id) return null
  if (typeof value.name != 'string' || typeof value.singer != 'string') return null
  if (value.interval != null && typeof value.interval != 'string') return null
  if (!isRecord(value.meta)) return null
  let copy: LX.Music.MusicInfoOnline & { meta: Record<string, unknown> }
  try {
    copy = JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
  delete copy.meta.toggleMusicInfo
  return copy
}

/** Accepts codes typed with spaces, e.g. "123 456". */
export const normalizeInviteCode = (value: unknown): string | null => {
  if (typeof value != 'string') return null
  const code = value.trim().replace(/\s+/g, '')
  return INVITE_CODE_REGEXP.test(code) ? code : null
}
