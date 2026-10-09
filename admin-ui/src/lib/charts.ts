import type { Device, Invite, OnlineDevice, PlaylistSummary, UserView } from '@/types'

export interface Slice {
  key: string
  label: string
  value: number
  color: string
}

export interface BarPoint {
  key: string
  label: string
  value: number
}

const HOUR_LABELS = ['0–5', '6–11', '12–17', '18–23'] as const

export const devicePlatformSlices = (devices: Device[]): Slice[] => {
  const mobile = devices.filter(d => d.isMobile).length
  const desktop = devices.length - mobile
  return [
    { key: 'mobile', label: '移动端', value: mobile, color: 'var(--g-mine)' },
    { key: 'desktop', label: '桌面端', value: desktop, color: 'var(--g-admin)' },
  ].filter(s => s.value > 0)
}

/** Bucket lastConnectDate into four dayparts (local time). Skips devices never connected. */
export const connectionHourBars = (devices: Array<Device | OnlineDevice>): BarPoint[] => {
  const counts = [0, 0, 0, 0]
  for (const d of devices) {
    if (!d.lastConnectDate) continue
    const h = new Date(d.lastConnectDate).getHours()
    counts[Math.min(3, Math.floor(h / 6))]! += 1
  }
  return HOUR_LABELS.map((label, i) => ({ key: label, label, value: counts[i]! }))
}

export const userRoleSlices = (users: UserView[]): Slice[] => {
  const admin = users.filter(u => u.role == 'admin').length
  const user = users.length - admin
  return [
    { key: 'admin', label: '管理员', value: admin, color: 'var(--g-admin)' },
    { key: 'user', label: '用户', value: user, color: 'var(--g-mine)' },
  ].filter(s => s.value > 0)
}

export const userStatusSlices = (users: UserView[]): Slice[] => {
  const active = users.filter(u => u.status == 'active').length
  const disabled = users.length - active
  return [
    { key: 'active', label: '正常', value: active, color: 'var(--g-status)' },
    { key: 'disabled', label: '已禁用', value: disabled, color: 'var(--g-logout)' },
  ].filter(s => s.value > 0)
}

export const userSourceSlices = (users: UserView[]): Slice[] => {
  const map = new Map<string, number>()
  for (const u of users) map.set(u.source, (map.get(u.source) || 0) + 1)
  const colors: Record<string, string> = {
    managed: 'var(--g-mine)',
    config: 'var(--g-password)',
    env: 'var(--g-invites)',
  }
  const labels: Record<string, string> = {
    managed: 'managed',
    config: 'config',
    env: 'env',
  }
  return [...map.entries()].map(([key, value]) => ({
    key,
    label: labels[key] || key,
    value,
    color: colors[key] || 'var(--well)',
  }))
}

export const inviteUsageSummary = (invites: Invite[]) => {
  const totalMax = invites.reduce((s, i) => s + i.maxUses, 0)
  const totalUsed = invites.reduce((s, i) => s + i.usedCount, 0)
  const available = invites.filter(i => !i.disabled && i.usedCount < i.maxUses).length
  const exhausted = invites.filter(i => !i.disabled && i.usedCount >= i.maxUses).length
  const disabled = invites.filter(i => i.disabled).length
  return { totalMax, totalUsed, available, exhausted, disabled, bars: invites.map(i => ({
    key: i.id,
    label: i.id.slice(0, 12),
    used: i.usedCount,
    max: i.maxUses,
    disabled: i.disabled,
  })) }
}

export const playlistSourceBars = (playlists: PlaylistSummary | null): BarPoint[] => {
  if (!playlists) return []
  const lists = [playlists.defaultList, playlists.loveList, ...playlists.userList]
  const map = new Map<string, number>()
  for (const list of lists) {
    const key = list.source?.trim() || '本地/其他'
    map.set(key, (map.get(key) || 0) + 1)
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ key: label, label, value }))
}

export const onlineVsAuthorized = (authorized: number, online: number): Slice[] => [
  { key: 'online', label: '在线', value: online, color: 'var(--g-status)' },
  { key: 'offline', label: '离线授权', value: Math.max(0, authorized - online), color: 'var(--well)' },
].filter(s => s.value > 0)

export const donutGradient = (slices: Slice[]) => {
  const total = slices.reduce((s, x) => s + x.value, 0)
  if (!total) return 'conic-gradient(var(--divider) 0 100%)'
  let acc = 0
  const parts: string[] = []
  for (const slice of slices) {
    const start = (acc / total) * 100
    acc += slice.value
    const end = (acc / total) * 100
    parts.push(`${slice.color} ${start}% ${end}%`)
  }
  return `conic-gradient(${parts.join(', ')})`
}
