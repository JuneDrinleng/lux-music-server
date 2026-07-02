export const formatDate = (value?: number) => {
  if (!value) return '从未连接'
  return new Date(value).toLocaleString()
}

export const formatOptionalDate = (value?: number) => value ? new Date(value).toLocaleString() : '不过期'

export const roleLabel = (role: 'admin' | 'user') => role == 'admin' ? '管理员' : '用户'

export const statusLabel = (status: 'active' | 'disabled') => status == 'active' ? '启用' : '禁用'
