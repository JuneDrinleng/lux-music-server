import type { FastifyInstance } from 'fastify'
import { getAccountStore } from '@/account/store'
import { createToken } from '@/account/token'
import { canBootstrap } from './bootstrapGuard'
import { clearAuthFailures, getRequestIP, isAuthRateLimited, recordAuthFailure } from './rateLimit'
import { getOptionalString, getString, isRecord } from './utils'
import { requireAuth, type AuthRequest } from './authGuard'

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

export const registerAuthApi = async(app: FastifyInstance) => {
  app.post('/api/auth/register', async(request, reply) => {
    if (!isRecord(request.body)) return reply.code(400).send({ message: 'Invalid body' })
    const inviteCode = getString(request.body.inviteCode)
    const username = getString(request.body.username)
    const password = getString(request.body.password)
    const displayName = getOptionalString(request.body.displayName)
    if (!inviteCode || !username || !password) return reply.code(400).send({ message: 'Missing required fields' })

    const ip = getRequestIP(request)
    if (isAuthRateLimited(ip, username)) {
      return reply.code(403).send({ message: 'Too many failed attempts, try again later' })
    }

    try {
      const user = await getAccountStore().registerByInvite({ code: inviteCode, username, password, displayName })
      clearAuthFailures(ip, username)
      return { user }
    } catch (err: any) {
      recordAuthFailure(ip, username)
      return reply.code(400).send({ message: err.message })
    }
  })

  app.post('/api/auth/login', async(request, reply) => {
    if (!isRecord(request.body)) return reply.code(400).send({ message: 'Invalid body' })
    const username = getString(request.body.username)
    const password = getString(request.body.password)
    if (!username || !password) return reply.code(400).send({ message: 'Missing required fields' })

    const ip = getRequestIP(request)
    if (isAuthRateLimited(ip, username)) {
      return reply.code(403).send({ message: 'Too many failed attempts, try again later' })
    }

    const store = getAccountStore()
    const user = await store.verifyLogin(username, password)
    if (!user) {
      recordAuthFailure(ip, username)
      return reply.code(401).send({ message: 'Invalid username or password' })
    }

    clearAuthFailures(ip, username)
    const token = createToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      sessionVersion: user.sessionVersion,
      secret: store.getTokenSecret(),
    })
    return { token, user: toPublicUser(user) }
  })

  app.get('/api/auth/me', { preHandler: requireAuth }, async(request: AuthRequest) => ({
    user: toPublicUser(request.authUser ?? null),
  }))

  app.post('/api/auth/logout', { preHandler: requireAuth }, async(request: AuthRequest) => {
    const user = request.authUser
    if (!user) return { ok: true }
    getAccountStore().invalidateSessions(user.id)
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
      return reply.code(403).send({
        message: hasAdmin
          ? 'Bootstrap token invalid'
          : 'Bootstrap only allowed from localhost or with a valid LUX_BOOTSTRAP_TOKEN',
      })
    }
    if (hasAdmin) return reply.code(409).send({ message: 'Admin already exists' })
    if (!isRecord(request.body)) return reply.code(400).send({ message: 'Invalid body' })
    const username = getString(request.body.username)
    const password = getString(request.body.password)
    const displayName = getOptionalString(request.body.displayName)
    if (!username || !password) return reply.code(400).send({ message: 'Missing required fields' })
    try {
      const user = await store.createUser({ username, password, displayName, role: 'admin' })
      return { user }
    } catch (err: any) {
      return reply.code(400).send({ message: err.message })
    }
  })
}
