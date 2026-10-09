import { useState } from 'react'
import { authApi, setToken } from '@/lib/api'
import {
  IconAccountKey,
  IconDevices,
  IconInvite,
  IconLock,
  IconMusicCircle,
  IconPerson,
  IconShieldCrown,
  IconCircle,
} from '@/lib/icons'
import { Field } from '@/components/primitives'
import type { PublicUser } from '@/types'

const getFormString = (form: HTMLFormElement, name: string) => {
  const value = new FormData(form).get(name)
  return typeof value == 'string' ? value.trim() : ''
}

function AuthHero() {
  return (
    <section className="lux-hero">
      <div className="lux-brand" style={{ padding: 0 }}>
        <div className="lux-logo"><IconMusicCircle /></div>
        <div>
          <b>Lux Music</b>
          <span>SYNC SERVER</span>
        </div>
      </div>
      <h1>同步服务<br />管理后台</h1>
      <p className="lead">管理账号、邀请码、设备与歌单同步概况。和 Lux Music 手机端同一套浅色、圆角、黄绿强调的设计语言。</p>
      <div className="lux-rail" aria-hidden="true">
        <i style={{ width: 44 }} />
        <i style={{ width: 18, opacity: 0.6 }} />
        <i style={{ width: 10, opacity: 0.35 }} />
        <i style={{ width: 10, opacity: 0.2 }} />
      </div>
      <div className="feat">
        <div className="lux-row">
          <IconCircle tone="mine"><IconDevices /></IconCircle>
          <div className="t"><b>设备与歌单</b><span>查看已授权客户端和同步歌单</span></div>
        </div>
        <div className="lux-row">
          <IconCircle tone="mine"><IconAccountKey /></IconCircle>
          <div className="t"><b>账号与连接码</b><span>后台密码与客户端连接凭据分开管理</span></div>
        </div>
        <div className="lux-row">
          <IconCircle tone="mine"><IconShieldCrown /></IconCircle>
          <div className="t"><b>管理员工具</b><span>服务状态、用户与邀请码</span></div>
        </div>
      </div>
      <div className="lux-disc" aria-hidden="true" />
    </section>
  )
}

function BootstrapCard({ onBootstrapDone, notify }: { onBootstrapDone: () => Promise<void>, notify: (m: string) => void }) {
  const submit = async(event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    try {
      await authApi.bootstrap({
        username: getFormString(form, 'username'),
        displayName: getFormString(form, 'displayName') || undefined,
        password: getFormString(form, 'password'),
      })
      form.reset()
      notify('管理员已创建，请登录')
      await onBootstrapDone()
    } catch (error) {
      notify(error instanceof Error ? error.message : '创建失败')
    }
  }

  return (
    <div className="lux-card lg">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <IconCircle tone="invites" size="md"><IconShieldCrown /></IconCircle>
        <span className="lux-pill" style={{ background: '#fef9c3', color: '#854d0e' }}>首次部署</span>
      </div>
      <h2>初始化管理员</h2>
      <p className="desc">当前还没有管理员账号。请先设置管理员用户名和密码，完成后即可登录后台继续配置用户和邀请码。</p>
      <form style={{ display: 'grid', gap: 14, marginTop: 20 }} onSubmit={submit}>
        <Field label="用户名" name="username" autoComplete="username" required icon={<IconPerson />} />
        <Field label="显示名（可选）" name="displayName" icon={<IconPerson />} />
        <Field label="密码" name="password" type="password" autoComplete="new-password" required icon={<IconLock />} />
        <button type="submit" className="lux-btn primary block" style={{ marginTop: 4 }}>创建第一个管理员</button>
      </form>
    </div>
  )
}

