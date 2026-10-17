import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { checkAndCreateDirSync } from '@/utils'
import { filterFileName, toMD5 } from '@/utils'
import { atomicWriteFileSync } from '@/utils/atomicWrite'
import { loadStoreFile } from './storeFile'
import { SessionStore } from './sessions'
import { PatStore } from './pats'
import { createSecret, hashPassword, hashPasswordSync, verifyPassword } from './password'
import type { InviteCode, LuxAccountStoreData, LuxManagedUser, LuxUserRole, LuxUserView, PublicUserInfo } from './types'

const now = () => Date.now()
const createId = () => randomBytes(12).toString('base64url')
const createSyncCode = () => randomBytes(18).toString('base64url')
const getUserDirname = (userName: string) => `${filterFileName(userName)}_${toMD5(userName).substring(0, 6)}`
export const hashInviteCode = (code: string) => createHash('sha256').update(code).digest('hex')

export class InviteValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const createEmptyStore = (): LuxAccountStoreData => ({
  version: 1,
  tokenSecret: process.env.LUX_TOKEN_SECRET || createSecret(),
  users: [],
  invites: [],
  suppressedConfigUsernames: [],
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value == 'object' && !Array.isArray(value)
// Reject only structurally broken data; older valid files may lack newer optional fields.
const isValidStore = (data: unknown): data is LuxAccountStoreData =>
  isRecord(data) && data.version === 1 &&
  (data.tokenSecret === undefined || typeof data.tokenSecret == 'string') &&
  (data.users === undefined || (Array.isArray(data.users) && data.users.every(user =>
    isRecord(user) && typeof user.id == 'string' && typeof user.username == 'string'))) &&
  (data.invites === undefined || (Array.isArray(data.invites) && data.invites.every(invite =>
    isRecord(invite) && typeof invite.id == 'string'))) &&
  (data.suppressedConfigUsernames === undefined || (Array.isArray(data.suppressedConfigUsernames) &&
    data.suppressedConfigUsernames.every(name => typeof name == 'string')))

const sanitizeUser = (user: LuxManagedUser): PublicUserInfo => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  avatar: user.avatar,
  gender: user.gender,
  signature: user.signature,
  role: user.role,
  source: user.source,
  status: user.status,
})

export class AccountStore {
  private readonly filePath: string
  private data: LuxAccountStoreData
  readonly sessions: SessionStore
  readonly pats: PatStore
  private syncKeyRevocationListener?: (username: string, scope: 'all' | 'sessionless') => void

  onSyncKeysRevoked(listener: (username: string, scope: 'all' | 'sessionless') => void) {
    this.syncKeyRevocationListener = listener
  }
  /** config.js / LX_USER_* users captured at process startup (before managed projection). */
  private baselineConfigUsers: LX.UserConfig[] = []

  constructor(dataPath: string) {
    const dir = path.join(dataPath, 'lux')
    checkAndCreateDirSync(dir)
    this.filePath = path.join(dir, 'accounts.json')
    this.data = this.load()
    this.sessions = new SessionStore(path.join(dir, 'sessions.json'))
    this.pats = new PatStore(path.join(dir, 'tokens.json'))
    this.ensureEnvAdmin()
    this.saveSync()
  }

  private load() {
    const data = loadStoreFile(this.filePath, 'Accounts', isValidStore, createEmptyStore)
    if (!data.tokenSecret) data.tokenSecret = process.env.LUX_TOKEN_SECRET || createSecret()
    data.users ??= []
    data.invites ??= []
    data.suppressedConfigUsernames ??= []
    return data
  }

  setBaselineConfigUsers(users: LX.UserConfig[]) {
    this.baselineConfigUsers = users.map(user => ({
      ...user,
      dataPath: user.dataPath || '',
    }))
  }

  private getConfigOriginUsers(): LX.UserConfig[] {
    const source = this.baselineConfigUsers.length
      ? this.baselineConfigUsers
      : global.lx.config.users
    const suppressed = this.data.suppressedConfigUsernames ?? []
    return source.filter(user =>
      !this.findManagedUserByUsername(user.name) &&
      !suppressed.includes(user.name),
    )
  }

  private refreshGlobalUsers() {
    if (!global.lx?.config?.users) return
    global.lx.config.users = this.getSyncUsers()
  }

