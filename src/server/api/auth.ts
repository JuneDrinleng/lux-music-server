import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getAccountStore, InviteValidationError } from '@/account/store'
import { createToken } from '@/account/token'
import { tokenTTL } from '@/account/sessions'
import type { LuxManagedUser } from '@/account/types'
import { canBootstrap } from './bootstrapGuard'
import { clearAuthFailures, getRequestIP, isAuthRateLimited, recordAuthFailure } from './rateLimit'
import { getOptionalString, getString, isRecord } from './utils'
import { requireAuth, type AuthRequest } from './authGuard'
import { sendError } from './errors'

const toPublicUser = (user: ReturnType<ReturnType<typeof getAccountStore>['findManagedUserById']>) => {
  if (!user) return null
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar,
    gender: user.gender,
    signature: user.signature,
    role: user.role,
    source: user.source,
    status: user.status,
  }
}

const accessCredentials = (user: LuxManagedUser, sessionId: string) => {
  const ttlMs = tokenTTL(process.env.LUX_ACCESS_TOKEN_TTL_SECONDS, 3600) * 1000
  const issuedAt = Date.now()
  const accessToken = createToken({
    userId: user.id, username: user.username, role: user.role, sessionVersion: user.sessionVersion,
    secret: getAccountStore().getTokenSecret(), sid: sessionId, ttlMs, issuedAt,
  })
  return { accessToken, accessTokenExpiresAt: issuedAt + ttlMs, sessionId }
}

export const loginCredentials = (user: LuxManagedUser, body: Record<string, unknown>) => {
  const store = getAccountStore()
  const token = createToken({
    userId: user.id,
    username: user.username,
    role: user.role,
    sessionVersion: user.sessionVersion,
    secret: store.getTokenSecret(),
  })
  const { session, refreshToken } = store.sessions.create(user.id, {
    deviceId: getOptionalString(body.deviceId),
    deviceName: getOptionalString(body.deviceName),
    platform: getOptionalString(body.platform),
  })
  return { token, ...accessCredentials(user, session.id), refreshToken, user: toPublicUser(user) }
}

