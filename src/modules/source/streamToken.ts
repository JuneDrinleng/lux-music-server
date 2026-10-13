import crypto from 'node:crypto'
import { getAccountStore } from '@/account/store'
import { SOURCE_CACHE } from './protocol'
import type { SourceCacheKind } from './cache'

const b64url = (buf: Buffer) => buf.toString('base64url')

export const createStreamToken = (upstreamUrl: string, kind: SourceCacheKind = 'url') => {
  const ttl = kind == 'url' ? SOURCE_CACHE.urlTtlMs : kind == 'lyric' ? SOURCE_CACHE.lyricTtlMs : SOURCE_CACHE.picTtlMs
  const payload = JSON.stringify({ u: upstreamUrl, e: Date.now() + ttl })
  const payloadB64 = b64url(Buffer.from(payload, 'utf8'))
  const sig = b64url(crypto.createHmac('sha256', getAccountStore().getTokenSecret()).update(payloadB64).digest())
  return `/api/source/stream/${payloadB64}.${sig}`
}

export const verifyStreamToken = (token: string): { url: string, expiresAt: number } | null => {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const payloadB64 = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = b64url(crypto.createHmac('sha256', getAccountStore().getTokenSecret()).update(payloadB64).digest())
  if (sig.length != expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as { u?: string, e?: number }
    if (typeof parsed.u != 'string' || typeof parsed.e != 'number') return null
    if (parsed.e <= Date.now()) return null
    if (!/^https?:/.test(parsed.u)) return null
    return { url: parsed.u, expiresAt: parsed.e }
  } catch {
    return null
  }
}