  private saveSync() {
    atomicWriteFileSync(this.filePath, JSON.stringify(this.data, null, 2))
    this.refreshGlobalUsers()
  }

  private ensureEnvAdmin() {
    const username = process.env.LUX_ADMIN_USER
    const password = process.env.LUX_ADMIN_PASSWORD
    if (!username || !password || this.findManagedUserByUsername(username)) return

    const user = this.createManagedUserSync({
      username,
      passwordHash: hashPasswordSync(password),
      role: 'admin',
    })
    if (user) this.saveSync()
  }

  private ensureUserDir(username: string) {
    const userDir = path.join(global.lx.userPath, getUserDirname(username))
    checkAndCreateDirSync(userDir)
    return userDir
  }

  private createManagedUserSync({
    username,
    passwordHash,
    role,
    displayName,
    lxSyncCode,
  }: {
    username: string
    passwordHash: string
    role: LuxUserRole
    displayName?: string
    lxSyncCode?: string
  }) {
    const time = now()
    const user: LuxManagedUser = {
      id: createId(),
      username,
      displayName,
      role,
      source: 'managed',
      status: 'active',
      loginPasswordHash: passwordHash,
      lxSyncCode: lxSyncCode || createSyncCode(),
      syncCodeUpdatedAt: time,
      sessionVersion: 1,
      createdAt: time,
      updatedAt: time,
    }
    this.ensureUserDir(username)
    this.data.users.push(user)
    return user
  }

  getTokenSecret() {
    return process.env.LUX_TOKEN_SECRET || this.data.tokenSecret
  }

  hasManagedAdmin() {
    return this.data.users.some(user => user.role == 'admin' && user.status == 'active')
  }

  getManagedUsers() {
    return this.data.users
  }

  findManagedUserById(id: string) {
    return this.data.users.find(user => user.id == id) ?? null
  }

  findManagedUserByUsername(username: string) {
    return this.data.users.find(user => user.username == username) ?? null
  }

  getUserViews(): LuxUserView[] {
    const legacyUsers = this.getConfigOriginUsers()
      .map<LuxUserView>(user => ({
        id: `config:${user.name}`,
        username: user.name,
        role: 'user',
        source: 'config',
        status: 'active',
        hasLoginPassword: false,
        hasSyncCode: true,
        maxSnapshotNum: user.maxSnapshotNum,
        'list.addMusicLocationType': user['list.addMusicLocationType'],
      }))

    return [
      ...legacyUsers,
      ...this.data.users.map<LuxUserView>(user => ({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatar: user.avatar,
        gender: user.gender,
        signature: user.signature,
        role: user.role,
        source: user.source,
        status: user.status,
        hasLoginPassword: !!user.loginPasswordHash,
        hasSyncCode: !!user.lxSyncCode,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt,
        maxSnapshotNum: user.maxSnapshotNum,
        'list.addMusicLocationType': user['list.addMusicLocationType'],
      })),
    ]
  }

  getSyncUsers(): LX.UserConfig[] {
    const legacyUsers = this.getConfigOriginUsers()
    const managedUsers = this.data.users
      .filter(user => user.status == 'active')
      .map<LX.UserConfig>(user => ({
        name: user.username,
        password: user.lxSyncCode,
        maxSnapshotNum: user.maxSnapshotNum,
        'list.addMusicLocationType': user['list.addMusicLocationType'],
        dataPath: path.join(global.lx.userPath, getUserDirname(user.username)),
      }))
    return [...legacyUsers, ...managedUsers]
  }

  getSyncUserConfig(username: string): LX.UserConfig | null {
    const managedUser = this.findManagedUserByUsername(username)
    if (managedUser?.status == 'active') {
      return {
        name: managedUser.username,
        password: managedUser.lxSyncCode,
        maxSnapshotNum: managedUser.maxSnapshotNum,
        'list.addMusicLocationType': managedUser['list.addMusicLocationType'],
        dataPath: path.join(global.lx.userPath, `${managedUser.username}`),
      }
    }
    return global.lx.config.users.find(user => user.name == username) ?? null
  }

