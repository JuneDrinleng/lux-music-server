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

export interface OnlineDevice {
  clientId?: string
  deviceName?: string
  isMobile?: boolean
  lastConnectDate?: number
  userName?: string
}

export interface ServerStatus {
  status: boolean
  message?: string
  address?: string[]
  devices?: OnlineDevice[]
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

export type SectionId = 'overview' | 'devices-playlists' | 'account-sync' | 'admin-status' | 'users' | 'invites' | 'sources'

export interface TogetherRoomsResponse {
  activeRooms: number
  members: number
  onlineMembers: number
}

export interface SourceScriptView {
  id: string
  name: string
  description: string
  version: string
  author: string
  homepage: string
  enabled: boolean
  priority: number
  status: 'disabled' | 'initializing' | 'ready' | 'error'
  error: string | null
  sources: Partial<Record<string, { actions: string[], qualitys: string[] }>>
  updateAlert: { log: string, updateUrl?: string } | null
  size: number
  createdAt: number
  updatedAt: number
}

export interface SourcesAdminResponse {
  scripts: SourceScriptView[]
  info: {
    available: boolean
    sources: Partial<Record<string, { actions: string[], qualitys: string[] }>>
    proxyStream: boolean
    updatedAt: number
  }
  settings: { timeoutMs: number, memoryMb: number, proxyStream: boolean }
}
