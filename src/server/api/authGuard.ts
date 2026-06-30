import type { FastifyReply, FastifyRequest } from 'fastify'
import { getAccountStore } from '@/account/store'
import { verifyToken } from '@/account/token'
import type { LuxManagedUser } from '@/account/types'

export interface AuthRequest extends FastifyRequest {
  authUser?: LuxManagedUser
}

export const getBearerToken = (request: FastifyRequest) => {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ')) return null
  return authorization.substring('Bearer '.length).trim() || null
}

export const getAuthUser = (request: FastifyRequest): LuxManagedUser | null => {
  const token = getBearerToken(request)
  if (!token) return null
  const store = getAccountStore()
  const payload = verifyToken(token, store.getTokenSecret())
  if (!payload) return null
  const user = store.findManagedUserById(payload.sub)
  if (!user || user.status != 'active' || user.sessionVersion != payload.sessionVersion) return null
  return user
}

export const requireAuth = async(request: AuthRequest, reply: FastifyReply) => {
  const user = getAuthUser(request)
  if (!user) {
    await reply.code(401).send({ message: 'Unauthorized' })
    return
  }
  request.authUser = user
}

export const requireAdmin = async(request: AuthRequest, reply: FastifyReply) => {
  const user = getAuthUser(request)
  if (!user) {
    await reply.code(401).send({ message: 'Unauthorized' })
    return
  }
  if (user.role != 'admin') {
    await reply.code(403).send({ message: 'Forbidden' })
    return
  }
  request.authUser = user
}

export const getRequiredAuthUser = (request: AuthRequest) => {
  if (!request.authUser) throw new Error('Unauthorized')
  return request.authUser
}
