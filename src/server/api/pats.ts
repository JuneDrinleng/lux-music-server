import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getAccountStore } from '@/account/store'
import { PAT_SCOPES, type PatScope, type PatExpiry } from '@/account/pats'
import { getBearerToken, getRequiredAuthUser, requireAuth, type AuthRequest } from './authGuard'
import { isRecord } from './utils'
import { sendError } from './errors'

export const authenticatePat = (request: FastifyRequest, requiredScopes: readonly PatScope[] = []) => {
  const store = getAccountStore()
  const pat = store.pats.lookup(getBearerToken(request) || '')
  const user = pat && store.findManagedUserById(pat.userId)
  if (!pat || !user || user.status != 'active') {
    throw Object.assign(new Error('Unauthorized'), { statusCode: 401, code: 'UNAUTHENTICATED' })
  }
  if (requiredScopes.some(scope => !pat.scopes.includes(scope))) {
    throw Object.assign(new Error('Missing required scope'), { statusCode: 403, code: 'FORBIDDEN' })
  }
  store.pats.touch(pat.id)
  return { token: pat, user }
}

export const registerPatApi = async(app: FastifyInstance) => {
  app.get('/api/me/tokens', { preHandler: requireAuth }, async(request: AuthRequest, reply) => {
    reply.header('Cache-Control', 'no-store')
    return { tokens: getAccountStore().pats.listForUser(getRequiredAuthUser(request).id) }
  })
  app.post('/api/me/tokens', { preHandler: requireAuth }, async(request: AuthRequest, reply) => {
    const body = request.body
    if (!isRecord(body) || typeof body.name != 'string' || !body.name.trim() || body.name.trim().length > 40 ||
      !Array.isArray(body.scopes) || !body.scopes.length || body.scopes.some(s => !PAT_SCOPES.includes(s)) ||
      !['30d', '1y', 'never'].includes(body.expiry as string)) {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Invalid token settings')
    }
    reply.header('Cache-Control', 'no-store').code(201)
    return getAccountStore().pats.create(getRequiredAuthUser(request).id, body.name, body.scopes, body.expiry as PatExpiry)
  })
  app.delete('/api/me/tokens/:id', { preHandler: requireAuth }, async(request: AuthRequest, reply) => {
    const { id } = request.params as { id: string }
    if (!getAccountStore().pats.revoke(id, getRequiredAuthUser(request).id)) {
      return sendError(reply, 404, 'TOKEN_NOT_FOUND', 'Token not found')
    }
    return { ok: true }
  })
  app.get('/api/v1/token/whoami', async(request, reply) => {
    const { token, user } = authenticatePat(request)
    reply.header('Cache-Control', 'no-store')
    return { name: token.name, scopes: token.scopes, username: user.username }
  })
}
