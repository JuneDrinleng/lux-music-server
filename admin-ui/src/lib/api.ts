import type { AdminStatusResponse, Device, Invite, PlaylistSummary, PublicUser, Role, SourcesAdminResponse, TogetherRoomsResponse, UserStatus, UserView } from '@/types'

export const tokenKey = 'lux_sync_admin_token'

let token = localStorage.getItem(tokenKey) || ''

export const getToken = () => token

export const setToken = (value: string) => {
  token = value
  if (value) localStorage.setItem(tokenKey, value)
  else localStorage.removeItem(tokenKey)
}

const parseResponseJson = (text: string): Record<string, unknown> => {
  if (!text) return {}
  try {
    const data = JSON.parse(text) as unknown
    return typeof data == 'object' && data != null ? data as Record<string, unknown> : {}
  } catch {
    const snippet = text.length > 120 ? `${text.slice(0, 120)}…` : text
    throw new Error(`服务器返回了非 JSON 响应：${snippet}`)
  }
}

const request = async<T>(path: string, options: RequestInit = {}): Promise<T> => {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(path, { ...options, headers })
  const text = await res.text()
  const data = parseResponseJson(text)
  if (!res.ok) {
    const message = typeof data.message == 'string' ? data.message : res.statusText
    if (res.status == 413) throw new Error(message || '请求体过大，请改用「选择文件」上传或减少脚本体积')
    if (res.status == 404 && path.startsWith('/api/admin/sources')) {
      throw new Error('当前服务端未提供音源脚本 API，请升级到包含 source 模块的 dev 构建')
    }
    throw new Error(message || `请求失败 (${res.status})`)
  }
  return data as T
}

const jsonBody = (body: unknown) => JSON.stringify(body)

export const authApi = {
  bootstrapStatus: () => request<{ needsAdmin: boolean, allowed: boolean }>('/api/auth/bootstrap'),
  bootstrap: (body: { username: string, password: string, displayName?: string }) => request<{ user: PublicUser }>('/api/auth/bootstrap', { method: 'POST', body: jsonBody(body) }),
  login: (body: { username: string, password: string }) => request<{ token: string, user: PublicUser }>('/api/auth/login', { method: 'POST', body: jsonBody(body) }),
  register: (body: { inviteCode: string, username: string, password: string, displayName?: string }) => request<{ user: PublicUser }>('/api/auth/register', { method: 'POST', body: jsonBody(body) }),
  me: () => request<{ user: PublicUser }>('/api/auth/me'),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
}

export const meApi = {
  devices: () => request<{ devices: Device[] }>('/api/me/devices'),
  deleteDevice: (clientId: string) => request<{ ok: boolean }>(`/api/me/devices/${encodeURIComponent(clientId)}`, { method: 'DELETE' }),
  playlists: () => request<{ playlists: PlaylistSummary }>('/api/me/playlists'),
  changePassword: (password: string) => request<{ ok: boolean }>('/api/me/password', { method: 'POST', body: jsonBody({ password }) }),
  revealSyncCode: () => request<{ syncCode: string }>('/api/me/sync-code'),
  resetSyncCode: () => request<{ syncCode: string }>('/api/me/sync-code/reset', { method: 'POST' }),
}

export const adminApi = {
  status: () => request<AdminStatusResponse>('/api/admin/status'),
  users: () => request<{ users: UserView[] }>('/api/admin/users'),
  createUser: (body: { username: string, password: string, displayName?: string, role: Role }) => request<{ user: PublicUser }>('/api/admin/users', { method: 'POST', body: jsonBody(body) }),
  updateUser: (id: string, body: { status?: UserStatus }) => request<{ user: PublicUser }>(`/api/admin/users/${id}`, { method: 'PATCH', body: jsonBody(body) }),
  revealUserSyncCode: (id: string) => request<{ syncCode: string }>(`/api/admin/users/${id}/sync-code`),
  resetUserSyncCode: (id: string) => request<{ syncCode: string }>(`/api/admin/users/${id}/sync-code/reset`, { method: 'POST' }),
  invites: () => request<{ invites: Invite[] }>('/api/admin/invites'),
  createInvite: (body: { code?: string, role: Role, maxUses: number }) => request<{ invite: Invite, code: string }>('/api/admin/invites', { method: 'POST', body: jsonBody(body) }),
  updateInvite: (id: string, body: { disabled?: boolean }) => request<{ invite: Invite }>(`/api/admin/invites/${id}`, { method: 'PATCH', body: jsonBody(body) }),
  deleteInvite: (id: string) => request<{ ok: boolean }>(`/api/admin/invites/${id}`, { method: 'DELETE' }),
  sources: () => request<SourcesAdminResponse>('/api/admin/sources'),
  uploadSource: (body: { script?: string, scriptBase64?: string, url?: string }) => request<{ script: SourcesAdminResponse['scripts'][number] }>('/api/admin/sources', { method: 'POST', body: jsonBody(body) }),
  enableSource: (id: string) => request<{ script: SourcesAdminResponse['scripts'][number] }>(`/api/admin/sources/${id}/enable`, { method: 'POST' }),
  disableSource: (id: string) => request<{ script: SourcesAdminResponse['scripts'][number] }>(`/api/admin/sources/${id}/disable`, { method: 'POST' }),
  deleteSource: (id: string) => request<{ ok: boolean }>(`/api/admin/sources/${id}`, { method: 'DELETE' }),
}

export const togetherApi = {
  rooms: () => request<TogetherRoomsResponse>('/api/admin/together/rooms'),
}
