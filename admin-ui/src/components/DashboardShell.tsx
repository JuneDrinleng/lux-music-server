import { useState, type ReactNode } from 'react'
import {
  IconAccountKey,
  IconCircle,
  IconDevices,
  IconInvite,
  IconLogout,
  IconMusicCircle,
  IconOverview,
  IconRefresh,
  IconServerRack,
  IconShieldCrown,
  IconUsers,
} from '@/lib/icons'
import { Avatar } from '@/components/primitives'
import { formatChineseDate, greetingForNow, roleLabel } from '@/lib/format'
import type { PublicUser, SectionId } from '@/types'

const sectionTitles: Record<SectionId, string> = {
  overview: '总览',
  'devices-playlists': '设备与歌单',
  'account-sync': '账号与连接码',
  'admin-status': '服务状态',
  users: '用户',
  invites: '邀请码',
}

const getSectionTitle = (id: SectionId) => sectionTitles[id] ?? '总览'

interface NavItem {
  id: SectionId
  label: string
  description: string
  tone: 'mine' | 'admin'
  icon: ReactNode
  group: 'mine' | 'admin'
  adminOnly?: boolean
}

const navItems: NavItem[] = [
  { id: 'overview', label: '总览', description: '运行概况与快捷入口', tone: 'mine', icon: <IconOverview />, group: 'mine' },
  { id: 'devices-playlists', label: '设备与歌单', description: '客户端与同步数据', tone: 'mine', icon: <IconDevices />, group: 'mine' },
  { id: 'account-sync', label: '账号与连接码', description: '密码与客户端凭据', tone: 'mine', icon: <IconAccountKey />, group: 'mine' },
  { id: 'admin-status', label: '服务状态', description: '运行状态与地址', tone: 'admin', icon: <IconServerRack />, group: 'admin', adminOnly: true },
  { id: 'users', label: '用户', description: '账号、状态、连接码', tone: 'admin', icon: <IconUsers />, group: 'admin', adminOnly: true },
  { id: 'invites', label: '邀请码', description: '注册入口与使用次数', tone: 'admin', icon: <IconInvite />, group: 'admin', adminOnly: true },
]

const getVisibleNavItems = (user: PublicUser) => navItems.filter(item => !item.adminOnly || user.role == 'admin')

const sectionEyebrow = (section: SectionId) => {
  if (section == 'overview') return `${greetingForNow()} · ${formatChineseDate()}`
  if (section == 'devices-playlists') return '同步数据'
  if (section == 'account-sync') return '个人'
  return '管理员'
}

const isAdminSection = (section: SectionId) => section == 'admin-status' || section == 'users' || section == 'invites'

