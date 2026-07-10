import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { checkAndCreateDirSync } from '@/utils'
import { filterFileName, toMD5 } from '@/utils'
import { createSecret, hashPassword, hashPasswordSync, verifyPassword } from './password'
import type { InviteCode, LuxAccountStoreData, LuxManagedUser, LuxUserRole, LuxUserView, PublicUserInfo } from './types'

const now = () => Date.now()
const createId = () => randomBytes(12).toString('base64url')
const createSyncCode = () => randomBytes(18).toString('base64url')
const getUserDirname = (userName: string) => `${filterFileName(userName)}_${toMD5(userName).substring(0, 6)}`
export const hashInviteCode = (code: string) => createHash('sha256').update(code).digest('hex')

const createEmptyStore = (): LuxAccountStoreData => ({
  version: 1,
  tokenSecret: process.env.LUX_TOKEN_SECRET || createSecret(),
  users: [],
  invites: [],
})

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

  constructor(dataPath: string) {
    const dir = path.join(dataPath, 'lux')
    checkAndCreateDirSync(dir)
    this.filePath = path.join(dir, 'accounts.json')
    this.data = this.load()
    this.ensureEnvAdmin()
    this.saveSync()
  }

  private load() {
    if (!fs.existsSync(this.filePath)) return createEmptyStore()
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath).toString('utf-8')) as LuxAccountStoreData
      if (!data.tokenSecret) data.tokenSecret = process.env.LUX_TOKEN_SECRET || createSecret()
      data.users ??= []
      data.invites ??= []
      return data
    } catch (err) {
      console.error('Read accounts store error:', err)
      return createEmptyStore()
    }
  }

  private refreshGlobalUsers() {
    if (!global.lx?.config?.users) return
    global.lx.config.users = this.getSyncUsers()
  }

  private saveSync() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
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
    const legacyUsers = global.lx.config.users
      .filter(user => !this.findManagedUserByUsername(user.name))
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
    const legacyUsers = global.lx.config.users.filter(user => !this.findManagedUserByUsername(user.name))
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
    if (this.findManagedUserByUsername(username) || global.lx.config.users.some(user => user.name == username)) throw new Error('User name already exists')
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
    return user.lxSyncCode
  }

  updateUser(userId: string, data: Partial<Pick<LuxManagedUser, 'displayName' | 'avatar' | 'gender' | 'signature' | 'role' | 'status' | 'maxSnapshotNum' | 'list.addMusicLocationType'>>) {
    const user = this.findManagedUserById(userId)
    if (!user) throw new Error('User not found')
    if (data.displayName !== undefined) user.displayName = data.displayName
    if (data.avatar !== undefined) user.avatar = data.avatar
    if (data.gender !== undefined) user.gender = data.gender
    if (data.signature !== undefined) user.signature = data.signature
    if (data.role) user.role = data.role
    if (data.status) user.status = data.status
    if (data.maxSnapshotNum !== undefined) user.maxSnapshotNum = data.maxSnapshotNum
    if (data['list.addMusicLocationType'] !== undefined) user['list.addMusicLocationType'] = data['list.addMusicLocationType']
    user.updatedAt = now()
    this.saveSync()
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
    const invite = this.data.invites.find(invite => invite.codeHash == hashInviteCode(code))
    if (!invite || invite.disabled) throw new Error('Invite code invalid')
    if (invite.expiresAt && invite.expiresAt < now()) throw new Error('Invite code expired')
    if (invite.usedCount >= invite.maxUses) throw new Error('Invite code used up')
    const user = await this.createUser({ username, password, role: invite.role, displayName })
    invite.usedCount += 1
    invite.usedBy.push({ userId: user.id, username: user.username, usedAt: now() })
    this.saveSync()
    return user
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
