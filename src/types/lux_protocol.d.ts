// Shared Lux results and listen-together errors.
declare namespace LX {
  namespace Sync {
    type LuxErrorCode =
      // common
      | 'INVALID_PARAMS' | 'RATE_LIMITED' | 'INTERNAL'
      // together
      | 'NOT_LUX_ACCOUNT' | 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'ROOM_LIMIT'
      | 'ALREADY_IN_ROOM' | 'NOT_IN_ROOM' | 'NOT_HOST' | 'MEMBER_NOT_FOUND'
      | 'REQUEST_NOT_FOUND' | 'REQUEST_LIMIT' | 'DUPLICATE_SONG' | 'NOT_REQUESTER'
      | 'MEMBER_OFFLINE' | 'VERSION_CONFLICT' | 'INVALID_MUSIC'

    type LuxResult<T> =
      | { ok: true, data: T }
      | { ok: false, code: LuxErrorCode, message: string, detail?: unknown }
  }
}
