import { createHash, randomBytes } from 'node:crypto'
import { atomicWriteFileSync } from '@/utils/atomicWrite'
import { loadStoreFile } from './storeFile'

export const PAT_SCOPES = ['playlist:read', 'playlist:write', 'history:read', 'player:control', 'together:request'] as const
export type PatScope = typeof PAT_SCOPES[number]
export type PatExpiry = '30d' | '1y' | 'never'
interface Pat {
  id: string
  userId: string
  name: string
  scopes: PatScope[]
  createdAt: number
  expiresAt: number | null
  lastUsedAt: number | null
  revokedAt: number | null
  hash: string
  last4: string
}
export const patMetadata = ({ id, name, scopes, createdAt, expiresAt, lastUsedAt, revokedAt, last4 }: Pat) =>
  ({ id, name, scopes: [...scopes], createdAt, expiresAt, lastUsedAt, revokedAt, last4 })
const digest = (token: string) => createHash('sha256').update(token).digest('hex')
const validStore = (data: unknown): data is { version: 1, tokens: Pat[] } => {
  if (!data || typeof data != 'object') return false
  const store = data as { version?: unknown, tokens?: unknown }
  return store.version === 1 && Array.isArray(store.tokens) && store.tokens.every(t =>
    t && typeof t == 'object' && ['id', 'userId', 'name', 'hash', 'last4'].every(k => typeof t[k] == 'string') &&
    t.name.length >= 1 && t.name.length <= 40 && /^[a-f0-9]{64}$/.test(t.hash) && t.last4.length == 4 &&
    Number.isFinite(t.createdAt) && ['expiresAt', 'lastUsedAt', 'revokedAt'].every(k => t[k] === null || Number.isFinite(t[k])) &&
    Array.isArray(t.scopes) && t.scopes.length > 0 && t.scopes.every((s: PatScope) => PAT_SCOPES.includes(s)))
}

export class PatStore {
  private data: { version: 1, tokens: Pat[] }
  constructor(private readonly filePath: string, private readonly clock = Date.now) {
    this.data = loadStoreFile(filePath, 'Tokens', validStore, () => ({ version: 1, tokens: [] }))
  }
  // Publish in-memory changes only after persistence succeeds.
  private save(tokens: Pat[]) {
    atomicWriteFileSync(this.filePath, JSON.stringify({ version: 1, tokens }, null, 2))
    this.data.tokens = tokens
  }
  listForUser(userId: string) {
    return this.data.tokens.filter(t => t.userId == userId).map(patMetadata)
  }
  create(userId: string, name: string, scopes: PatScope[], expiry: PatExpiry) {
    if (!name.trim() || name.trim().length > 40 || !scopes.length || scopes.some(s => !PAT_SCOPES.includes(s)) ||
      !['30d', '1y', 'never'].includes(expiry)) throw new Error('Invalid token settings')
    const time = this.clock()
    const token = `lux_mcp_${randomBytes(32).toString('base64url')}`
    const pat: Pat = {
      id: randomBytes(12).toString('base64url'), userId, name: name.trim(), scopes: [...new Set(scopes)],
      createdAt: time, expiresAt: expiry == 'never' ? null : time + (expiry == '30d' ? 30 : 365) * 86400000,
      lastUsedAt: null, revokedAt: null, hash: digest(token), last4: token.slice(-4),
    }
    this.save([...this.data.tokens, pat])
    return { token, ...patMetadata(pat) }
  }
  revoke(id: string, userId: string) {
    const pat = this.data.tokens.find(t => t.id == id && t.userId == userId)
    if (!pat) return false
    if (pat.revokedAt === null) this.save(this.data.tokens.map(t => t == pat ? { ...t, revokedAt: this.clock() } : t))
    return true
  }
  lookup(token: string) {
    if (!/^lux_mcp_[A-Za-z0-9_-]{43,}$/.test(token)) return null
    const hash = digest(token)
    const pat = this.data.tokens.find(t => t.hash == hash)
    return pat && pat.revokedAt === null && (pat.expiresAt === null || pat.expiresAt > this.clock())
      ? { ...patMetadata(pat), userId: pat.userId } : null
  }
  touch(id: string) {
    const time = this.clock()
    if (!this.data.tokens.some(t => t.id == id && (t.lastUsedAt === null || time - t.lastUsedAt >= 60000))) return
    this.save(this.data.tokens.map(t => t.id == id ? { ...t, lastUsedAt: time } : t))
  }
}
