export type Role = 'admin' | 'user'
export type UserStatus = 'active' | 'disabled'
export type UserSource = 'managed' | 'config' | 'env'

export interface PublicUser {
  id: string
  username: string
  displayName?: string
  role: Role
  source: UserSource
  status: UserStatus
}

export interface UserView extends PublicUser {
  hasLoginPassword: boolean
  hasSyncCode: boolean
  createdAt?: number
  updatedAt?: number
  lastLoginAt?: number
  maxSnapshotNum?: number
  'list.addMusicLocationType'?: 'top' | 'bottom'
}

export interface Device {
  clientId: string
  deviceName?: string
  isMobile?: boolean
  lastConnectDate?: number
}

export interface PlaylistItem {
  id?: string
  name: string
  source?: string
  sourceListId?: string
  locationUpdateTime?: number
  musicCount: number
}

export interface PlaylistSummary {
  defaultList: PlaylistItem
  loveList: PlaylistItem
  userList: PlaylistItem[]
}

export interface ServerStatus {
  status: boolean
  message?: string
  address?: string[]
  devices?: unknown[]
}

export interface AdminStatusResponse {
  status: ServerStatus
  users: number
  managedUsers: number
  invites: number
}

export interface Invite {
  id: string
  codeHash: string
  role: Role
  maxUses: number
  usedCount: number
  expiresAt?: number
  disabled: boolean
  createdBy: string
  createdAt: number
  usedBy: Array<{ userId: string, username: string, usedAt: number }>
}