export function DashboardShell({
  me,
  activeSection,
  onSectionChange,
  onRefresh,
  onLogout,
  children,
}: {
  me: PublicUser
  activeSection: SectionId
  onSectionChange: (s: SectionId) => void
  onRefresh: () => void
  onLogout: () => void
  children: ReactNode
}) {
  const [adminSheetOpen, setAdminSheetOpen] = useState(false)
  const items = getVisibleNavItems(me)
  const mineItems = items.filter(item => item.group == 'mine')
  const adminItems = items.filter(item => item.group == 'admin')
  const isAdmin = me.role == 'admin'
  const displayName = me.displayName || me.username

  const go = (section: SectionId) => {
    setAdminSheetOpen(false)
    onSectionChange(section)
  }

  return (
    <div className="lux-shell">
      <aside className="lux-side">
        <div className="lux-brand">
          <div className="lux-logo"><IconMusicCircle /></div>
          <div>
            <b>Lux 同步后台</b>
            <span>LUX MUSIC SYNC</span>
          </div>
        </div>

        <div className="lux-eyebrow">我的</div>
        {mineItems.map(item => (
          <button
            key={item.id}
            type="button"
            className={item.id == activeSection ? 'lux-nav active' : 'lux-nav'}
            aria-current={item.id == activeSection ? 'page' : undefined}
            onClick={() => go(item.id)}
          >
            <IconCircle tone={item.tone} size="sm">{item.icon}</IconCircle>
            <div>
              <div>{item.label}</div>
              <small>{item.description}</small>
            </div>
          </button>
        ))}

        {adminItems.length ? (
          <>
            <div className="lux-eyebrow">管理员</div>
            {adminItems.map(item => (
              <button
                key={item.id}
                type="button"
                className={item.id == activeSection ? 'lux-nav active' : 'lux-nav'}
                aria-current={item.id == activeSection ? 'page' : undefined}
                onClick={() => go(item.id)}
              >
                <IconCircle tone={item.tone} size="sm">{item.icon}</IconCircle>
                <div>
                  <div>{item.label}</div>
                  <small>{item.description}</small>
                </div>
              </button>
            ))}
          </>
        ) : null}

        <div className="lux-spacer" />

        <div className="lux-me-chip">
          <Avatar name={displayName} size={36} tone="mine" />
          <div style={{ minWidth: 0, flex: 1 }}>
            <b>{displayName}</b>
            <span>{me.username} · {roleLabel(me.role)}</span>
          </div>
          <button type="button" className="lux-out" title="退出登录" onClick={onLogout}>
            <IconLogout />
          </button>
        </div>
      </aside>

      <div className="lux-mobile-bar">
        <Avatar name={displayName} size={44} tone="mine" />
        <button type="button" className="lux-iconbtn" style={{ width: 44, height: 44, borderRadius: 22, background: '#fff', boxShadow: 'var(--shadow-bubble)' }} onClick={onRefresh} title="刷新全部">
          <IconRefresh />
        </button>
      </div>

      {activeSection == 'overview' ? (
        <div className="lux-mobile-greeting lux-eyebrow">{greetingForNow()} · {displayName}</div>
      ) : null}

      <main className="lux-main">
        <div className="lux-topbar">
          <div>
            <div className="lux-eyebrow">{sectionEyebrow(activeSection)}</div>
            <h1>{getSectionTitle(activeSection)}</h1>
          </div>
          <div className="lux-right">
            <button type="button" className="lux-btn cap" onClick={onRefresh}>
              <IconRefresh />刷新全部
            </button>
          </div>
        </div>
        <div className="lux-stack">{children}</div>
      </main>

      <nav className="lux-dock" aria-label="移动导航">
        <button type="button" className={activeSection == 'overview' ? 'd on' : 'd'} onClick={() => go('overview')}>
          {activeSection == 'overview' ? <div className="orb"><IconOverview /></div> : <IconOverview />}
          <span>总览</span>
        </button>
        <button type="button" className={activeSection == 'devices-playlists' ? 'd on' : 'd'} onClick={() => go('devices-playlists')}>
          {activeSection == 'devices-playlists' ? <div className="orb"><IconDevices /></div> : <IconDevices />}
          <span>设备歌单</span>
        </button>
        <button type="button" className={activeSection == 'account-sync' ? 'd on' : 'd'} onClick={() => go('account-sync')}>
          {activeSection == 'account-sync' ? <div className="orb"><IconAccountKey /></div> : <IconAccountKey />}
          <span>账号</span>
        </button>
        {isAdmin ? (
          <button
            type="button"
            className={isAdminSection(activeSection) ? 'd on' : 'd'}
            onClick={() => setAdminSheetOpen(true)}
          >
            {isAdminSection(activeSection) ? <div className="orb"><IconShieldCrown /></div> : <IconShieldCrown />}
            <span>管理</span>
          </button>
        ) : null}
      </nav>

      {isAdmin ? (
        <div
          className={adminSheetOpen ? 'lux-admin-sheet open' : 'lux-admin-sheet'}
          onClick={() => setAdminSheetOpen(false)}
          role="presentation"
        >
          <div className="sheet" onClick={event => event.stopPropagation()} role="dialog" aria-label="管理菜单">
            {adminItems.map(item => (
              <button
                key={item.id}
                type="button"
                className={item.id == activeSection ? 'lux-nav active' : 'lux-nav'}
                onClick={() => go(item.id)}
              >
                <IconCircle tone={item.tone} size="sm">{item.icon}</IconCircle>
                <div>
                  <div>{item.label}</div>
                  <small>{item.description}</small>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
