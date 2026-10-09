import { useMemo, useState } from 'react'
import { adminApi, meApi } from '@/lib/api'
import {
  connectionHourBars,
  devicePlatformSlices,
  inviteUsageSummary,
  playlistSourceBars,
  userRoleSlices,
  userSourceSlices,
  userStatusSlices,
} from '@/lib/charts'
import {
  addressKind,
  formatDate,
  formatOptionalDate,
  roleLabel,
  statusLabel,
  stripWsHost,
} from '@/lib/format'
import {
  IconAccountKey,
  IconAlert,
  IconCheck,
  IconChevron,
  IconCircle,
  IconDevices,
  IconEye,
  IconEyeOff,
  IconHeart,
  IconInvite,
  IconKey,
  IconLaptop,
  IconLock,
  IconLogout,
  IconMusicNote,
  IconPerson,
  IconPhone,
  IconPlaylist,
  IconPulse,
  IconRefresh,
  IconStatusOk,
  IconSyncReset,
  IconTrash,
  IconUserPlus,
  IconUsers,
  IconWifi,
} from '@/lib/icons'
import { CapsuleProgress, CapsuleRows, ChartCard, MetricTiles, MiniColumns, SegmentBar, UsageCapsules } from '@/components/charts'
import { Avatar, Cassette, DotPill, Field, Pill, RoleSeg, SourceTag } from '@/components/primitives'
import type {
  AdminStatusResponse,
  Device,
  Invite,
  PlaylistItem,
  PlaylistSummary,
  PublicUser,
  Role,
  SectionId,
  UserView,
} from '@/types'

const COVER_COLORS = ['#ece6f2', '#ebe4d7', '#e4e8f1', '#f6e2e7']

export const getSectionTitle = (id: SectionId) => {
  const map: Record<SectionId, string> = {
    overview: '总览',
    'devices-playlists': '设备与歌单',
    'account-sync': '账号与连接码',
    'admin-status': '服务状态',
    users: '用户',
    invites: '邀请码',
  }
  return map[id]
}

const getFormString = (form: HTMLFormElement, name: string) => {
  const value = new FormData(form).get(name)
  return typeof value == 'string' ? value.trim() : ''
}

const playlistLists = (playlists: PlaylistSummary | null): PlaylistItem[] => (
  playlists ? [playlists.defaultList, playlists.loveList, ...playlists.userList] : []
)