function LoginRegisterCard({ onLogin, notify }: { onLogin: (user: PublicUser) => Promise<void>, notify: (m: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')

  const login = async(event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    try {
      const data = await authApi.login({
        username: getFormString(form, 'username'),
        password: getFormString(form, 'password'),
      })
      setToken(data.token)
      notify('登录成功')
      await onLogin(data.user)
    } catch (error) {
      notify(error instanceof Error ? error.message : '登录失败')
    }
  }

  const register = async(event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    try {
      await authApi.register({
        inviteCode: getFormString(form, 'inviteCode'),
        username: getFormString(form, 'username'),
        displayName: getFormString(form, 'displayName') || undefined,
        password: getFormString(form, 'password'),
      })
      form.reset()
      setMode('login')
      notify('注册成功，请登录')
    } catch (error) {
      notify(error instanceof Error ? error.message : '注册失败')
    }
  }

  return (
    <div className="lux-card lg">
      <div className="lux-seg" role="tablist" aria-label="登录或注册">
        <button type="button" className={mode == 'login' ? 'on' : undefined} onClick={() => setMode('login')}>登录</button>
        <button type="button" className={mode == 'register' ? 'on' : undefined} onClick={() => setMode('register')}>邀请码注册</button>
      </div>

      {mode == 'login' ? (
        <>
          <h2>欢迎回来</h2>
          <p className="desc">使用你的 Lux 管理账号进入同步控制台。</p>
          <form style={{ display: 'grid', gap: 12, marginTop: 16 }} onSubmit={login}>
            <Field label="用户名" name="username" autoComplete="username" required icon={<IconPerson />} />
            <Field label="密码" name="password" type="password" autoComplete="current-password" required icon={<IconLock />} />
            <button type="submit" className="lux-btn primary block" style={{ marginTop: 6 }}>登录</button>
          </form>
          <p className="lux-note" style={{ textAlign: 'center', marginTop: 18 }}>
            没有账号？
            <button type="button" className="lux-btn ghost" style={{ height: 'auto', padding: '0 4px', background: 'transparent', color: 'var(--body)', fontWeight: 700 }} onClick={() => setMode('register')}>
              使用邀请码注册
            </button>
          </p>
        </>
      ) : (
        <>
          <h2>邀请码注册</h2>
          <p className="desc">使用管理员发放的邀请码创建普通或管理员账号。</p>
          <form style={{ display: 'grid', gap: 14, marginTop: 20 }} onSubmit={register}>
            <Field label="邀请码" name="inviteCode" required icon={<IconInvite />} />
            <Field label="用户名" name="username" autoComplete="username" required icon={<IconPerson />} />
            <Field label="显示名（可选）" name="displayName" icon={<IconPerson />} />
            <Field label="密码" name="password" type="password" autoComplete="new-password" required icon={<IconLock />} />
            <button type="submit" className="lux-btn primary block" style={{ marginTop: 4 }}>注册</button>
          </form>
          <p className="lux-note" style={{ textAlign: 'center', marginTop: 16 }}>
            已有账号？
            <button type="button" className="lux-btn ghost" style={{ height: 'auto', padding: '0 4px', background: 'transparent', color: 'var(--body)', fontWeight: 700 }} onClick={() => setMode('login')}>
              返回登录
            </button>
          </p>
        </>
      )}

      <div style={{ borderTop: '1px solid var(--divider)', margin: '18px -24px 0', padding: '14px 24px 0' }}>
        <p className="lux-note">首次部署且无管理员时，此卡片会切换为「初始化管理员」。</p>
      </div>
    </div>
  )
}

export function AuthScreen({
  bootstrapVisible,
  onLogin,
  onBootstrapDone,
  notify,
}: {
  bootstrapVisible: boolean
  onLogin: (user: PublicUser) => Promise<void>
  onBootstrapDone: () => Promise<void>
  notify: (m: string) => void
}) {
  return (
    <div className="lux-login">
      <AuthHero />
      <section className="lux-auth">
        {bootstrapVisible
          ? <BootstrapCard onBootstrapDone={onBootstrapDone} notify={notify} />
          : <LoginRegisterCard onLogin={onLogin} notify={notify} />}
      </section>
    </div>
  )
}
