import type { FastifyInstance, FastifyReply } from 'fastify'
import { getAccountStore } from '@/account/store'
import { verifyPassword } from '@/account/password'
import { getUserSpace } from '@/user'
import { removeDevice } from '../server'
import { getRequiredAuthUser, requireAuth, type AuthRequest } from './authGuard'
import { getString, isRecord, toPublicDevice } from './utils'
import { clearAuthFailures, getRequestIP, isAuthRateLimited, recordAuthFailure } from './rateLimit'
import { sendError } from './errors'
import { loginCredentials } from './auth'

const toProfile = (user: ReturnType<ReturnType<typeof getAccountStore>['findManagedUserById']>) => ({
  username: user?.username ?? '',
  displayName: user?.displayName ?? '',
  avatar: user?.avatar ?? '',
  gender: user?.gender ?? 'unknown',
  signature: user?.signature ?? '',
})
const updateProfile = async(request: AuthRequest, reply: FastifyReply) => {
  if (!isRecord(request.body)) return sendError(reply, 400, 'INVALID_REQUEST', 'Invalid body')
  const body = request.body
  if (Object.prototype.hasOwnProperty.call(body, 'username')) return sendError(reply, 400, 'USERNAME_READONLY', 'Username is read-only; edit displayName instead')
  const profile: Parameters<ReturnType<typeof getAccountStore>['updateUser']>[1] = {}
  for (const [field, limit, code] of [
    ['displayName', 100, 'INVALID_DISPLAY_NAME'],
    ['avatar', 200 * 1024, 'INVALID_AVATAR'],
    ['signature', 140, 'INVALID_SIGNATURE'],
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue
    const value = body[field]
    if (typeof value !== 'string') return sendError(reply, 400, code, `${field} must be a string`)
    const text = value.trim()
    if (text.length > limit) {
      if (field == 'avatar') return sendError(reply, 413, 'AVATAR_TOO_LARGE', 'Avatar must not exceed 200KB')
      return sendError(reply, 400, code, `${field} must not exceed ${limit} characters`)
    }
    profile[field] = text
  }
  if (Object.prototype.hasOwnProperty.call(body, 'gender')) {
    if (typeof body.gender !== 'string') return sendError(reply, 400, 'INVALID_GENDER', 'Gender must be male, female or unknown')
    const gender = body.gender.trim() || 'unknown'
    if (gender != 'male' && gender != 'female' && gender != 'unknown') {
      return sendError(reply, 400, 'INVALID_GENDER', 'Gender must be male, female or unknown')
    }
    profile.gender = gender
  }
  const user = getRequiredAuthUser(request)
  const previousUser = { ...user }
  try {
    const updatedUser = getAccountStore().updateUser(user.id, profile)
    return { profile: toProfile(getAccountStore().findManagedUserById(updatedUser.id)) }
  } catch {
    // updateUser mutates the managed user before writing; restore it if saving fails.
    for (const key of Object.keys(user) as Array<keyof typeof user>) delete user[key]
    Object.assign(user, previousUser)
    return sendError(reply, 500, 'PROFILE_SAVE_FAILED', 'Failed to save profile')
  }
}

const buildPlaylistSummary = async(username: string) => {
  const listData = await getUserSpace(username).listManage.getListData()
  return {
    defaultList: {
      id: 'default',
      name: '默认列表',
      musicCount: listData.defaultList.length,
    },
    loveList: {
      id: 'love',
      name: '我喜欢',
      musicCount: listData.loveList.length,
    },
    userList: listData.userList.map(list => ({
      id: list.id,
      name: list.name,
      source: list.source,
      sourceListId: list.sourceListId,
      locationUpdateTime: list.locationUpdateTime,
      musicCount: list.list.length,
    })),
  }
}

export const registerMeApi = async(app: FastifyInstance) => {
  app.get('/api/me/profile', { preHandler: requireAuth }, async(request: AuthRequest) => {
    const user = getRequiredAuthUser(request)
    return { profile: toProfile(user) }
  })

  app.post('/api/me/profile', { preHandler: requireAuth }, updateProfile)
  app.patch('/api/me/profile', { preHandler: requireAuth }, updateProfile)

  app.get('/api/me/sessions', { preHandler: requireAuth }, async(request: AuthRequest) => {
    const user = getRequiredAuthUser(request)
    const sessions = getAccountStore().sessions.listForUser(user.id).map(session => ({
      id: session.id,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      platform: session.platform,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      current: session.id == request.authSessionId,
    }))
    return { sessions }
  })

  app.delete('/api/me/sessions/:id', { preHandler: requireAuth }, async(request: AuthRequest, reply) => {
    const user = getRequiredAuthUser(request)
    const { id } = request.params as { id: string }
    if (!getAccountStore().sessions.revoke(id, user.id)) return sendError(reply, 404, 'SESSION_NOT_FOUND', 'Session not found')
    return { ok: true }
  })

  app.post('/api/me/sessions/revoke-others', { preHandler: requireAuth }, async(request: AuthRequest) => {
    const user = getRequiredAuthUser(request)
    // Legacy tokens have no sid, so there is no current session to keep: revoke all sessions.
    const revoked = getAccountStore().sessions.revokeOthers(user.id, request.authSessionId)
    return { ok: true, revoked }
  })

  app.get('/api/me/devices', { preHandler: requireAuth }, async(request: AuthRequest) => {
    const user = getRequiredAuthUser(request)
    return { devices: (await getUserSpace(user.username).getDecices()).map(toPublicDevice) }
  })

  app.delete('/api/me/devices/:clientId', { preHandler: requireAuth }, async(request: AuthRequest) => {
    const user = getRequiredAuthUser(request)
    const clientId = (request.params as { clientId?: string }).clientId
    if (!clientId) return { ok: false }
    await removeDevice(user.username, clientId)
    return { ok: true }
  })

  app.get('/api/me/playlists', { preHandler: requireAuth }, async(request: AuthRequest) => {
    const user = getRequiredAuthUser(request)
    return { playlists: await buildPlaylistSummary(user.username) }
  })

  app.post('/api/me/password', { preHandler: requireAuth }, async(request: AuthRequest, reply) => {
    if (!isRecord(request.body)) return sendError(reply, 400, 'INVALID_REQUEST', 'Invalid body')
    const oldPassword = getString(request.body.oldPassword)
    const password = getString(request.body.password)
    if (!oldPassword || !password) return sendError(reply, 400, 'MISSING_FIELDS', 'Missing required fields')
    if (request.body.revokeOtherDevices !== undefined && typeof request.body.revokeOtherDevices != 'boolean') {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Invalid revokeOtherDevices')
    }
    const user = getRequiredAuthUser(request)
    const ip = getRequestIP(request)
    if (isAuthRateLimited(ip, user.username)) {
      return sendError(reply, 429, 'RATE_LIMITED', 'Too many failed attempts, try again later')
    }
    if (!await verifyPassword(oldPassword, user.loginPasswordHash)) {
      recordAuthFailure(ip, user.username)
      return sendError(reply, 403, 'INVALID_CURRENT_PASSWORD', 'Invalid current password')
    }

    const revokeOtherDevices = request.body.revokeOtherDevices !== false
    if (!revokeOtherDevices && !request.authSessionId) {
      return sendError(reply, 400, 'SESSION_REQUIRED', 'sign in again to keep other devices signed in')
    }
    const store = getAccountStore()
    const currentSession = store.sessions.listForUser(user.id).find(session => session.id == request.authSessionId)
    await store.changePassword(user.id, password, { revokeSessions: revokeOtherDevices })
    if (request.authSessionId) store.sessions.revoke(request.authSessionId, user.id)
    clearAuthFailures(ip, user.username)
    return { ok: true, ...loginCredentials(user, {
      deviceId: currentSession?.deviceId,
      deviceName: currentSession?.deviceName,
      platform: currentSession?.platform,
    }) }
  })

  app.get('/api/me/sync-code', { preHandler: requireAuth }, async(request: AuthRequest, reply) => {
    const user = getRequiredAuthUser(request)
    const syncCode = getAccountStore().getSyncCode(user.id)
    reply.header('Cache-Control', 'no-store')
    return { syncCode }
  })

  app.post('/api/me/sync-code/reset', { preHandler: requireAuth }, async(request: AuthRequest) => {
    const user = getRequiredAuthUser(request)
    const syncCode = getAccountStore().resetSyncCode(user.id)
    return { syncCode }
  })
}