export function OverviewSection({
  me, devices, playlists, adminStatus, users, invites, onSectionChange,
}: {
  me: PublicUser
  devices: Device[]
  playlists: PlaylistSummary | null
  adminStatus: AdminStatusResponse | null
  users: UserView[]
  invites: Invite[]
  onSectionChange: (section: SectionId) => void
}) {
  const lists = playlistLists(playlists)
  const playlistCount = lists.length
  const displayName = me.displayName || me.username
  const addresses = adminStatus?.status.address || []
  const online = (adminStatus?.status.devices || []).length
  const recentDevices = [...devices].sort((a, b) => (b.lastConnectDate || 0) - (a.lastConnectDate || 0)).slice(0, 4)
  const glanceLists = lists.slice(0, 4)
  const isAdmin = me.role == 'admin'

  return (
    <div className="lux-stack">
      <div style={{ display: 'grid', gridTemplateColumns: isAdmin ? '1.7fr 1fr' : '1fr', gap: 12 }}>
        <div className="lux-card lg" style={{ padding: '18px 20px', display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <Avatar name={displayName} size={64} tone="mine" />
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Pill>{roleLabel(me.role)}</Pill>
              <DotPill tone={me.status == 'active' ? 'ok' : 'off'}>{me.status}</DotPill>
              <Pill tone="gray">{me.source}</Pill>
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--sub)', marginTop: 6 }}>欢迎，{displayName}</div>
            <div className="lux-note" style={{ marginTop: 1 }}>{me.username} 的同步控制台总览</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="lux-btn primary" onClick={() => onSectionChange('devices-playlists')}>查看设备与歌单</button>
            <button type="button" className="lux-btn ghost" onClick={() => onSectionChange('account-sync')}>管理连接码</button>
          </div>
        </div>
        {isAdmin ? (
          <div className="lux-card lg" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="lux-eyebrow">服务</div>
              <DotPill tone={adminStatus?.status.status ? 'ok' : 'off'}>{adminStatus?.status.status ? '运行中' : '未知'}</DotPill>
            </div>
            <div>
              <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: 'var(--strong)' }}>
                {addresses[0] ? stripWsHost(addresses[0]) : '等待地址'}
              </div>
              <div className="lux-note">另有 {Math.max(0, addresses.length - 1)} 个地址 · 在线设备 {online}</div>
            </div>
            <div>
              <button type="button" className="lux-btn sm ghost" onClick={() => onSectionChange('admin-status')}>
                <IconPulse />查看服务状态
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isAdmin ? 'repeat(4, 1fr)' : 'repeat(2, 1fr)', gap: 12 }}>
        <div className="lux-card lux-metric">
          <div className="top"><IconCircle tone="mine"><IconDevices /></IconCircle></div>
          <div className="v">{devices.length}</div>
          <div><div className="l">设备</div><div className="h">已授权客户端</div></div>
        </div>
        <div className="lux-card lux-metric">
          <div className="top"><IconCircle tone="mine"><IconPlaylist /></IconCircle></div>
          <div className="v">{playlistCount}</div>
          <div><div className="l">歌单</div><div className="h">默认、我喜欢与自建歌单</div></div>
        </div>
        {isAdmin ? (
          <>
            <div className="lux-card lux-metric">
              <div className="top"><IconCircle tone="admin"><IconUsers /></IconCircle><Pill tone="violet">管理员</Pill></div>
              <div className="v">{adminStatus?.users ?? users.length}</div>
              <div><div className="l">用户</div><div className="h">managed {adminStatus?.managedUsers ?? users.filter(u => u.source == 'managed').length}</div></div>
            </div>
            <div className="lux-card lux-metric">
              <div className="top"><IconCircle tone="admin"><IconInvite /></IconCircle><Pill tone="violet">管理员</Pill></div>
              <div className="v">{adminStatus?.invites ?? invites.length}</div>
              <div><div className="l">邀请码</div><div className="h">当前保存的邀请入口</div></div>
            </div>
          </>
        ) : null}
      </div>

      <div className="lux-page-split overview-bottom">
        <div className="lux-card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="lux-card-h"><div><div className="lux-eyebrow">快捷入口</div></div></div>
          <div className="lux-rows" style={{ flex: 1 }}>
            <button type="button" className="lux-row" onClick={() => onSectionChange('devices-playlists')}>
              <IconCircle tone="mine"><IconDevices /></IconCircle>
              <div className="t"><b>查看设备与歌单</b><span>{devices.length} 台设备 · {playlistCount} 个歌单</span></div>
              <IconChevron className="chev" />
            </button>
            <button type="button" className="lux-row" onClick={() => onSectionChange('account-sync')}>
              <IconCircle tone="mine"><IconAccountKey /></IconCircle>
              <div className="t"><b>管理连接码</b><span>客户端连接同步服务器时使用</span></div>
              <IconChevron className="chev" />
            </button>
            {isAdmin ? (
              <>
                <button type="button" className="lux-row" onClick={() => onSectionChange('users')}>
                  <IconCircle tone="admin"><IconUsers /></IconCircle>
                  <div className="t"><b>管理用户</b><span>仅管理员可见</span></div>
                  <IconChevron className="chev" />
                </button>
                <button type="button" className="lux-row" onClick={() => onSectionChange('invites')}>
                  <IconCircle tone="invites"><IconInvite /></IconCircle>
                  <div className="t"><b>邀请码</b><span>注册入口与使用次数</span></div>
                  <IconChevron className="chev" />
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="lux-card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="lux-card-h">
            <div><div className="lux-eyebrow">最近连接</div></div>
            <span className="lux-note">按最后连接时间</span>
          </div>
          <div className="lux-rows" style={{ flex: 1 }}>
            {!recentDevices.length ? <p className="lux-note" style={{ padding: '12px 16px' }}>暂无设备</p> : recentDevices.map(device => (
              <div key={device.clientId} className="lux-row">
                <IconCircle tone="admin">{device.isMobile ? <IconPhone /> : <IconLaptop />}</IconCircle>
                <div className="t">
                  <b>{device.deviceName || 'Unknown'}</b>
                  <span>{device.isMobile ? '移动端' : '桌面端'} · {formatDate(device.lastConnectDate)}</span>
                </div>
                <IconChevron className="chev" />
              </div>
            ))}
          </div>
          <div style={{ padding: '0 12px 12px' }}>
            <ChartCard title="连接时段" hint="按最后连接时刻分桶" compact>
              <MiniColumns points={connectionHourBars(devices)} />
            </ChartCard>
          </div>
        </div>

        <div className="lux-card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="lux-card-h">
            <div><div className="lux-eyebrow">歌单速览</div></div>
            <span className="lux-note">共 {playlistCount} 个</span>
          </div>
          <div className="lux-rows" style={{ flex: 1 }}>
            {!glanceLists.length ? <p className="lux-note" style={{ padding: '12px 16px' }}>暂无歌单</p> : glanceLists.map((list, index) => {
              const isLove = playlists && list === playlists.loveList
              const isDefault = playlists && list === playlists.defaultList
              const bg = isLove ? '#f6e2e7' : isDefault ? '#e4e8f1' : COVER_COLORS[index % COVER_COLORS.length]
              return (
                <div key={`${list.id || list.name}-${index}`} className="lux-row">
                  <div style={{ width: 40, height: 40, borderRadius: 12, background: bg, display: 'grid', placeItems: 'center', flex: 'none' }}>
                    {isLove ? <IconHeart /> : <IconMusicNote />}
                  </div>
                  <div className="t">
                    <b>{list.name}</b>
                    <span>{list.musicCount} 首{list.source ? ` · ${list.source}` : ''}</span>
                  </div>
                  <IconChevron className="chev" />
                </div>
              )
            })}
          </div>
          <div style={{ padding: '0 12px 12px' }}>
            <ChartCard title="歌单来源" hint="来自同步歌单 source" compact>
              <CapsuleRows points={playlistSourceBars(playlists)} unit=" 个" />
            </ChartCard>
          </div>
        </div>
      </div>
    </div>
  )
}

function DevicesCard({ devices, refresh, notify }: { devices: Device[], refresh: () => Promise<void>, notify: (message: string) => void }) {
  const remove = async(clientId: string) => {
    try {
      await meApi.deleteDevice(clientId)
      notify('设备已删除')
      await refresh()
    } catch (error) {
      notify(error instanceof Error ? error.message : '删除失败')
    }
  }

  return (
    <div className="lux-card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="lux-card-h">
        <div>
          <h3>我的设备</h3>
          <p>已授权连接到此同步账号的客户端 · {devices.length} 台</p>
        </div>
        <button type="button" className="lux-btn sm ghost" onClick={() => void refresh()}><IconRefresh />刷新</button>
      </div>
      <div className="lux-rows" style={{ flex: 1 }}>
        {!devices.length ? <p className="lux-note" style={{ padding: '12px 16px' }}>暂无设备</p> : devices.map(device => (
          <div key={device.clientId} className="lux-row" style={{ minHeight: 68 }}>
            <IconCircle tone="admin">{device.isMobile ? <IconPhone /> : <IconLaptop />}</IconCircle>
            <div className="t">
              <b>{device.deviceName || 'Unknown'}</b>
              <span>{device.isMobile ? '移动端' : '桌面端'} · 最后连接 {formatDate(device.lastConnectDate)}</span>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--weak)' }}>clientId {device.clientId}</span>
            </div>
            <button type="button" className="lux-iconbtn del" title="删除" onClick={() => void remove(device.clientId)}><IconTrash /></button>
          </div>
        ))}
      </div>
      <div style={{ padding: '0 14px 12px' }}>
        <div style={{ background: 'var(--muted)', borderRadius: 14, padding: '10px 12px' }} className="lux-note">
          删除后该客户端需要用连接码重新连接。
        </div>
      </div>
      <div style={{ padding: '0 12px 12px', display: 'grid', gap: 12 }}>
        <ChartCard title="设备平台" hint="按 isMobile 聚合" compact>
          <SegmentBar slices={devicePlatformSlices(devices)} unit=" 台" />
        </ChartCard>
        <ChartCard title="连接时段" hint="按 lastConnectDate 分桶" compact>
          <MiniColumns points={connectionHourBars(devices)} />
        </ChartCard>
      </div>
    </div>
  )
}

