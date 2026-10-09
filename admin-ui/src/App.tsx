import { useEffect, useState } from 'react'
import { authApi, getToken, meApi, adminApi, setToken } from '@/lib/api'
import { Toast } from '@/components/primitives'
import { AuthScreen } from '@/components/AuthScreen'
import { DashboardShell } from '@/components/DashboardShell'
import {
  AccountSection,
  DevicesPlaylistsSection,
  InvitesSection,
  OverviewSection,
  StatusSection,
  UsersSection,
} from '@/components/pages'
import type { AdminStatusResponse, Device, Invite, PlaylistSummary, PublicUser, SectionId, UserView } from '@/types'

const navItems: Array<{ id: SectionId, adminOnly?: boolean }> = [
  { id: 'overview' },
  { id: 'devices-playlists' },
  { id: 'account-sync' },
  { id: 'admin-status', adminOnly: true },
  { id: 'users', adminOnly: true },
  { id: 'invites', adminOnly: true },
]

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
    void (async() => {
      try {
        if (getToken()) await authApi.logout()
      } catch {
        // Token may already be invalid; still clear local state.
      } finally {
        setToken('')
        setMe(null)
        setDevices([])
        setPlaylists(null)
        setAdminStatus(null)
        setUsers([])
        setInvites([])
        setActiveSection('overview')
        await loadBootstrap()
      }
    })()
  }

  if (loading) {
    return (
      <>
        <Toast message={message} />
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 18 }}>
          <div className="lux-card" style={{ padding: 24, minWidth: 220, textAlign: 'center' }}>
            <div className="lux-note">加载中...</div>
          </div>
        </div>
      </>
    )
  }

  if (!me) {
    return (
      <>
        <Toast message={message} />
        <AuthScreen
          bootstrapVisible={bootstrapVisible}
          onLogin={loadDashboard}
          onBootstrapDone={loadMe}
          notify={notify}
        />
      </>
    )
  }

  const sectionContent = () => {
    if (activeSection == 'devices-playlists') {
      return (
        <DevicesPlaylistsSection
          devices={devices}
          playlists={playlists}
          refreshDevices={loadDevices}
          refreshPlaylists={loadPlaylists}
          notify={notify}
        />
      )
    }
    if (activeSection == 'account-sync') {
      return (
        <AccountSection
          me={me}
          adminStatus={adminStatus}
          onLogout={logout}
          notify={notify}
        />
      )
    }
    if (activeSection == 'admin-status' && me.role == 'admin') {
      return <StatusSection status={adminStatus} refresh={loadAdminStatus} />
    }
    if (activeSection == 'users' && me.role == 'admin') {
      return <UsersSection users={users} refresh={loadUsers} notify={notify} />
    }
    if (activeSection == 'invites' && me.role == 'admin') {
      return <InvitesSection invites={invites} refresh={loadInvites} notify={notify} />
    }
    return (
      <OverviewSection
        me={me}
        devices={devices}
        playlists={playlists}
        adminStatus={adminStatus}
        users={users}
        invites={invites}
        onSectionChange={setActiveSection}
      />
    )
  }

  return (
    <>
      <Toast message={message} />
      <DashboardShell
        me={me}
        activeSection={activeSection}
        onSectionChange={setActiveSection}
        onRefresh={() => void loadMe()}
        onLogout={logout}
      >
        {sectionContent()}
      </DashboardShell>
    </>
  )
}

export default App
