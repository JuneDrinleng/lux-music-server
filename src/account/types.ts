export type LuxUserRole = 'admin' | 'user'
export type LuxUserStatus = 'active' | 'disabled'
export type LuxUserSource = 'managed' | 'config' | 'env'

export interface LuxManagedUser {
  id: string
  username: string
  displayName?: string
  role: LuxUserRole
  source: 'managed'
  status: LuxUserStatus
  loginPasswordHash: string
  lxSyncCode: string
  syncCodeUpdatedAt: number
  sessionVersion: number
  maxSnapshotNum?: number
  'list.addMusicLocationType'?: LX.AddMusicLocationType
  createdAt: number
  updatedAt: number
  lastLoginAt?: number
}

export interface LuxUserView {
  id: string
  username: string
  displayName?: string
  role: LuxUserRole
  source: LuxUserSource
  status: LuxUserStatus
  hasLoginPassword: boolean
  hasSyncCode: boolean
  createdAt?: number
  updatedAt?: number
  lastLoginAt?: number
  maxSnapshotNum?: number
  'list.addMusicLocationType'?: LX.AddMusicLocationType
}

export interface InviteUsedBy {
  userId: string
  username: string
  usedAt: number
}

export interface InviteCode {
  id: string
  codeHash: string
  role: LuxUserRole
  maxUses: number
  usedCount: number
  expiresAt?: number
  disabled: boolean
  createdBy: string
  createdAt: number
  usedBy: InviteUsedBy[]
}

export interface LuxAccountStoreData {
  version: 1
  tokenSecret: string
  users: LuxManagedUser[]
  invites: InviteCode[]
}

export interface PublicUserInfo {
  id: string
  username: string
  displayName?: string
  role: LuxUserRole
  source: LuxUserSource
  status: LuxUserStatus
}
