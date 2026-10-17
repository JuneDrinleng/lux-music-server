/**
 * Lux listen-together contract (docs: listen-together-protocol.md §4).
 * Message names are single-segment message2call paths. Legacy LX clients never call them.
 */
import { syncLog } from '@/utils/log4js'

export const TOGETHER_FEATURE_VERSION = 1
export const TOGETHER_REACTION_FEATURE_VERSION = 1
export const TOGETHER_REQUEST_FEATURE_VERSION = 1

/** Only these exact emoji sequences are supported (after trimming spaces). */
export const TOGETHER_REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👏'] as const

export const TOGETHER_METHODS = {
  createRoom: 'together:createRoom',
  joinRoom: 'together:joinRoom',
  getRoom: 'together:getRoom',
  leaveRoom: 'together:leaveRoom',
  closeRoom: 'together:closeRoom',
  hostUpdateState: 'together:hostUpdateState',
  hostUpdateQueue: 'together:hostUpdateQueue',
  transferHost: 'together:transferHost',
  reaction: 'together:reaction',
  requestAdd: 'together:request:add',
  requestApprove: 'together:request:approve',
  requestReject: 'together:request:reject',
  requestRemove: 'together:request:remove',
  requestReorder: 'together:request:reorder',
  ping: 'together:ping',
} as const

export const TOGETHER_PUSHES = {
  roomState: 'together:onRoomState',
  memberChanged: 'together:onMemberChanged',
  hostChanged: 'together:onHostChanged',
  roomClosed: 'together:onRoomClosed',
  reaction: 'together:onReaction',
  requests: 'together:onRequests',
} as const

export const TOGETHER_LIMITS = {
  queueItems: 200,
  requestsPerMember: 3,
  requestsPerRoom: 30,
  /** hostUpdateState.sampledAt is clamped into [now - this, now]. */
  sampledAtSkewMs: 5000,
  joinFailures: 10,
  joinFailureWindowMs: 60_000,
  reactions: 5,
  reactionWindowMs: 3000,
  reactionsPerMinute: 60,
  reactionMinuteMs: 60_000,
  hostUpdates: 10,
  hostUpdateWindowMs: 1000,
} as const

export const INVITE_CODE_REGEXP = /^[1-9]\d{5}$/

export interface TogetherConfig {
  maxMembers: number
  maxRooms: number
  graceMs: number
}

export const TOGETHER_DEFAULTS: TogetherConfig = {
  maxMembers: 10,
  maxRooms: 100,
  graceMs: 30_000,
}

const readInt = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) => {
  const raw = env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    syncLog.warn(`${name}=${raw} is invalid (expected an integer in ${min}-${max}), using ${fallback}`)
    return fallback
  }
  return value
}

/** Read only from process.env, like LUX_TOKEN_SECRET; config.js does not apply. */
export const readTogetherConfig = (env: NodeJS.ProcessEnv = process.env): TogetherConfig => ({
  maxMembers: readInt(env, 'LUX_TOGETHER_MAX_MEMBERS', TOGETHER_DEFAULTS.maxMembers, 2, 50),
  maxRooms: readInt(env, 'LUX_TOGETHER_MAX_ROOMS', TOGETHER_DEFAULTS.maxRooms, 1, Number.MAX_SAFE_INTEGER),
  graceMs: readInt(env, 'LUX_TOGETHER_GRACE_MS', TOGETHER_DEFAULTS.graceMs, 5000, 300_000),
})
