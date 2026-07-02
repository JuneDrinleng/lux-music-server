import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { KeyRound, LogOut, RefreshCcw, Server, Trash2 } from 'lucide-react'
import { adminApi, authApi, getToken, meApi, setToken } from '@/lib/api'
import { formatDate, formatOptionalDate, roleLabel, statusLabel } from '@/lib/format'
import type { AdminStatusResponse, Device, Invite, PlaylistItem, PlaylistSummary, PublicUser, Role, UserView } from '@/types'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'

type SectionId = 'overview' | 'devices-playlists' | 'account-sync' | 'admin-status' | 'users' | 'invites'

interface NavItem {
  id: SectionId
  label: string
  description: string
  adminOnly?: boolean
}

const navItems: NavItem[] = [
  { id: 'overview', label: '总览', description: '运行概况与快捷入口' },
  { id: 'devices-playlists', label: '设备与歌单', description: '客户端与同步数据' },
  { id: 'account-sync', label: '账号与连接码', description: '密码与客户端凭据' },
  { id: 'admin-status', label: '服务状态', description: '运行状态与地址', adminOnly: true },
  { id: 'users', label: '用户', description: '账号、状态、连接码', adminOnly: true },
  { id: 'invites', label: '邀请码', description: '注册入口与使用次数', adminOnly: true },
]

const getVisibleNavItems = (user: PublicUser) => navItems.filter(item => !item.adminOnly || user.role == 'admin')

const getSectionTitle = (id: SectionId) => navItems.find(item => item.id == id)?.label ?? '总览'

const getFormString = (form: HTMLFormElement, name: string) => {
  const value = new FormData(form).get(name)
  return typeof value == 'string' ? value.trim() : ''
}

const roleBadgeVariant = (role: Role) => role == 'admin' ? 'default' : 'secondary'

function Field({ label, name, type = 'text', autoComplete, required = false }: { label: string, name: string, type?: string, autoComplete?: string, required?: boolean }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} autoComplete={autoComplete} required={required} />
    </div>
  )
}

