import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getAccountStore } from '@/account/store'
import { PAT_SCOPES, type PatScope, type PatExpiry } from '@/account/pats'
import { getBearerToken, getRequiredAuthUser, requireAuth, type AuthRequest } from './authGuard'
import { isRecord } from './utils'
import { sendError } from './errors'
import { recordTokenActivity } from '@/account/tokenActivity'
import { pageLimit, registerDataApi } from './data'

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

export const registerPatHooks = (app: FastifyInstance) => {
  const windows = new Map<string, { at: number, count: number }>()
  const contexts = new WeakMap<FastifyRequest, string>()
  app.addHook('onRequest', async(request, reply) => {
    if (!request.url.startsWith('/api/v1/')) return
    reply.header('Cache-Control', 'no-store')
    const { token } = authenticatePat(request)
    contexts.set(request, token.id)
    const now = Date.now()
    for (const [id, window] of windows) if (now - window.at >= 60000) windows.delete(id)
    const window = windows.get(token.id) ?? { at: now, count: 0 }
    windows.set(token.id, window)
    if (++window.count > 60) return sendError(reply, 429, 'RATE_LIMITED', 'Too many requests')
  })
  app.addHook('onResponse', async(request, reply) => {
    const id = contexts.get(request)
    const url = request.url.split('?')[0]
    if (!id || url == '/api/v1/token/activity') return
    const action = url.endsWith('/history') ? 'history.read' : url.endsWith('/top-tracks') ? 'stats.topTracks'
      : url.endsWith('/whoami') ? 'token.whoami' : url.endsWith('/songs') ? (request.method == 'DELETE' ? 'playlist.removeSongs' : 'playlist.addSongs')
        : url == '/api/v1/playlists' ? (request.method == 'POST' ? 'playlist.create' : 'playlist.list') : url.startsWith('/api/v1/playlists/') ? 'playlist.read' : 'api.request'
    recordTokenActivity(id, action, `${request.method} ${reply.statusCode}`, reply.statusCode < 400)
  })
}

export const registerPatApi = async(app: FastifyInstance) => {
  await registerDataApi(app)
  app.get('/api/v1/token/activity', async request => {
    const { token, user } = authenticatePat(request)
    return { items: getAccountStore().pats.activity(token.id, user.id, pageLimit((request.query as { limit?: string }).limit, 50, 200)) }
  })
  app.get('/api/me/tokens/:id/activity', { preHandler: requireAuth }, async(request: AuthRequest, reply) => {
    const items = getAccountStore().pats.activity((request.params as { id: string }).id, getRequiredAuthUser(request).id,
      pageLimit((request.query as { limit?: string }).limit, 50, 200))
    reply.header('Cache-Control', 'no-store')
    return items ? { items } : sendError(reply, 404, 'TOKEN_NOT_FOUND', 'Token not found')
  })
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
