import type { FastifyRequest } from 'fastify'
import { getRequestIP } from './rateLimit'

const LOOPBACK_IPS = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
])

export const isLoopbackAddress = (ip: string) => {
  if (!ip) return false
  const normalized = ip.trim().toLowerCase()
  if (LOOPBACK_IPS.has(normalized)) return true
  // IPv6 zone id / brackets
  if (normalized == '[::1]' || normalized.startsWith('::1%')) return true
  return false
}

export const getBootstrapToken = () => process.env.LUX_BOOTSTRAP_TOKEN?.trim() || ''

export const hasValidBootstrapToken = (request: { headers: Record<string, unknown> | FastifyRequest['headers'] }) => {
  const expected = getBootstrapToken()
  if (!expected) return false
  const header = request.headers['x-lux-bootstrap-token']
  return typeof header == 'string' && header == expected
}

/**
 * When no admin exists:
 * - loopback (127.0.0.1 / ::1) is always allowed
 * - remote requests require LUX_BOOTSTRAP_TOKEN matching x-lux-bootstrap-token
 * When an admin already exists, only a valid bootstrap token is accepted
 * (POST still returns 409; used for the GET `allowed` probe / maintenance gates).
 */
export const canBootstrap = (hasAdmin: boolean, request: FastifyRequest) => {
  if (hasValidBootstrapToken(request)) return true
  if (hasAdmin) return false
  return isLoopbackAddress(getRequestIP(request))
}