export const registerAuthApi = async(app: FastifyInstance) => {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/invite/check',
    handler: async(request: FastifyRequest, reply) => {
      reply.header('Cache-Control', 'no-store')
      const ip = getRequestIP(request)
      if (isAuthRateLimited(ip)) return sendError(reply, 429, 'RATE_LIMITED', 'Too many failed attempts, try again later')
      const input = request.method == 'GET' ? request.query : request.body
      const code = isRecord(input) ? getString(input.inviteCode) : ''
      if (!code) {
        recordAuthFailure(ip)
        return sendError(reply, 400, 'MISSING_FIELDS', 'Missing required fields')
      }
      try {
        const store = getAccountStore()
        const invite = store.checkInvite(code)
        const inviter = store.findManagedUserById(invite.createdBy)
        return { valid: true, inviterName: inviter?.displayName || inviter?.username || null, role: invite.role, expiresAt: invite.expiresAt ?? null }
      } catch (err) {
        if (!(err instanceof InviteValidationError)) throw err
        recordAuthFailure(ip)
        return sendError(reply, err.code == 'INVITE_NOT_FOUND' ? 404 : 410, err.code, err.message)
      }
    },
  })

  app.post('/api/auth/register', async(request, reply) => {
    if (!isRecord(request.body)) return sendError(reply, 400, 'INVALID_REQUEST', 'Invalid body')
    const inviteCode = getString(request.body.inviteCode)
    const username = getString(request.body.username)
    const password = getString(request.body.password)
    const displayName = getOptionalString(request.body.displayName)
    if (!inviteCode || !username || !password) return sendError(reply, 400, 'MISSING_FIELDS', 'Missing required fields')

    const ip = getRequestIP(request)
    if (isAuthRateLimited(ip, username)) {
      return sendError(reply, 429, 'RATE_LIMITED', 'Too many failed attempts, try again later')
    }

    try {
      const user = await getAccountStore().registerByInvite({ code: inviteCode, username, password, displayName })
      clearAuthFailures(ip, username)
      return loginCredentials(getAccountStore().findManagedUserById(user.id)!, request.body)
    } catch (err: any) {
      recordAuthFailure(ip, username)
      return sendError(reply, 400, err instanceof InviteValidationError ? err.code : 'INVALID_REQUEST', err.message)
    }
  })

  app.post('/api/auth/login', async(request, reply) => {
    if (!isRecord(request.body)) return sendError(reply, 400, 'INVALID_REQUEST', 'Invalid body')
    const username = getString(request.body.username)
    const password = getString(request.body.password)
    if (!username || !password) return sendError(reply, 400, 'MISSING_FIELDS', 'Missing required fields')

    const ip = getRequestIP(request)
    if (isAuthRateLimited(ip, username)) {
      return sendError(reply, 429, 'RATE_LIMITED', 'Too many failed attempts, try again later')
    }

    const store = getAccountStore()
    const user = await store.verifyLogin(username, password)
    if (!user) {
      recordAuthFailure(ip, username)
      return sendError(reply, 401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    }

    clearAuthFailures(ip, username)
    return loginCredentials(user, request.body)
  })

  app.post('/api/auth/refresh', async(request, reply) => {
    const ip = getRequestIP(request)
    if (isAuthRateLimited(ip)) return sendError(reply, 429, 'RATE_LIMITED', 'Too many failed attempts, try again later')
    const refreshToken = isRecord(request.body) ? getString(request.body.refreshToken) : ''
    const store = getAccountStore()
    const rotated = refreshToken ? store.sessions.rotate(refreshToken) : null
    const user = rotated && store.findManagedUserById(rotated.session.userId)
    if (!rotated || !user || user.status != 'active') {
      if (rotated) store.sessions.revoke(rotated.session.id)
      recordAuthFailure(ip)
      return sendError(reply, 401, 'UNAUTHENTICATED', 'Invalid refresh token')
    }
    clearAuthFailures(ip)
    return { ...accessCredentials(user, rotated.session.id), refreshToken: rotated.refreshToken }
  })

  app.get('/api/auth/me', { preHandler: requireAuth }, async(request: AuthRequest) => ({
    user: toPublicUser(request.authUser ?? null),
  }))

  app.post('/api/auth/logout', { preHandler: requireAuth }, async(request: AuthRequest) => {
    const user = request.authUser
    if (!user) return { ok: true }
    if (request.authSessionId) getAccountStore().sessions.revoke(request.authSessionId)
    else getAccountStore().invalidateSessions(user.id)
    return { ok: true }
  })

  app.get('/api/auth/bootstrap', async(request) => {
    const needsAdmin = !getAccountStore().hasManagedAdmin()
    const hasAdmin = !needsAdmin
    return {
      needsAdmin,
      allowed: canBootstrap(hasAdmin, request),
    }
  })

  app.post('/api/auth/bootstrap', async(request, reply) => {
    const store = getAccountStore()
    const hasAdmin = store.hasManagedAdmin()
    if (!canBootstrap(hasAdmin, request)) {
      return sendError(reply, 403, 'FORBIDDEN', hasAdmin
          ? 'Bootstrap token invalid'
          : 'Bootstrap only allowed from localhost or with a valid LUX_BOOTSTRAP_TOKEN')
    }
    if (hasAdmin) return sendError(reply, 409, 'CONFLICT', 'Admin already exists')
    if (!isRecord(request.body)) return sendError(reply, 400, 'INVALID_REQUEST', 'Invalid body')
    const username = getString(request.body.username)
    const password = getString(request.body.password)
    const displayName = getOptionalString(request.body.displayName)
    if (!username || !password) return sendError(reply, 400, 'MISSING_FIELDS', 'Missing required fields')
    try {
      const user = await store.createUser({ username, password, displayName, role: 'admin' })
      return { user }
    } catch (err: any) {
      return sendError(reply, 400, 'INVALID_REQUEST', err.message)
    }
  })
}