  async createUser({
    username,
    password,
    role = 'user',
    displayName,
  }: {
    username: string
    password: string
    role?: LuxUserRole
    displayName?: string
  }) {
    if (this.findManagedUserByUsername(username) || this.getConfigOriginUsers().some(user => user.name == username)) {
      throw new Error('User name already exists')
    }
    const passwordHash = await hashPassword(password)
    const user = this.createManagedUserSync({ username, passwordHash, role, displayName })
    this.saveSync()
    return sanitizeUser(user)
  }

  async verifyLogin(username: string, password: string) {
    const user = this.findManagedUserByUsername(username)
    if (!user || user.status != 'active' || !user.loginPasswordHash) return null
    if (!await verifyPassword(password, user.loginPasswordHash)) return null
    user.lastLoginAt = now()
    user.updatedAt = user.lastLoginAt
    this.saveSync()
    return user
  }

  async changePassword(userId: string, password: string) {
    const user = this.findManagedUserById(userId)
    if (!user) throw new Error('User not found')
    user.loginPasswordHash = await hashPassword(password)
    this.sessions.revokeUser(userId)
    user.sessionVersion += 1
    user.updatedAt = now()
    this.saveSync()
    this.syncKeyRevocationListener?.(user.username, 'all')
    return sanitizeUser(user)
  }

  /** Bump sessionVersion so all existing JWTs for this user fail authGuard checks. */
  invalidateSessions(userId: string) {
    const user = this.findManagedUserById(userId)
    if (!user) throw new Error('User not found')
    this.sessions.revokeUser(userId)
    user.sessionVersion += 1
    user.updatedAt = now()
    this.saveSync()
    return sanitizeUser(user)
  }

  getSyncCode(userId: string) {
    const user = this.findManagedUserById(userId)
    if (!user) throw new Error('User not found')
    return user.lxSyncCode
  }

  resetSyncCode(userId: string) {
    const user = this.findManagedUserById(userId)
    if (!user) throw new Error('User not found')
    user.lxSyncCode = createSyncCode()
    user.syncCodeUpdatedAt = now()
    user.updatedAt = user.syncCodeUpdatedAt
    this.saveSync()
    this.syncKeyRevocationListener?.(user.username, 'sessionless')
    return user.lxSyncCode
  }

  updateUser(userId: string, data: Partial<Pick<LuxManagedUser, 'displayName' | 'avatar' | 'gender' | 'signature' | 'role' | 'status' | 'maxSnapshotNum' | 'list.addMusicLocationType'>>, actorId?: string) {
    const user = this.findManagedUserById(userId)
    if (!user) throw new Error('User not found')
    if (actorId == userId && user.role == 'admin' && (data.status == 'disabled' || data.role == 'user')) {
      throw new Error('Cannot disable or demote yourself')
    }
    if (user.role == 'admin' && user.status == 'active' && (data.status == 'disabled' || data.role == 'user')) {
      // Login/admin auth uses active managed accounts. LUX_ADMIN_* creates one;
      // legacy config.js / LX_USER_* users only have sync access, never admin access.
      const hasOtherActiveAdmin = this.data.users.some(
        candidate => candidate.id != userId && candidate.role == 'admin' && candidate.status == 'active',
      )
      if (!hasOtherActiveAdmin) throw new Error('Cannot disable or demote the last active admin')
    }
    if (data.displayName !== undefined) user.displayName = data.displayName
    if (data.avatar !== undefined) user.avatar = data.avatar
    if (data.gender !== undefined) user.gender = data.gender
    if (data.signature !== undefined) user.signature = data.signature
    if (data.role) user.role = data.role
    const disabling = data.status == 'disabled' && user.status != 'disabled'
    if (disabling) {
      this.sessions.revokeUser(userId)
      user.sessionVersion += 1
    }
    if (data.status) user.status = data.status
    if (data.maxSnapshotNum !== undefined) user.maxSnapshotNum = data.maxSnapshotNum
    if (data['list.addMusicLocationType'] !== undefined) user['list.addMusicLocationType'] = data['list.addMusicLocationType']
    user.updatedAt = now()
    this.saveSync()
    if (disabling) this.syncKeyRevocationListener?.(user.username, 'all')
    return sanitizeUser(user)
  }