function RoleSelect({ value, onChange }: { value: Role, onChange: (value: Role) => void }) {
  return (
    <div className="grid gap-2">
      <Label>角色</Label>
      <Select value={value} onValueChange={value => onChange(value as Role)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="user">用户</SelectItem>
          <SelectItem value="admin">管理员</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

function CredentialBlock({ value }: { value: string }) {
  return <code className="credential-cassette block">{value}</code>
}

function BootstrapPanel({ onDone, notify }: { onDone: () => Promise<void>, notify: (message: string) => void }) {
  const submit = async(event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    await authApi.bootstrap({
      username: getFormString(form, 'username'),
      displayName: getFormString(form, 'displayName') || undefined,
      password: getFormString(form, 'password'),
    })
    form.reset()
    notify('管理员已创建，请登录')
    await onDone()
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>初始化管理员</CardTitle>
        <CardDescription>当前还没有管理员账号。请先设置管理员用户名和密码，完成后即可登录后台继续配置用户和邀请码。</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
          <Field label="用户名" name="username" autoComplete="username" required />
          <Field label="显示名" name="displayName" />
          <Field label="密码" name="password" type="password" autoComplete="new-password" required />
          <Button type="submit">创建第一个管理员</Button>
        </form>
      </CardContent>
    </Card>
  )
}

function LoginRegisterPanel({ onLogin, notify }: { onLogin: (user: PublicUser) => Promise<void>, notify: (message: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')

  const login = async(event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = await authApi.login({ username: getFormString(form, 'username'), password: getFormString(form, 'password') })
    setToken(data.token)
    notify('登录成功')
    await onLogin(data.user)
  }

  const register = async(event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    await authApi.register({
      inviteCode: getFormString(form, 'inviteCode'),
      username: getFormString(form, 'username'),
      displayName: getFormString(form, 'displayName') || undefined,
      password: getFormString(form, 'password'),
    })
    form.reset()
    setMode('login')
    notify('注册成功，请登录')
  }

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>{mode == 'login' ? '登录' : '邀请码注册'}</CardTitle>
        <CardDescription>{mode == 'login' ? '使用你的 Lux 管理账号进入同步控制台。' : '使用管理员发放的邀请码创建普通或管理员账号。'}</CardDescription>
      </CardHeader>
      <CardContent>
        {mode == 'login' ? (
          <form className="grid gap-4" onSubmit={login}>
            <Field label="用户名" name="username" autoComplete="username" required />
            <Field label="密码" name="password" type="password" autoComplete="current-password" required />
            <Button type="submit">登录</Button>
            <p className="text-center text-sm text-muted-foreground">
              没有账号？
              <Button type="button" variant="link" className="h-auto px-1 py-0" onClick={() => setMode('register')}>注册</Button>
            </p>
          </form>
        ) : (
          <form className="grid gap-4" onSubmit={register}>
            <Field label="邀请码" name="inviteCode" required />
            <Field label="用户名" name="username" autoComplete="username" required />
            <Field label="显示名" name="displayName" />
            <Field label="密码" name="password" type="password" autoComplete="new-password" required />
            <Button type="submit">注册</Button>
            <p className="text-center text-sm text-muted-foreground">
              已有账号？
              <Button type="button" variant="link" className="h-auto px-1 py-0" onClick={() => setMode('login')}>返回登录</Button>
            </p>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

function DevicesCard({ devices, refresh, notify }: { devices: Device[], refresh: () => Promise<void>, notify: (message: string) => void }) {
  const remove = async(clientId: string) => {
    await meApi.deleteDevice(clientId)
    notify('设备已删除')
    await refresh()
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>我的设备</CardTitle>
          <CardDescription>已授权连接到此同步账号的客户端。</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}><RefreshCcw className="h-4 w-4" />刷新</Button>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!devices.length ? <p className="text-sm text-muted-foreground">暂无设备</p> : devices.map(device => (
          <div key={device.clientId} className="rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h4 className="font-semibold">{device.deviceName || 'Unknown'}</h4>
                <p className="text-sm text-muted-foreground">clientId: {device.clientId}</p>
                <p className="text-sm text-muted-foreground">类型: {device.isMobile ? '移动端' : '桌面端'} · 最后连接: {formatDate(device.lastConnectDate)}</p>
              </div>
              <Button variant="destructive" size="sm" onClick={() => remove(device.clientId)}><Trash2 className="h-4 w-4" />删除</Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function PlaylistsCard({ playlists, refresh }: { playlists: PlaylistSummary | null, refresh: () => Promise<void> }) {
  const lists = useMemo<PlaylistItem[]>(() => playlists ? [playlists.defaultList, playlists.loveList, ...playlists.userList] : [], [playlists])
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>我的歌单</CardTitle>
          <CardDescription>同步数据中的歌单概况。</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}><RefreshCcw className="h-4 w-4" />刷新</Button>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!lists.length ? <p className="text-sm text-muted-foreground">暂无歌单</p> : lists.map((list, index) => (
          <div key={`${list.id || list.name}-${index}`} className="rounded-lg border p-4">
            <h4 className="font-semibold">{list.name}</h4>
            <p className="text-sm text-muted-foreground">ID: {list.id || 'N/A'} · 歌曲数: {list.musicCount}</p>
            {list.source ? <p className="text-sm text-muted-foreground">来源: {list.source} / {list.sourceListId || ''}</p> : null}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function PasswordCard({ onLogout, notify }: { onLogout: () => void, notify: (message: string) => void }) {
  const submit = async(event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    await meApi.changePassword(getFormString(form, 'password'))
    form.reset()
    notify('密码已更新，请重新登录')
    onLogout()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>修改密码</CardTitle>
        <CardDescription>修改后当前登录会话会失效，需要重新登录。</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
          <Field label="新密码" name="password" type="password" autoComplete="new-password" required />
          <Button type="submit">保存新密码</Button>
        </form>
      </CardContent>
    </Card>
  )
}

function SyncCodeCard({ notify }: { notify: (message: string) => void }) {
  const [syncCode, setSyncCode] = useState('')

  const toggle = async() => {
    if (syncCode) {
      setSyncCode('')
      return
    }
    const data = await meApi.revealSyncCode()
    setSyncCode(data.syncCode)
    notify('连接码已显示')
  }

  const reset = async() => {
    const data = await meApi.resetSyncCode()
    setSyncCode(data.syncCode)
    notify('连接码已重置')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5" />连接码</CardTitle>
        <CardDescription>连接码是 LX Music 客户端连接同步服务器时使用的凭据，不同于后台登录密码；重置后旧客户端需要重新填写。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" type="button" onClick={toggle}>{syncCode ? '隐藏连接码' : '显示我的连接码'}</Button>
          <Button type="button" onClick={reset}>重置我的同步连接码</Button>
        </div>
        {syncCode ? <CredentialBlock value={syncCode} /> : null}
      </CardContent>
    </Card>
  )
}

function StatusCard({ status, refresh }: { status: AdminStatusResponse | null, refresh: () => Promise<void> }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2"><Server className="h-5 w-5" />服务状态</CardTitle>
          <CardDescription>同步服务器运行状态与管理对象统计。</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}><RefreshCcw className="h-4 w-4" />刷新</Button>
      </CardHeader>
      <CardContent>
        {!status ? <p className="text-sm text-muted-foreground">暂无数据</p> : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border p-4"><p className="text-sm text-muted-foreground">状态</p><p className="font-semibold">{status.status.status ? '运行中' : '未运行'}</p></div>
            <div className="rounded-lg border p-4"><p className="text-sm text-muted-foreground">用户</p><p className="font-semibold">{status.users} / managed {status.managedUsers}</p></div>
            <div className="rounded-lg border p-4"><p className="text-sm text-muted-foreground">邀请码</p><p className="font-semibold">{status.invites}</p></div>
            <div className="rounded-lg border p-4"><p className="text-sm text-muted-foreground">在线设备</p><p className="font-semibold">{(status.status.devices || []).length}</p></div>
            <div className="rounded-lg border p-4 sm:col-span-2 lg:col-span-4"><p className="text-sm text-muted-foreground">地址</p><p className="font-semibold">{(status.status.address || []).join(', ') || 'N/A'}</p></div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function CreateUserForm({ refresh, notify }: { refresh: () => Promise<void>, notify: (message: string) => void }) {
  const [role, setRole] = useState<Role>('user')
  const submit = async(event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    await adminApi.createUser({
      username: getFormString(form, 'username'),
      displayName: getFormString(form, 'displayName') || undefined,
      password: getFormString(form, 'password'),
      role,
    })
    form.reset()
    setRole('user')
    notify('用户已创建')
    await refresh()
  }

  return (
    <Card>
      <CardHeader><CardTitle>创建用户</CardTitle><CardDescription>创建可登录后台并用于客户端同步的 managed 用户。</CardDescription></CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
          <Field label="用户名" name="username" required />
          <Field label="显示名" name="displayName" />
          <Field label="密码" name="password" type="password" required />
          <RoleSelect value={role} onChange={setRole} />
          <Button type="submit">创建</Button>
        </form>
      </CardContent>
    </Card>
  )
}

function CreateInviteForm({ refresh, notify }: { refresh: () => Promise<void>, notify: (message: string) => void }) {
  const [role, setRole] = useState<Role>('user')
  const [code, setCode] = useState('')
  const submit = async(event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const result = await adminApi.createInvite({
      code: getFormString(form, 'code') || undefined,
      role,
      maxUses: Number(getFormString(form, 'maxUses') || 1),
    })
    form.reset()
    setRole('user')
    setCode(result.code)
    notify('邀请码已创建')
    await refresh()
  }

  return (
    <Card>
      <CardHeader><CardTitle>创建邀请码</CardTitle><CardDescription>原始邀请码只在创建后展示一次。</CardDescription></CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
          <Field label="指定邀请码（可留空）" name="code" />
          <RoleSelect value={role} onChange={setRole} />
          <Field label="最大使用次数" name="maxUses" type="number" required />
          <Button type="submit">创建邀请码</Button>
          {code ? <CredentialBlock value={code} /> : null}
        </form>
      </CardContent>
    </Card>
  )
}

function UsersCard({ users, refresh, notify }: { users: UserView[], refresh: () => Promise<void>, notify: (message: string) => void }) {
  const [codes, setCodes] = useState<Record<string, string>>({})

  const toggleUser = async(user: UserView) => {
    await adminApi.updateUser(user.id, { status: user.status == 'active' ? 'disabled' : 'active' })
    await refresh()
  }

  const toggleCode = async(user: UserView) => {
    if (codes[user.id]) {
      setCodes(current => ({ ...current, [user.id]: '' }))
      return
    }
    const data = await adminApi.revealUserSyncCode(user.id)
    setCodes(current => ({ ...current, [user.id]: data.syncCode }))
    notify('连接码已显示')
  }

  const resetCode = async(user: UserView) => {
    const data = await adminApi.resetUserSyncCode(user.id)
    setCodes(current => ({ ...current, [user.id]: data.syncCode }))
    notify('连接码已重置')
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div><CardTitle>用户管理</CardTitle><CardDescription>管理 managed 用户状态与同步连接码。</CardDescription></div>
        <Button variant="outline" size="sm" onClick={refresh}><RefreshCcw className="h-4 w-4" />刷新用户</Button>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!users.length ? <p className="text-sm text-muted-foreground">暂无用户</p> : users.map(user => (
          <div key={user.id} className="rounded-lg border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <h4 className="font-semibold">{user.displayName || user.username}</h4>
                <p className="text-sm text-muted-foreground">{user.username}</p>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={roleBadgeVariant(user.role)}>{user.role}</Badge>
                  <Badge variant={user.status == 'active' ? 'sync' : 'outline'}>{user.status}</Badge>
                  <Badge variant="outline">{user.source}</Badge>
                  <Badge variant="secondary">登录密码: {user.hasLoginPassword ? '已设置' : '未设置'}</Badge>
                  <Badge variant="secondary">连接码: {user.hasSyncCode ? '已设置' : '未设置'}</Badge>
                </div>
              </div>
            </div>
            {user.source === 'managed' ? (
              <div className="mt-4 grid gap-3">
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => toggleUser(user)}>{user.status == 'active' ? '禁用' : '启用'}</Button>
                  <Button size="sm" variant="outline" onClick={() => toggleCode(user)}>{codes[user.id] ? '隐藏连接码' : '显示连接码'}</Button>
                  <Button size="sm" onClick={() => resetCode(user)}>重置连接码</Button>
                </div>
                {codes[user.id] ? <CredentialBlock value={codes[user.id]} /> : null}
              </div>
            ) : <p className="mt-3 text-sm text-muted-foreground">配置文件/环境变量用户不可在此显示或重置连接码。</p>}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function InvitesCard({ invites, refresh, notify }: { invites: Invite[], refresh: () => Promise<void>, notify: (message: string) => void }) {
  const toggle = async(invite: Invite) => {
    await adminApi.updateInvite(invite.id, { disabled: !invite.disabled })
    await refresh()
  }
  const remove = async(invite: Invite) => {
    await adminApi.deleteInvite(invite.id)
    notify('邀请码已删除')
    await refresh()
  }
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div><CardTitle>邀请码管理</CardTitle><CardDescription>邀请码原文不会在列表中保存，只展示哈希和状态。</CardDescription></div>
        <Button variant="outline" size="sm" onClick={refresh}><RefreshCcw className="h-4 w-4" />刷新邀请码</Button>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!invites.length ? <p className="text-sm text-muted-foreground">暂无邀请码</p> : invites.map(invite => (
          <div key={invite.id} className="rounded-lg border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Badge variant={roleBadgeVariant(invite.role)}>{invite.role}</Badge>
                  <Badge variant={invite.disabled ? 'outline' : 'sync'}>{invite.disabled ? '已禁用' : '可用'}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">使用: {invite.usedCount}/{invite.maxUses} · 过期: {formatOptionalDate(invite.expiresAt)}</p>
                <p className="text-sm text-muted-foreground">ID: {invite.id}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => toggle(invite)}>{invite.disabled ? '启用' : '禁用'}</Button>
                <Button variant="destructive" size="sm" onClick={() => remove(invite)}><Trash2 className="h-4 w-4" />删除</Button>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function SectionNav({ items, activeSection, onSectionChange, compact = false }: { items: NavItem[], activeSection: SectionId, onSectionChange: (section: SectionId) => void, compact?: boolean }) {
  return (
    <nav aria-label="后台区域" className={compact ? 'flex gap-2 overflow-x-auto pb-2' : 'grid gap-2'}>
      {items.map(item => {
        const active = item.id == activeSection
        return (
          <Button
            key={item.id}
            type="button"
            variant={active ? 'default' : compact ? 'outline' : 'ghost'}
            className={compact ? 'shrink-0 justify-start' : 'h-auto justify-start px-3 py-3 text-left'}
            aria-current={active ? 'page' : undefined}
            onClick={() => onSectionChange(item.id)}
          >
            <span className="grid gap-0.5">
              <span>{item.label}</span>
              {!compact ? <span className="text-xs font-normal opacity-70">{item.description}</span> : null}
            </span>
          </Button>
        )
      })}
    </nav>
  )
}

function MetricCard({ label, value, hint }: { label: string, value: string | number, hint?: string }) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  )
}

function OverviewSection({ me, devices, playlists, adminStatus, users, invites, onSectionChange }: { me: PublicUser, devices: Device[], playlists: PlaylistSummary | null, adminStatus: AdminStatusResponse | null, users: UserView[], invites: Invite[], onSectionChange: (section: SectionId) => void }) {
  const playlistCount = playlists ? 2 + playlists.userList.length : 0
  return (
    <section aria-labelledby="overview-heading" className="grid gap-4">
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={roleBadgeVariant(me.role)}>{roleLabel(me.role)}</Badge>
            <Badge variant={me.status == 'active' ? 'sync' : 'outline'}>{me.status}</Badge>
          </div>
          <div>
            <CardTitle id="overview-heading" className="text-3xl">欢迎，{me.displayName || me.username}</CardTitle>
            <CardDescription>{me.username} 的同步控制台总览。</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button onClick={() => onSectionChange('devices-playlists')}>查看设备与歌单</Button>
          <Button variant="outline" onClick={() => onSectionChange('account-sync')}>管理连接码</Button>
          {me.role == 'admin' ? <Button variant="outline" onClick={() => onSectionChange('users')}>管理用户</Button> : null}
        </CardContent>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="设备" value={devices.length} hint="已授权客户端" />
        <MetricCard label="歌单" value={playlistCount} hint="默认、我喜欢与自建歌单" />
        {me.role == 'admin' ? <MetricCard label="用户" value={adminStatus?.users ?? users.length} hint={`managed ${adminStatus?.managedUsers ?? users.filter(user => user.source == 'managed').length}`} /> : null}
        {me.role == 'admin' ? <MetricCard label="邀请码" value={adminStatus?.invites ?? invites.length} hint="当前保存的邀请入口" /> : null}
        {me.role == 'admin' ? <MetricCard label="服务" value={adminStatus?.status.status ? '运行中' : '未知'} hint={(adminStatus?.status.address || []).join(', ') || '等待状态刷新'} /> : null}
      </div>
    </section>
  )
}

function DashboardShell({ me, activeSection, onSectionChange, onRefresh, onLogout, children }: { me: PublicUser, activeSection: SectionId, onSectionChange: (section: SectionId) => void, onRefresh: () => void, onLogout: () => void, children: ReactNode }) {
  const items = getVisibleNavItems(me)
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-[1360px] gap-6 px-4 py-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="hidden lg:block">
        <div className="sticky top-6 grid max-h-[calc(100vh-3rem)] gap-5 overflow-auto rounded-xl border bg-card p-5 shadow-sm">
          <div className="grid gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Lux Music Sync</p>
            <div className="sync-rail" aria-hidden="true"><span /><span /><span /><span /></div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">同步管理后台</h1>
              <p className="mt-1 text-sm text-muted-foreground">{me.displayName || me.username}</p>
            </div>
          </div>
          <Separator />
          <SectionNav items={items} activeSection={activeSection} onSectionChange={onSectionChange} />
          <div className="mt-auto grid gap-2 pt-4">
            <Button variant="outline" onClick={onRefresh}><RefreshCcw className="h-4 w-4" />刷新全部</Button>
            <Button variant="ghost" onClick={onLogout}><LogOut className="h-4 w-4" />退出登录</Button>
          </div>
        </div>
      </aside>
      <section className="min-w-0 space-y-4">
        <header className="grid gap-4 rounded-xl border bg-card p-4 shadow-sm lg:p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Dashboard</p>
              <h2 className="mt-1 text-3xl font-semibold tracking-tight">{getSectionTitle(activeSection)}</h2>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={onRefresh}><RefreshCcw className="h-4 w-4" />刷新全部</Button>
              <Button variant="outline" onClick={onLogout}><LogOut className="h-4 w-4" />退出登录</Button>
            </div>
          </div>
          <div className="lg:hidden">
            <SectionNav items={items} activeSection={activeSection} onSectionChange={onSectionChange} compact />
          </div>
        </header>
        {children}
      </section>
    </main>
  )
}

function App() {
  const [me, setMe] = useState<PublicUser | null>(null)
  const [bootstrapVisible, setBootstrapVisible] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [devices, setDevices] = useState<Device[]>([])
  const [playlists, setPlaylists] = useState<PlaylistSummary | null>(null)
  const [adminStatus, setAdminStatus] = useState<AdminStatusResponse | null>(null)
  const [users, setUsers] = useState<UserView[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [activeSection, setActiveSection] = useState<SectionId>('overview')

  const notify = (text: string) => setMessage(text)

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(''), 3200)
    return () => window.clearTimeout(timer)
  }, [message])

  useEffect(() => {
    if (me?.role != 'admin' && navItems.find(item => item.id == activeSection)?.adminOnly) setActiveSection('overview')
  }, [activeSection, me])

  const loadBootstrap = async() => {
    const data = await authApi.bootstrapStatus()
    setBootstrapVisible(!!(data.needsAdmin && data.allowed))
  }

  const loadDevices = async() => setDevices((await meApi.devices()).devices)
  const loadPlaylists = async() => setPlaylists((await meApi.playlists()).playlists)
  const loadAdminStatus = async() => setAdminStatus(await adminApi.status())
  const loadUsers = async() => setUsers((await adminApi.users()).users)
  const loadInvites = async() => setInvites((await adminApi.invites()).invites)

  const loadDashboard = async(user: PublicUser) => {
    setMe(user)
    setBootstrapVisible(false)
    await Promise.all([
      loadDevices(),
      loadPlaylists(),
      user.role == 'admin' ? loadAdminStatus() : Promise.resolve(),
      user.role == 'admin' ? loadUsers() : Promise.resolve(),
      user.role == 'admin' ? loadInvites() : Promise.resolve(),
    ])
  }

  const loadMe = async() => {
    setLoading(true)
    try {
      if (!getToken()) {
        setMe(null)
        await loadBootstrap()
        return
      }
      const data = await authApi.me()
      await loadDashboard(data.user)
    } catch {
      setToken('')
      setMe(null)
      await loadBootstrap()
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadMe() }, [])

  const logout = () => {
    setToken('')
    setMe(null)
    setDevices([])
    setPlaylists(null)
    setAdminStatus(null)
    setUsers([])
    setInvites([])
    setActiveSection('overview')
    void loadBootstrap()
  }

  const body = () => {
    if (loading) return <Card><CardContent className="p-6 text-sm text-muted-foreground">加载中...</CardContent></Card>
    if (!me && bootstrapVisible) return <BootstrapPanel onDone={loadMe} notify={notify} />
    if (!me) return <LoginRegisterPanel onLogin={loadDashboard} notify={notify} />
    const sectionContent = () => {
      if (activeSection == 'devices-playlists') {
        return (
          <section aria-labelledby="devices-playlists-heading" className="grid gap-4">
            <h3 id="devices-playlists-heading" className="sr-only">设备与歌单</h3>
            <div className="grid gap-4 xl:grid-cols-2">
              <DevicesCard devices={devices} refresh={loadDevices} notify={notify} />
              <PlaylistsCard playlists={playlists} refresh={loadPlaylists} />
            </div>
          </section>
        )
      }
      if (activeSection == 'account-sync') {
        return (
          <section aria-labelledby="account-sync-heading" className="grid gap-4">
            <h3 id="account-sync-heading" className="sr-only">账号与连接码</h3>
            <div className="grid gap-4 xl:grid-cols-2">
              <PasswordCard onLogout={logout} notify={notify} />
              <SyncCodeCard notify={notify} />
            </div>
          </section>
        )
      }
      if (activeSection == 'admin-status' && me.role == 'admin') {
        return <section aria-labelledby="admin-status-heading"><h3 id="admin-status-heading" className="sr-only">服务状态</h3><StatusCard status={adminStatus} refresh={loadAdminStatus} /></section>
      }
      if (activeSection == 'users' && me.role == 'admin') {
        return (
          <section aria-labelledby="users-heading" className="grid gap-4">
            <h3 id="users-heading" className="sr-only">用户</h3>
            <CreateUserForm refresh={loadUsers} notify={notify} />
            <UsersCard users={users} refresh={loadUsers} notify={notify} />
          </section>
        )
      }
      if (activeSection == 'invites' && me.role == 'admin') {
        return (
          <section aria-labelledby="invites-heading" className="grid gap-4">
            <h3 id="invites-heading" className="sr-only">邀请码</h3>
            <CreateInviteForm refresh={loadInvites} notify={notify} />
            <InvitesCard invites={invites} refresh={loadInvites} notify={notify} />
          </section>
        )
      }
      return <OverviewSection me={me} devices={devices} playlists={playlists} adminStatus={adminStatus} users={users} invites={invites} onSectionChange={setActiveSection} />
    }

    return (
      <DashboardShell me={me} activeSection={activeSection} onSectionChange={setActiveSection} onRefresh={loadMe} onLogout={logout}>
        {sectionContent()}
      </DashboardShell>
    )
  }

  if (me && !loading) {
    return (
      <>
        {message ? <div className="fixed left-1/2 top-4 z-50 w-[min(560px,calc(100%-2rem))] -translate-x-1/2"><Alert variant="sync" aria-live="polite"><AlertDescription>{message}</AlertDescription></Alert></div> : null}
        {body()}
      </>
    )
  }

  return (
    <main className="mx-auto grid w-full max-w-[1120px] gap-6 px-4 py-8 md:py-10">
      <header className="grid gap-5 border-b pb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Lux Music Sync Server</p>
            <h1 className="text-4xl font-bold tracking-tight md:text-5xl">同步服务管理后台</h1>
            <p className="text-muted-foreground">管理账号、邀请码、设备与歌单同步概况。</p>
          </div>
        </div>
        <div className="sync-rail" aria-hidden="true"><span /><span /><span /><span /></div>
      </header>
      {message ? <Alert variant="sync" aria-live="polite"><AlertDescription>{message}</AlertDescription></Alert> : null}
      {body()}
    </main>
  )
}

export default App