function PlaylistsCard({ playlists, refresh }: { playlists: PlaylistSummary | null, refresh: () => Promise<void> }) {
  const userLists = playlists?.userList || []
  const total = playlistLists(playlists).length

  return (
    <div className="lux-card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="lux-card-h">
        <div>
          <h3>我的歌单</h3>
          <p>同步数据中的歌单概况 · 共 {total} 个</p>
        </div>
        <button type="button" className="lux-btn sm ghost" onClick={() => void refresh()}><IconRefresh />刷新</button>
      </div>
      {playlists ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '4px 14px 6px' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'var(--muted)', borderRadius: 16, padding: 10 }}>
            <div style={{ width: 44, height: 44, borderRadius: 14, background: '#e4e8f1', display: 'grid', placeItems: 'center' }}><IconMusicNote /></div>
            <div>
              <b style={{ fontSize: 14, color: 'var(--strong)' }}>{playlists.defaultList.name}</b>
              <div className="lux-note">{playlists.defaultList.musicCount} 首 · ID {playlists.defaultList.id || 'default'}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'var(--muted)', borderRadius: 16, padding: 10 }}>
            <div style={{ width: 44, height: 44, borderRadius: 14, background: '#f6e2e7', display: 'grid', placeItems: 'center' }}><IconHeart /></div>
            <div>
              <b style={{ fontSize: 14, color: 'var(--strong)' }}>{playlists.loveList.name}</b>
              <div className="lux-note">{playlists.loveList.musicCount} 首 · ID {playlists.loveList.id || 'love'}</div>
            </div>
          </div>
        </div>
      ) : null}
      <div className="lux-pl-grid" style={{ flex: 1, alignContent: 'start' }}>
        {!userLists.length && !playlists ? <p className="lux-note">暂无歌单</p> : null}
        {userLists.map((list, index) => (
          <div key={`${list.id || list.name}-${index}`} className="lux-pl">
            <div className="cover" style={{ background: COVER_COLORS[index % COVER_COLORS.length] }}>
              <IconMusicNote />
              <span className="cnt">{list.musicCount} 首</span>
            </div>
            <b>{list.name}</b>
            <span>
              {list.source ? <><SourceTag source={list.source} />{list.sourceListId || ''}</> : '本地自建'}
            </span>
            <span className="mono" style={{ color: 'var(--weak)' }}>ID {list.id || 'N/A'}</span>
          </div>
        ))}
      </div>
      <div style={{ padding: '0 12px 12px' }}>
        <ChartCard title="歌单来源" hint="含默认与我喜欢" compact>
          <CapsuleRows points={playlistSourceBars(playlists)} unit=" 个" />
        </ChartCard>
      </div>
    </div>
  )
}