  createInvite({
    code,
    role = 'user',
    maxUses = 1,
    expiresAt,
    createdBy,
  }: {
    code?: string
    role?: LuxUserRole
    maxUses?: number
    expiresAt?: number
    createdBy: string
  }) {
    const rawCode = code || randomBytes(12).toString('base64url')
    const invite: InviteCode = {
      id: createId(),
      codeHash: hashInviteCode(rawCode),
      role,
      maxUses,
      usedCount: 0,
      expiresAt,
      disabled: false,
      createdBy,
      createdAt: now(),
      usedBy: [],
    }
    this.data.invites.push(invite)
    this.saveSync()
    return { invite, code: rawCode }
  }

  getInvites() {
    return this.data.invites
  }

  updateInvite(id: string, data: Partial<Pick<InviteCode, 'disabled' | 'expiresAt' | 'maxUses' | 'role'>>) {
    const invite = this.data.invites.find(invite => invite.id == id)
    if (!invite) throw new Error('Invite not found')
    if (data.disabled !== undefined) invite.disabled = data.disabled
    if (data.expiresAt !== undefined) invite.expiresAt = data.expiresAt
    if (data.maxUses !== undefined) invite.maxUses = data.maxUses
    if (data.role) invite.role = data.role
    this.saveSync()
    return invite
  }

  deleteInvite(id: string) {
    const index = this.data.invites.findIndex(invite => invite.id == id)
    if (index < 0) return false
    this.data.invites.splice(index, 1)
    this.saveSync()
    return true
  }

  deleteManagedUser(userId: string) {
    const user = this.findManagedUserById(userId)
    if (!user) throw new Error('User not found')
    if (user.role == 'admin' && user.status == 'active') {
      const otherActiveAdmins = this.data.users.filter(
        candidate => candidate.role == 'admin' && candidate.status == 'active' && candidate.id != userId,
      ).length
      if (otherActiveAdmins == 0) throw new Error('Cannot delete the last admin')
    }

    const username = user.username
    this.data.invites = this.data.invites.filter(invite => {
      if (invite.createdBy == userId) return false
      invite.usedBy = invite.usedBy.filter(entry => entry.userId != userId)
      return true
    })

    const index = this.data.users.findIndex(candidate => candidate.id == userId)
    if (index < 0) throw new Error('User not found')
    this.sessions.revokeUser(userId)
    this.data.users.splice(index, 1)

    if (this.baselineConfigUsers.some(entry => entry.name == username)) {
      const suppressed = this.data.suppressedConfigUsernames ?? []
      if (!suppressed.includes(username)) suppressed.push(username)
      this.data.suppressedConfigUsernames = suppressed
    }

    this.saveSync()

    const userDir = path.join(global.lx.userPath, getUserDirname(username))
    if (fs.existsSync(userDir)) fs.rmSync(userDir, { recursive: true, force: true })

    return { username }
  }

  checkInvite(code: string) {
    const invite = this.data.invites.find(invite => invite.codeHash == hashInviteCode(code))
    if (!invite) throw new InviteValidationError('INVITE_NOT_FOUND', 'Invite code invalid')
    if (invite.disabled) throw new InviteValidationError('INVITE_DISABLED', 'Invite code invalid')
    if (invite.expiresAt !== undefined && invite.expiresAt <= now()) throw new InviteValidationError('INVITE_EXPIRED', 'Invite code expired')
    if (invite.usedCount >= invite.maxUses) throw new InviteValidationError('INVITE_USED_UP', 'Invite code used up')
    return invite
  }

  async registerByInvite({
    code,
    username,
    password,
    displayName,
  }: {
    code: string
    username: string
    password: string
    displayName?: string
  }) {
    this.checkInvite(code)
    const passwordHash = await hashPassword(password)
    // Revalidate after hashing: no await between validation, user creation and consumption.
    const invite = this.checkInvite(code)
    if (this.findManagedUserByUsername(username) || this.getConfigOriginUsers().some(user => user.name == username)) {
      throw new Error('User name already exists')
    }
    const user = this.createManagedUserSync({ username, passwordHash, role: invite.role, displayName })
    invite.usedCount += 1
    invite.usedBy.push({ userId: user.id, username: user.username, usedAt: now() })
    this.saveSync()
    return sanitizeUser(user)
  }
}

let store: AccountStore | null = null

export const initAccountStore = (dataPath = global.lx.dataPath) => {
  store = new AccountStore(dataPath)
  return store
}

export const getAccountStore = () => {
  if (!store) store = new AccountStore(global.lx.dataPath)
  return store
}
