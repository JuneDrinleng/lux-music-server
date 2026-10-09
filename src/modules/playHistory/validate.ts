import { PLAY_HISTORY_LIMITS } from './protocol'

export class PlayHistoryValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlayHistoryValidationError'
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value == 'object' && value != null && !Array.isArray(value)
}

const requireString = (value: unknown, field: string, max: number, allowEmpty: boolean): string => {
  if (typeof value != 'string') throw new PlayHistoryValidationError(`${field} must be a string`)
  if (!allowEmpty && value.length == 0) throw new PlayHistoryValidationError(`${field} must not be empty`)
  if (value.length > max) throw new PlayHistoryValidationError(`${field} exceeds limit of ${max}`)
  return value
}

const optionalString = (value: unknown, field: string, max: number): string | undefined => {
  if (value == null) return undefined
  return requireString(value, field, max, true)
}

const requireInt = (value: unknown, field: string): number => {
  if (typeof value != 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new PlayHistoryValidationError(`${field} must be a non-negative integer`)
  }
  return value
}

export const parseRecord = (input: unknown, index?: number): LX.Sync.PlayHistory.Record => {
  const at = index == null ? 'record' : `records[${index}]`
  if (!isPlainObject(input)) throw new PlayHistoryValidationError(`${at} must be an object`)

  const deviceId = requireString(input.deviceId, `${at}.deviceId`, PLAY_HISTORY_LIMITS.deviceId, false)
  const startedAt = requireInt(input.startedAt, `${at}.startedAt`)
  const endedAt = requireInt(input.endedAt, `${at}.endedAt`)
  const listenedMs = requireInt(input.listenedMs, `${at}.listenedMs`)
  const id = requireString(input.id, `${at}.id`, PLAY_HISTORY_LIMITS.id, false)
  const expectedId = `${deviceId}:${startedAt}`
  if (id != expectedId) throw new PlayHistoryValidationError(`${at}.id must equal deviceId:startedAt`)

  if (!isPlainObject(input.song)) throw new PlayHistoryValidationError(`${at}.song must be an object`)
  const song: LX.Sync.PlayHistory.Song = {
    source: requireString(input.song.source, `${at}.song.source`, PLAY_HISTORY_LIMITS.source, false),
    songmid: requireString(input.song.songmid, `${at}.song.songmid`, PLAY_HISTORY_LIMITS.songmid, false),
    name: requireString(input.song.name, `${at}.song.name`, PLAY_HISTORY_LIMITS.name, true),
    singer: requireString(input.song.singer, `${at}.song.singer`, PLAY_HISTORY_LIMITS.singer, true),
  }
  const albumName = optionalString(input.song.albumName, `${at}.song.albumName`, PLAY_HISTORY_LIMITS.albumName)
  const interval = optionalString(input.song.interval, `${at}.song.interval`, PLAY_HISTORY_LIMITS.interval)
  const img = optionalString(input.song.img, `${at}.song.img`, PLAY_HISTORY_LIMITS.img)
  if (albumName != null) song.albumName = albumName
  if (interval != null) song.interval = interval
  if (img != null) song.img = img

  return { id, deviceId, startedAt, endedAt, listenedMs, song }
}

export const parsePushPayload = (payload: unknown): LX.Sync.PlayHistory.Record[] => {
  if (!isPlainObject(payload)) throw new PlayHistoryValidationError('push payload must be an object')
  if (!Array.isArray(payload.records)) throw new PlayHistoryValidationError('records must be an array')
  if (payload.records.length > PLAY_HISTORY_LIMITS.maxBatch) {
    throw new PlayHistoryValidationError(`records exceeds limit of ${PLAY_HISTORY_LIMITS.maxBatch}`)
  }
  return payload.records.map((record, index) => parseRecord(record, index))
}

export const parsePullPayload = (payload: unknown): number => {
  if (payload == null) return 0
  if (!isPlainObject(payload)) throw new PlayHistoryValidationError('pull payload must be an object')
  if (payload.since == null) return 0
  return requireInt(payload.since, 'since')
}