export function DevicesPlaylistsSection({
  devices, playlists, refreshDevices, refreshPlaylists, notify,
}: {
  devices: Device[]
  playlists: PlaylistSummary | null
  refreshDevices: () => Promise<void>
  refreshPlaylists: () => Promise<void>
  notify: (message: string) => void
}) {
  return (
    <div className="lux-page-split devices">
      <DevicesCard devices={devices} refresh={refreshDevices} notify={notify} />
      <PlaylistsCard playlists={playlists} refresh={refreshPlaylists} />
    </div>
  )
}

export function AccountSection({
  me, adminStatus, onLogout, notify,
}: {
  me: PublicUser
  adminStatus: AdminStatusResponse | null
  onLogout: () => void
  notify: (message: string) => void
}) {
  const [syncCode, setSyncCode] = useState('')
  const [password, setPassword] = useState('')
  const displayName = me.displayName || me.username
  const address = adminStatus?.status.address?.[0]

  const changePassword = async(event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    try {
      await meApi.changePassword(password)
      setPassword('')
      notify('密码已更新，请重新登录')
      onLogout()
    } catch (error) {
      notify(error instanceof Error ? error.message : '修改失败')
    }
  }

  const toggleCode = async() => {
    try {
      if (syncCode) {
        setSyncCode('')
        return
      }
      const data = await meApi.revealSyncCode()
      setSyncCode(data.syncCode)
      notify('连接码已显示')
    } catch (error) {
      notify(error instanceof Error ? error.message : '获取失败')
    }
  }

  const resetCode = async() => {
    try {
      const data = await meApi.resetSyncCode()
      setSyncCode(data.syncCode)
      notify('连接码已重置')
    } catch (error) {
      notify(error instanceof Error ? error.message : '重置失败')
    }
  }

  return (
    <div className="lux-page-split account">
      <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 12, minHeight: 0 }}>
        <div className="lux-card lg" style={{ padding: 18, display: 'flex', gap: 14, alignItems: 'center' }}>
          <Avatar name={displayName} size={56} tone="mine" />
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--sub)' }}>{displayName}</div>
            <div className="lux-note">{me.username}</div>
            <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
              <Pill>{roleLabel(me.role)}</Pill>
              <DotPill tone={me.status == 'active' ? 'ok' : 'off'}>{me.status}</DotPill>
              <Pill tone="gray">{me.source}</Pill>
            </div>
          </div>
        </div>
        <div className="lux-card" style={{ padding: '14px 16px', display: 'grid', gap: 10, alignContent: 'start' }}>
          <div className="lux-eyebrow">账号摘要</div>
          <div className="lux-rows" style={{ margin: '0 -16px' }}>
            <div className="lux-row" style={{ minHeight: 48 }}>
              <IconCircle tone="mine"><IconPerson /></IconCircle>
              <div className="t"><b>显示名</b><span>{displayName}</span></div>
            </div>
            <div className="lux-row" style={{ minHeight: 48 }}>
              <IconCircle tone="mine"><IconUsers /></IconCircle>
              <div className="t"><b>角色</b><span>{roleLabel(me.role)} · {me.source}</span></div>
            </div>
            <div className="lux-row" style={{ minHeight: 48 }}>
              <IconCircle tone="admin"><IconWifi /></IconCircle>
              <div className="t"><b>同步地址提示</b><span className="mono">{address || '登录后由服务状态提供'}</span></div>
            </div>
          </div>
        </div>
        <div className="lux-card">
          <button type="button" className="lux-row" onClick={onLogout}>
            <IconCircle tone="logout"><IconLogout /></IconCircle>
            <div className="t"><b style={{ color: 'var(--danger)' }}>退出登录</b><span>清除本机登录状态</span></div>
            <IconChevron className="chev" />
          </button>
        </div>
      </div>

      <div className="lux-card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="lux-card-h" style={{ paddingBottom: 4 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <IconCircle tone="password"><IconKey /></IconCircle>
            <div>
              <h3>修改密码</h3>
              <p>修改后当前登录会话会失效，需要重新登录</p>
            </div>
          </div>
        </div>
        <form style={{ padding: '10px 16px 16px', display: 'grid', gap: 12, flex: 1, alignContent: 'start' }} onSubmit={changePassword}>
          <div className="lux-field">
            <label htmlFor="new-password">新密码</label>
            <div className="lux-inp">
              <IconLock />
              <input id="new-password" name="password" type="password" autoComplete="new-password" required value={password} onChange={e => setPassword(e.target.value)} />
            </div>
          </div>
          <div style={{ background: 'var(--muted)', borderRadius: 14, padding: '10px 12px' }} className="lux-note">
            保存后需使用新密码重新登录后台。修改后当前登录会话会失效。
          </div>
          <div style={{ display: 'grid', gap: 8, marginTop: 4 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'var(--muted2)', borderRadius: 14, padding: '10px 12px' }}>
              <IconCircle tone="password" size="xs"><IconKey /></IconCircle>
              <div className="t"><b style={{ fontSize: 13 }}>后台登录密码</b><span style={{ fontSize: 12, color: 'var(--secondary-ink)' }}>仅用于管理后台，与客户端连接码无关</span></div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'var(--muted2)', borderRadius: 14, padding: '10px 12px' }}>
              <IconCircle tone="admin" size="xs"><IconAccountKey /></IconCircle>
              <div className="t"><b style={{ fontSize: 13 }}>连接码另管</b><span style={{ fontSize: 12, color: 'var(--secondary-ink)' }}>客户端凭据请在右侧「连接码」卡片操作</span></div>
            </div>
          </div>
          <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="lux-btn primary">保存新密码</button>
          </div>
        </form>
      </div>

      <div className="lux-card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="lux-card-h">
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <IconCircle tone="admin"><IconKey /></IconCircle>
            <div>
              <h3>连接码</h3>
              <p>LX Music 客户端连接同步服务器时使用的凭据</p>
            </div>
          </div>
        </div>
        <div style={{ padding: '8px 16px 16px', display: 'grid', gap: 12, flex: 1, alignContent: 'start' }}>
          <div style={{ background: 'var(--muted)', borderRadius: 14, padding: '12px 14px' }} className="lux-note">
            连接码不同于后台登录密码；重置后旧客户端需要重新填写。
          </div>
          {syncCode ? <Cassette value={syncCode} hint="已显示" /> : (
            <div style={{ background: 'var(--well)', borderRadius: 14, padding: '14px 16px' }} className="lux-note">连接码默认隐藏，点击下方按钮显示。</div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="lux-btn ghost" onClick={() => void toggleCode()}>
              {syncCode ? <><IconEyeOff />隐藏连接码</> : <><IconEye />显示我的连接码</>}
            </button>
            <button type="button" className="lux-btn primary" onClick={() => void resetCode()}>
              <IconSyncReset />重置我的同步连接码
            </button>
          </div>
          <div style={{ borderTop: '1px solid var(--divider)', margin: '2px -16px 0', padding: '12px 16px 0' }}>
            <div className="lux-eyebrow" style={{ marginBottom: 8 }}>在客户端中填写</div>
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'var(--muted)', borderRadius: 14, padding: '10px 12px' }}>
                <IconCircle tone="admin" size="xs"><IconWifi /></IconCircle>
                <div className="t">
                  <b style={{ fontSize: 13 }}>同步服务器地址</b>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--secondary-ink)' }}>{address || '见服务状态页'}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'var(--muted)', borderRadius: 14, padding: '10px 12px' }}>
                <IconCircle tone="admin" size="xs"><IconKey /></IconCircle>
                <div className="t">
                  <b style={{ fontSize: 13 }}>连接码</b>
                  <span style={{ fontSize: 12, color: 'var(--secondary-ink)' }}>粘贴上方连接码后在「设备与歌单」可见</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function StatusSection({
  status, devices, refresh, notify,
}: {
  status: AdminStatusResponse | null
  devices: Device[]
  refresh: () => Promise<void>
  notify: (message: string) => void
}) {
  const running = !!status?.status.status
  const addresses = status?.status.address || []
  const onlineDevices = status?.status.devices || []
  const doRefresh = async() => {
    try {
      await refresh()
      notify('状态已刷新')
    } catch (error) {
      notify(error instanceof Error ? error.message : '刷新失败')
    }
  }

  return (
    <div className="lux-stack">
      <div className="lux-card lg" style={{ padding: '16px 18px', display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <IconCircle tone="status" size="md"><IconPulse /></IconCircle>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="lux-eyebrow">同步服务器</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--title)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {running ? '运行中' : '未运行'}
            <DotPill tone={running ? 'ok' : 'off'}>status: {String(running)}</DotPill>
          </div>
          <div className="lux-note" style={{ marginTop: 2 }}>
            message：{status?.status.message || '同步服务器运行状态与管理对象统计'}
          </div>
        </div>
        <button type="button" className="lux-btn sm ghost" onClick={() => void doRefresh()}><IconRefresh />刷新状态</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
        <div className="lux-card lux-metric">
          <div className="top"><IconCircle tone="status"><IconStatusOk /></IconCircle></div>
          <div className="v" style={{ fontSize: 22 }}>{running ? '运行中' : '未运行'}</div>
          <div><div className="l">状态</div><div className="h">status.status</div></div>
        </div>
        <div className="lux-card lux-metric">
          <div className="top"><IconCircle tone="status"><IconUsers /></IconCircle></div>
          <div className="v">{status?.users ?? 0}</div>
          <div><div className="l">用户</div><div className="h">其中 managed {status?.managedUsers ?? 0}</div></div>
        </div>
        <div className="lux-card lux-metric">
          <div className="top"><IconCircle tone="status"><IconInvite /></IconCircle></div>
          <div className="v">{status?.invites ?? 0}</div>
          <div><div className="l">邀请码</div><div className="h">已保存的邀请入口</div></div>
        </div>
        <div className="lux-card lux-metric">
          <div className="top"><IconCircle tone="status"><IconDevices /></IconCircle></div>
          <div className="v">{onlineDevices.length}</div>
          <div><div className="l">在线设备</div><div className="h">当前保持连接</div></div>
        </div>
      </div>

      <div className="lux-page-split status-bottom">
        <div className="lux-card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="lux-card-h">
            <div><h3>地址</h3><p>客户端可用的同步服务器地址</p></div>
            <Pill tone="gray">{addresses.length} 个</Pill>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, Math.min(3, addresses.length || 1))}, 1fr)`, gap: 10, padding: '6px 14px 14px' }}>
            {!addresses.length ? <p className="lux-note">暂无地址</p> : addresses.map((addr, index) => (
              <div key={addr} style={{ background: 'var(--muted)', borderRadius: 16, padding: 14, display: 'grid', gap: 10, alignContent: 'start' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div className="lux-ic status" style={{ width: 36, height: 36, fontWeight: 700, fontSize: 13, color: '#065f46' }}>{index + 1}</div>
                  <DotPill>可用</DotPill>
                </div>
                <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--strong)', wordBreak: 'break-all' }}>{addr}</div>
                <div className="lux-note">{addressKind(addr)}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
          <div className="lux-card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div className="lux-card-h">
              <div><h3>在线设备</h3><p>当前保持连接的客户端</p></div>
              <DotPill>{onlineDevices.length}</DotPill>
            </div>
            <div className="lux-rows" style={{ flex: 1 }}>
              {!onlineDevices.length ? <p className="lux-note" style={{ padding: '12px 16px' }}>暂无在线设备</p> : onlineDevices.map((device, index) => (
                <div key={device.clientId || `${device.deviceName}-${index}`} className="lux-row">
                  <IconCircle tone="status">{device.isMobile ? <IconPhone /> : <IconLaptop />}</IconCircle>
                  <div className="t">
                    <b>{device.deviceName || 'Unknown'}</b>
                    <span>{device.isMobile ? '移动端' : '桌面端'} · {formatDate(device.lastConnectDate)}</span>
                  </div>
                  <Pill tone="ok">在线</Pill>
                </div>
              ))}
            </div>
          </div>
          <ChartCard title="在线 / 已授权" hint="服务状态在线 vs 本账号授权设备">
            <MetricTiles items={[
              { label: '在线', value: onlineDevices.length, tone: 'status', hint: '当前连接' },
              { label: '已授权', value: devices.length, tone: 'lime', hint: '本账号客户端' },
            ]} />
            <div style={{ marginTop: 12 }}>
              <CapsuleProgress
                label="在线占授权"
                used={onlineDevices.length}
                max={Math.max(devices.length, onlineDevices.length, 1)}
                suffix=" 台"
                tone="status"
              />
            </div>
          </ChartCard>
          <ChartCard title="在线连接时段" hint="按在线设备 lastConnectDate">
            <MiniColumns points={connectionHourBars(onlineDevices)} />
          </ChartCard>
        </div>
      </div>
    </div>
  )
}

function CreateUserForm({ refresh, notify }: { refresh: () => Promise<void>, notify: (message: string) => void }) {
  const [role, setRole] = useState<Role>('user')
  const submit = async(event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    try {
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
    } catch (error) {
      notify(error instanceof Error ? error.message : '创建失败')
    }
  }

  return (
    <div className="lux-card lux-create-panel">
      <form className="lux-create-bar" onSubmit={submit}>
        <div className="title">
          <IconCircle tone="admin"><IconUserPlus /></IconCircle>
          <div>
            <h3>创建用户</h3>
            <p>可登录后台并用于客户端同步</p>
          </div>
        </div>
        <Field label="用户名" name="username" required />
        <Field label="显示名（可选）" name="displayName" />
        <Field label="密码" name="password" type="password" required />
        <RoleSeg value={role} onChange={setRole} />
        <button type="submit" className="lux-btn primary" style={{ height: 40, padding: '0 18px' }}>创建</button>
      </form>
    </div>
  )
}

function UsersCard({ users, refresh, notify }: { users: UserView[], refresh: () => Promise<void>, notify: (message: string) => void }) {
  const [codes, setCodes] = useState<Record<string, string>>({})

  const toggleUser = async(user: UserView) => {
    try {
      await adminApi.updateUser(user.id, { status: user.status == 'active' ? 'disabled' : 'active' })
      await refresh()
    } catch (error) {
      notify(error instanceof Error ? error.message : '更新失败')
    }
  }

  const toggleCode = async(user: UserView) => {
    try {
      if (codes[user.id]) {
        setCodes(current => ({ ...current, [user.id]: '' }))
        return
      }
      const data = await adminApi.revealUserSyncCode(user.id)
      setCodes(current => ({ ...current, [user.id]: data.syncCode }))
      notify('连接码已显示')
    } catch (error) {
      notify(error instanceof Error ? error.message : '获取失败')
    }
  }

  const resetCode = async(user: UserView) => {
    try {
      const data = await adminApi.resetUserSyncCode(user.id)
      setCodes(current => ({ ...current, [user.id]: data.syncCode }))
      notify('连接码已重置')
    } catch (error) {
      notify(error instanceof Error ? error.message : '重置失败')
    }
  }

  return (
    <div className="lux-card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="lux-card-h">
        <div>
          <h3>用户管理</h3>
          <p>管理 managed 用户状态与同步连接码 · 共 {users.length} 人</p>
        </div>
        <button type="button" className="lux-btn sm ghost" onClick={() => void refresh()}><IconRefresh />刷新用户</button>
      </div>
      <div className="lux-rows" style={{ flex: 1, overflow: 'auto' }}>
        {!users.length ? <p className="lux-note" style={{ padding: '12px 16px' }}>暂无用户</p> : users.map(user => (
          <div key={user.id} className="lux-row" style={{ flexWrap: 'wrap', minHeight: 58, alignItems: 'flex-start' }}>
            <Avatar name={user.displayName || user.username} size={40} tone={user.role == 'admin' ? 'mine' : 'well'} />
            <div className="t">
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <b style={{ display: 'inline' }}>{user.displayName || user.username}</b>
                <span style={{ display: 'inline', color: 'var(--secondary-ink)', fontSize: 12, margin: '0 2px' }}>@{user.username}</span>
                <Pill tone={user.role == 'admin' ? 'mine' : 'gray'}>{roleLabel(user.role)}</Pill>
                <DotPill tone={user.status == 'active' ? 'ok' : 'off'}>{statusLabel(user.status)}</DotPill>
                <Pill tone="gray">{user.source}</Pill>
              </div>
              <div style={{ display: 'flex', gap: 12, fontSize: 12, marginTop: 4, color: 'var(--secondary-ink)' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: user.hasLoginPassword ? 'var(--secondary-ink)' : '#c2410c' }}>
                  {user.hasLoginPassword ? <IconCheck /> : <IconAlert />}
                  登录密码{user.hasLoginPassword ? '已设置' : '未设置'}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: user.hasSyncCode ? 'var(--secondary-ink)' : '#c2410c' }}>
                  {user.hasSyncCode ? <IconCheck /> : <IconAlert />}
                  连接码{user.hasSyncCode ? '已设置' : '未设置'}
                </span>
              </div>
            </div>
            {user.source == 'managed' ? (
              <div className="acts">
                <button type="button" className={user.status == 'active' ? 'lux-btn sm ghost' : 'lux-btn sm primary'} onClick={() => void toggleUser(user)}>
                  {user.status == 'active' ? '禁用' : '启用'}
                </button>
                <button type="button" className="lux-btn sm ghost" onClick={() => void toggleCode(user)}>
                  {codes[user.id] ? <><IconEyeOff />隐藏连接码</> : <><IconEye />显示连接码</>}
                </button>
                <button type="button" className="lux-btn sm ghost" onClick={() => void resetCode(user)}>
                  <IconSyncReset />重置连接码
                </button>
              </div>
            ) : (
              <div className="lux-note" style={{ textAlign: 'right' }}>配置文件/环境变量用户<br />不可在此显示或重置连接码</div>
            )}
            {codes[user.id] ? (
              <div style={{ flexBasis: 'calc(100% - 52px)', marginLeft: 52 }}>
                <Cassette value={codes[user.id]!} hint={`@${user.username} 的连接码`} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

export function UsersSection({
  users, refresh, notify,
}: {
  users: UserView[]
  refresh: () => Promise<void>
  notify: (message: string) => void
}) {
  return (
    <div className="lux-stack">
      <CreateUserForm refresh={refresh} notify={notify} />
      <div className="lux-page-split users">
        <UsersCard users={users} refresh={refresh} notify={notify} />
        <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
          <ChartCard title="用户看板" hint="列表本地聚合">
            <MetricTiles items={[
              { label: '全部', value: users.length, tone: 'lime' },
              { label: '管理员', value: users.filter(u => u.role == 'admin').length, tone: 'admin' },
              { label: '正常', value: users.filter(u => u.status == 'active').length, tone: 'status' },
              { label: '已禁用', value: users.filter(u => u.status == 'disabled').length, tone: 'muted' },
            ]} />
          </ChartCard>
          <ChartCard title="角色构成" hint="来自用户列表 role">
            <SegmentBar slices={userRoleSlices(users)} unit=" 人" />
          </ChartCard>
          <ChartCard title="状态构成" hint="来自用户列表 status">
            <SegmentBar slices={userStatusSlices(users)} unit=" 人" />
          </ChartCard>
          <ChartCard title="来源构成" hint="managed / config / env">
            <SegmentBar slices={userSourceSlices(users)} unit=" 人" />
          </ChartCard>
        </div>
      </div>
    </div>
  )
}

function CreateInviteForm({ refresh, notify }: { refresh: () => Promise<void>, notify: (message: string) => void }) {
  const [role, setRole] = useState<Role>('user')
  const [code, setCode] = useState('')
  const submit = async(event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    try {
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
    } catch (error) {
      notify(error instanceof Error ? error.message : '创建失败')
    }
  }

  return (
    <div className="lux-card lux-create-panel">
      <form className="lux-create-bar inv" onSubmit={submit}>
        <div className="title">
          <IconCircle tone="invites"><IconInvite /></IconCircle>
          <div>
            <h3>创建邀请码</h3>
            <p>原文只在创建后展示一次</p>
          </div>
        </div>
        <Field label="指定邀请码（可留空）" name="code" placeholder="留空则自动生成" />
        <RoleSeg value={role} onChange={setRole} />
        <Field label="最大使用次数" name="maxUses" type="number" required defaultValue={1} />
        <button type="submit" className="lux-btn primary" style={{ height: 40, padding: '0 18px' }}>创建邀请码</button>
        {code ? (
          <div style={{ background: '#fef9c3', borderRadius: 14, padding: '8px 10px', display: 'grid', gap: 6, minWidth: 180 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 10.5, fontWeight: 700, color: '#854d0e' }}>
              <IconAlert />只展示一次
            </div>
            <Cassette value={code} />
          </div>
        ) : <div />}
      </form>
    </div>
  )
}

function InvitesCard({ invites, refresh, notify }: { invites: Invite[], refresh: () => Promise<void>, notify: (message: string) => void }) {
  const toggle = async(invite: Invite) => {
    try {
      await adminApi.updateInvite(invite.id, { disabled: !invite.disabled })
      await refresh()
    } catch (error) {
      notify(error instanceof Error ? error.message : '更新失败')
    }
  }
  const remove = async(invite: Invite) => {
    try {
      await adminApi.deleteInvite(invite.id)
      notify('邀请码已删除')
      await refresh()
    } catch (error) {
      notify(error instanceof Error ? error.message : '删除失败')
    }
  }

  const statusOf = (invite: Invite) => {
    if (invite.disabled) return { tone: 'off' as const, label: '已禁用' }
    if (invite.usedCount >= invite.maxUses) return { tone: 'warn' as const, label: '已用完' }
    return { tone: 'ok' as const, label: '可用' }
  }

  return (
    <div className="lux-card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="lux-card-h">
        <div>
          <h3>邀请码管理</h3>
          <p>邀请码原文不会在列表中保存，只展示 ID 与状态</p>
        </div>
        <button type="button" className="lux-btn sm ghost" onClick={() => void refresh()}><IconRefresh />刷新邀请码</button>
      </div>
      <div className="lux-rows" style={{ flex: 1 }}>
        {!invites.length ? <p className="lux-note" style={{ padding: '12px 16px' }}>暂无邀请码</p> : invites.map(invite => {
          const st = statusOf(invite)
          const pct = invite.maxUses > 0 ? Math.min(100, Math.round((invite.usedCount / invite.maxUses) * 100)) : 0
          return (
            <div key={invite.id} className="lux-row" style={{ minHeight: 64 }}>
              <IconCircle tone="invites"><IconInvite /></IconCircle>
              <div className="t">
                <b className="mono" style={{ fontSize: 13 }}>{invite.id}</b>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 5, flexWrap: 'wrap' }}>
                  <Pill tone={invite.role == 'admin' ? 'mine' : 'gray'}>{roleLabel(invite.role)}</Pill>
                  <DotPill tone={st.tone}>{st.label}</DotPill>
                  <span className="lux-note">过期：{formatOptionalDate(invite.expiresAt)}</span>
                </div>
              </div>
              <div style={{ display: 'grid', gap: 5, justifyItems: 'end', marginRight: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--body)' }}>
                  {invite.usedCount} / {invite.maxUses}<span className="lux-note"> 次</span>
                </span>
                <div className="lux-progress"><i style={{ width: `${pct}%` }} /></div>
              </div>
              <div className="acts">
                <button type="button" className={invite.disabled ? 'lux-btn sm primary' : 'lux-btn sm ghost'} onClick={() => void toggle(invite)}>
                  {invite.disabled ? '启用' : '禁用'}
                </button>
                <button type="button" className="lux-iconbtn del" onClick={() => void remove(invite)} title="删除"><IconTrash /></button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function InvitesSection({
  invites, refresh, notify,
}: {
  invites: Invite[]
  refresh: () => Promise<void>
  notify: (message: string) => void
}) {
  const summary = useMemo(() => inviteUsageSummary(invites), [invites])
  return (
    <div className="lux-stack">
      <CreateInviteForm refresh={refresh} notify={notify} />
      <div className="lux-page-split invites">
        <InvitesCard invites={invites} refresh={refresh} notify={notify} />
        <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
          <ChartCard title="用量总览" hint="usedCount / maxUses 汇总">
            <MetricTiles items={[
              { label: '已使用', value: summary.totalUsed, tone: 'lime', hint: '次' },
              { label: '总配额', value: summary.totalMax, tone: 'nav', hint: '次' },
              { label: '可用', value: summary.available, tone: 'status', hint: '个码' },
              { label: '已用完', value: summary.exhausted, tone: 'invites', hint: '个码' },
            ]} />
            <div style={{ marginTop: 12 }}>
              <CapsuleProgress label="总用量进度" used={summary.totalUsed} max={Math.max(summary.totalMax, 1)} suffix=" 次" tone="lime" />
            </div>
          </ChartCard>
          <ChartCard title="各邀请码用量" hint="来自列表本地聚合">
            <UsageCapsules items={summary.bars} />
          </ChartCard>
        </div>
      </div>
    </div>
  )
}
