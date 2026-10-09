/**
 * Lux listening-history contract.
 * Message names are message2call method paths (one segment each).
 * Legacy LX clients never call them; they only enable list/dislike.
 */
export const PLAY_HISTORY_PUSH = 'playHistory:push' as const
export const PLAY_HISTORY_PULL = 'playHistory:pull' as const

/** Advertised on the existing getEnabledFeatures handshake. Do not bump list/dislike. */
export const PLAY_HISTORY_FEATURE_VERSION = 1

export const PLAY_HISTORY_LIMITS = {
  maxBatch: 500,
  maxPage: 1000,
  id: 160,
  deviceId: 128,
  source: 64,
  songmid: 256,
  name: 512,
  singer: 512,
  albumName: 512,
  interval: 64,
  img: 2048,
} as const
