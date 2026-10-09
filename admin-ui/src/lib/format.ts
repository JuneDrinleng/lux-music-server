const pad = (n: number) => String(n).padStart(2, '0')

export const formatDate = (value?: number) => {
  if (!value) return '从未连接'
  const d = new Date(value)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const formatOptionalDate = (value?: number) => {
  if (!value) return '永不过期'
  return formatDate(value)
}

export const roleLabel = (role: 'admin' | 'user') => role == 'admin' ? '管理员' : '用户'

export const statusLabel = (status: 'active' | 'disabled') => status == 'active' ? '正常' : '已禁用'

export const greetingForNow = (now = new Date()) => {
  const h = now.getHours()
  if (h < 6) return '凌晨好'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

export const formatChineseDate = (now = new Date()) => (
  `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
)

export const initialOf = (name: string) => {
  const t = name.trim()
  return t ? t[0]!.toUpperCase() : '?'
}

export const addressKind = (address: string) => {
  if (/^wss?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(address)) return '局域网'
  if (/^wss:\/\//i.test(address)) return '公网（反向代理）'
  return '可用地址'
}

export const stripWsHost = (address: string) => address.replace(/^wss?:\/\//i, '')
