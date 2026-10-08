import type { FastifyRequest } from 'fastify'
import store from '@/utils/cache'
import { getIP } from '@/utils/tools'

/** Mirror /ah: block after 10 failures per key (IP or account). */
export const AUTH_FAIL_LIMIT = 10

const ipKey = (ip: string) => `lux-auth:ip:${ip}`
const userKey = (username: string) => `lux-auth:user:${username.toLowerCase()}`

export const getRequestIP = (request: FastifyRequest) => {
  const fromProxyOrSocket = getIP(request.raw)
  if (fromProxyOrSocket) return fromProxyOrSocket
  return request.ip || request.socket.remoteAddress || ''
}

const isOverLimit = (key: string) => (store.get<number>(key) ?? 0) >= AUTH_FAIL_LIMIT

export const isAuthRateLimited = (ip: string, username?: string) => {
  if (!ip || isOverLimit(ipKey(ip))) return true
  if (username && isOverLimit(userKey(username))) return true
  return false
}

export const recordAuthFailure = (ip: string, username?: string) => {
  if (ip) {
    const key = ipKey(ip)
    store.set(key, (store.get<number>(key) ?? 0) + 1)
  }
  if (username) {
    const key = userKey(username)
    store.set(key, (store.get<number>(key) ?? 0) + 1)
  }
}

export const clearAuthFailures = (ip: string, username?: string) => {
  if (ip) store.delete(ipKey(ip))
  if (username) store.delete(userKey(username))
}

/** Test helper: clear all lux-auth rate-limit counters. */
export const resetAuthRateLimitForTests = () => {
  for (const key of store.store.keys()) {
    if (typeof key == 'string' && key.startsWith('lux-auth:')) store.delete(key)
  }
}
