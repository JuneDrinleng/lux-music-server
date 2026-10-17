import { createHash, randomBytes } from 'node:crypto'
import { atomicWriteFileSync } from '@/utils/atomicWrite'
import { loadStoreFile } from './storeFile'
import type { LuxSession } from './types'

const day = 24 * 60 * 60 * 1000
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const random = () => randomBytes(32).toString('base64url')
export const tokenTTL = (value: string | undefined, fallback: number) => {
  const ttl = Number(value)
  return Number.isFinite(ttl) && ttl > 0 ? ttl : fallback
}
const isStore = (data: unknown): data is { version: 1, sessions: LuxSession[] } => {
  if (!data || typeof data != 'object') return false
  const store = data as { version?: unknown, sessions?: unknown }
  return store.version === 1 && Array.isArray(store.sessions) && store.sessions.every(s =>
    s && typeof s == 'object' && ['id', 'userId', 'refreshTokenHash'].every(k => typeof s[k] == 'string') &&
    ['createdAt', 'lastActiveAt', 'generation', 'expiresAt'].every(k => Number.isFinite(s[k])) &&
    (s.revokedAt === undefined || Number.isFinite(s.revokedAt)) &&
    ['deviceId', 'deviceName', 'platform'].every(k => s[k] === undefined || typeof s[k] == 'string') &&
    Array.isArray(s.previousRefreshTokenHashes) && s.previousRefreshTokenHashes.every((h: unknown) => typeof h == 'string'))
}

export class SessionStore {
  private data: { version: 1, sessions: LuxSession[] }
  private revocationListener?: (sessions: LuxSession[]) => void

  onSessionsRevoked(listener: (sessions: LuxSession[]) => void) {
    this.revocationListener = listener
  }

  private revokeMatching(matches: (session: LuxSession) => boolean) {
    const sessions = this.data.sessions.filter(matches)
    for (const session of sessions) session.revokedAt ??= this.clock()
    this.save()
    this.revocationListener?.(sessions)
    return sessions.length
  }

  constructor(private readonly filePath: string, private readonly clock = Date.now) {
    this.data = loadStoreFile(filePath, 'Sessions', isStore, () => ({ version: 1, sessions: [] }))
  }

  private save() {
    const cutoff = this.clock() - 30 * day
    this.data.sessions = this.data.sessions.filter(s => (s.revokedAt ?? s.expiresAt) >= cutoff)
    atomicWriteFileSync(this.filePath, JSON.stringify(this.data, null, 2))
  }

  private expiresAt(time = this.clock()) {
    return time + tokenTTL(process.env.LUX_REFRESH_TOKEN_TTL_DAYS, 90) * day
  }

  create(userId: string, device: Pick<LuxSession, 'deviceId' | 'deviceName' | 'platform'> = {}) {
    const time = this.clock()
    if (device.deviceId) {
      this.revokeMatching(s => s.userId == userId && s.deviceId == device.deviceId)
    }
    const refreshToken = random()
    const session: LuxSession = {
      id: random(), userId, ...device, createdAt: time, lastActiveAt: time,
      refreshTokenHash: hash(refreshToken), generation: 0, previousRefreshTokenHashes: [], expiresAt: this.expiresAt(time),
    }
    this.data.sessions.push(session)
    this.save()
    return { session, refreshToken }
  }

  isActive(id: string, userId: string) {
    return this.data.sessions.some(s => s.id == id && s.userId == userId && s.revokedAt === undefined && s.expiresAt > this.clock())
  }

  listForUser(userId: string) {
    return this.data.sessions
      .filter(s => s.userId == userId && s.revokedAt === undefined && s.expiresAt > this.clock())
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  rotate(refreshToken: string) {
    const digest = hash(refreshToken)
    const session = this.data.sessions.find(s => s.refreshTokenHash == digest || s.previousRefreshTokenHashes.includes(digest))
    if (!session || !this.isActive(session.id, session.userId)) return null
    if (session.refreshTokenHash != digest) {
      this.revoke(session.id)
      return null
    }
    const nextToken = random()
    // Bounded history is enough to detect replay of recently rotated tokens.
    session.previousRefreshTokenHashes = [...session.previousRefreshTokenHashes, session.refreshTokenHash].slice(-50)
    session.refreshTokenHash = hash(nextToken)
    session.generation += 1
    session.lastActiveAt = this.clock()
    session.expiresAt = this.expiresAt()
    this.save()
    return { session, refreshToken: nextToken }
  }

  revoke(id: string, userId?: string) {
    return this.revokeMatching(s => s.id == id && (userId === undefined || s.userId == userId))
  }

  revokeOthers(userId: string, keepId?: string) {
    return this.revokeMatching(s => s.userId == userId && s.id != keepId && s.revokedAt === undefined)
  }

  revokeUser(userId: string) {
    this.revokeMatching(s => s.userId == userId)
  }
}
