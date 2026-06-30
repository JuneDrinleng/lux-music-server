import { createHmac, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { LuxUserRole } from './types'

interface TokenPayload {
  sub: string
  username: string
  role: LuxUserRole
  sessionVersion: number
  iat: number
  exp: number
}

const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString('base64url')
const decode = <T>(data: string): T => JSON.parse(Buffer.from(data, 'base64url').toString('utf-8')) as T

const sign = (data: string, secret: string) => createHmac('sha256', secret).update(data).digest('base64url')

export const createToken = ({
  userId,
  username,
  role,
  sessionVersion,
  secret,
  ttlMs = 1000 * 60 * 60 * 24 * 14,
}: {
  userId: string
  username: string
  role: LuxUserRole
  sessionVersion: number
  secret: string
  ttlMs?: number
}) => {
  const now = Date.now()
  const header = encode({ alg: 'HS256', typ: 'JWT' })
  const payload = encode({
    sub: userId,
    username,
    role,
    sessionVersion,
    iat: now,
    exp: now + ttlMs,
  } satisfies TokenPayload)
  const unsigned = `${header}.${payload}`
  return `${unsigned}.${sign(unsigned, secret)}`
}

export const verifyToken = (token: string, secret: string): TokenPayload | null => {
  const parts = token.split('.')
  if (parts.length != 3) return null

  const unsigned = `${parts[0]}.${parts[1]}`
  const expected = Buffer.from(sign(unsigned, secret))
  const actual = Buffer.from(parts[2])
  if (expected.length != actual.length || !timingSafeEqual(expected, actual)) return null

  let payload: TokenPayload
  try {
    payload = decode<TokenPayload>(parts[1])
  } catch {
    return null
  }
  if (!payload.exp || payload.exp < Date.now()) return null
  return payload
}
