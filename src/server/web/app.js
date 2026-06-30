const $ = selector => document.querySelector(selector)
const tokenKey = 'lux_sync_admin_token'
let token = localStorage.getItem(tokenKey) || ''
let me = null
let bootstrapVisible = false

const show = (el, visible = true) => { el.classList.toggle('hidden', !visible) }
const message = text => {
  const el = $('#message')
  el.textContent = text
  show(el, true)
  clearTimeout(message.timer)
  message.timer = setTimeout(() => { show(el, false) }, 3200)
}

const api = async(path, options = {}) => {
  const headers = { ...(options.headers || {}) }
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(path, { ...options, headers })
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (!res.ok) throw new Error(data.message || res.statusText)
  return data
}

const formData = form => Object.fromEntries(new FormData(form).entries())

const renderAuthState = () => {
  show($('#authPanel'), !me && !bootstrapVisible)
  show($('#bootstrapPanel'), !me && bootstrapVisible)
  show($('#dashboard'), !!me)
  show($('#logoutBtn'), !!me)
  if (!me) return
  $('#welcomeTitle').textContent = `欢迎，${me.displayName || me.username}`
  $('#userMeta').textContent = `${me.username} · ${me.role === 'admin' ? '管理员' : '用户'} · ${me.status}`
  show($('#adminPanel'), me.role === 'admin')
}

const checkBootstrap = async() => {
  if (token) {
    bootstrapVisible = false
    return
  }
  try {
    const data = await api('/api/auth/bootstrap')
    bootstrapVisible = !!(data.needsAdmin && data.allowed)
  } catch {
    bootstrapVisible = false
  }
}

const loadMe = async() => {
  await checkBootstrap()
  if (!token) {
    me = null
    renderAuthState()
    return
  }
  try {
    const data = await api('/api/auth/me')
    me = data.user
    renderAuthState()
    await Promise.all([loadDevices(), loadPlaylists(), me.role === 'admin' ? loadAdmin() : Promise.resolve()])
  } catch {
    token = ''
    localStorage.removeItem(tokenKey)
    me = null
    renderAuthState()
  }
}

const loadDevices = async() => {
  const root = $('#devicesList')
  root.textContent = '加载中...'
  const data = await api('/api/me/devices')
  if (!data.devices.length) {
    root.textContent = '暂无设备'
    return
  }
  root.innerHTML = data.devices.map(device => `
    <div class="item">
      <h3>${device.deviceName || 'Unknown'}</h3>
      <p>clientId: ${device.clientId}</p>
      <p>类型: ${device.isMobile ? '移动端' : '桌面端'} · 最后连接: ${device.lastConnectDate ? new Date(device.lastConnectDate).toLocaleString() : '从未连接'}</p>
      <div class="actions"><button class="danger" data-remove-device="${encodeURIComponent(device.clientId)}">删除设备</button></div>
    </div>
  `).join('')
}

const loadPlaylists = async() => {
  const root = $('#playlistsList')
  root.textContent = '加载中...'
  const data = await api('/api/me/playlists')
  const lists = [data.playlists.defaultList, data.playlists.loveList, ...data.playlists.userList]
  root.innerHTML = lists.map(list => `
    <div class="item">
      <h3>${list.name}</h3>
      <p>ID: ${list.id || 'N/A'} · 歌曲数: ${list.musicCount}</p>
      ${list.source ? `<p>来源: ${list.source} / ${list.sourceListId || ''}</p>` : ''}
    </div>
  `).join('')
}

const loadAdminStatus = async() => {
  const data = await api('/api/admin/status')
  $('#adminStatus').innerHTML = `
    <div class="item">
      <h3>${data.status.status ? '运行中' : '未运行'}</h3>
      <p>用户数: ${data.users} · managed: ${data.managedUsers} · 邀请码: ${data.invites}</p>
      <p>地址: ${(data.status.address || []).join(', ') || 'N/A'}</p>
      <p>在线设备: ${(data.status.devices || []).length}</p>
    </div>
  `
}

const loadUsers = async() => {
  const root = $('#usersList')
  root.textContent = '加载中...'
  const data = await api('/api/admin/users')
  root.innerHTML = data.users.map(user => `
    <div class="item">
      <h3>${user.displayName || user.username}</h3>
      <p>${user.username} · ${user.role} · ${user.status} · ${user.source}</p>
      <p>登录密码: ${user.hasLoginPassword ? '已设置' : '未设置'} · 连接码: ${user.hasSyncCode ? '已设置' : '未设置'}</p>
      ${user.source === 'managed' ? `<div class="actions">
        <button data-toggle-user="${user.id}" data-status="${user.status === 'active' ? 'disabled' : 'active'}">${user.status === 'active' ? '禁用' : '启用'}</button>
        <button data-reset-user-code="${user.id}">重置连接码</button>
      </div>` : '<p>配置文件/环境变量用户不可在此删除。</p>'}
    </div>
  `).join('')
}

const loadInvites = async() => {
  const root = $('#invitesList')
  root.textContent = '加载中...'
  const data = await api('/api/admin/invites')
  if (!data.invites.length) {
    root.textContent = '暂无邀请码'
    return
  }
  root.innerHTML = data.invites.map(invite => `
    <div class="item">
      <h3>${invite.role} · ${invite.disabled ? '已禁用' : '可用'}</h3>
      <p>使用: ${invite.usedCount}/${invite.maxUses} · 过期: ${invite.expiresAt ? new Date(invite.expiresAt).toLocaleString() : '不过期'}</p>
      <p>ID: ${invite.id}</p>
      <div class="actions">
        <button data-toggle-invite="${invite.id}" data-disabled="${!invite.disabled}">${invite.disabled ? '启用' : '禁用'}</button>
        <button class="danger" data-delete-invite="${invite.id}">删除</button>
      </div>
    </div>
  `).join('')
}

const loadAdmin = async() => Promise.all([loadAdminStatus(), loadUsers(), loadInvites()])

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault()
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(formData(event.currentTarget)) })
    token = data.token
    localStorage.setItem(tokenKey, token)
    me = data.user
    message('登录成功')
    renderAuthState()
    await loadMe()
  } catch (err) { message(err.message) }
})

$('#registerForm').addEventListener('submit', async event => {
  event.preventDefault()
  try {
    await api('/api/auth/register', { method: 'POST', body: JSON.stringify(formData(event.currentTarget)) })
    event.currentTarget.reset()
    message('注册成功，请登录')
  } catch (err) { message(err.message) }
})

$('#bootstrapForm').addEventListener('submit', async event => {
  event.preventDefault()
  try {
    await api('/api/auth/bootstrap', { method: 'POST', body: JSON.stringify(formData(event.currentTarget)) })
    event.currentTarget.reset()
    bootstrapVisible = false
    renderAuthState()
    message('管理员已创建，请登录')
  } catch (err) { message(err.message) }
})

$('#logoutBtn').addEventListener('click', () => {
  token = ''
  me = null
  localStorage.removeItem(tokenKey)
  renderAuthState()
})

$('#refreshBtn').addEventListener('click', () => { void loadMe() })
$('#loadDevicesBtn').addEventListener('click', () => { void loadDevices().catch(err => message(err.message)) })
$('#loadPlaylistsBtn').addEventListener('click', () => { void loadPlaylists().catch(err => message(err.message)) })
$('#loadAdminStatusBtn').addEventListener('click', () => { void loadAdminStatus().catch(err => message(err.message)) })
$('#loadUsersBtn').addEventListener('click', () => { void loadUsers().catch(err => message(err.message)) })
$('#loadInvitesBtn').addEventListener('click', () => { void loadInvites().catch(err => message(err.message)) })

$('#changePasswordForm').addEventListener('submit', async event => {
  event.preventDefault()
  try {
    await api('/api/me/password', { method: 'POST', body: JSON.stringify(formData(event.currentTarget)) })
    event.currentTarget.reset()
    message('密码已更新，请重新登录')
  } catch (err) { message(err.message) }
})

$('#resetMySyncCodeBtn').addEventListener('click', async() => {
  try {
    const data = await api('/api/me/sync-code/reset', { method: 'POST' })
    $('#mySyncCode').textContent = data.syncCode
    show($('#mySyncCode'), true)
    message('连接码已重置')
  } catch (err) { message(err.message) }
})

$('#createUserForm').addEventListener('submit', async event => {
  event.preventDefault()
  try {
    await api('/api/admin/users', { method: 'POST', body: JSON.stringify(formData(event.currentTarget)) })
    event.currentTarget.reset()
    message('用户已创建')
    await loadUsers()
  } catch (err) { message(err.message) }
})

$('#createInviteForm').addEventListener('submit', async event => {
  event.preventDefault()
  const data = formData(event.currentTarget)
  data.maxUses = Number(data.maxUses || 1)
  try {
    const result = await api('/api/admin/invites', { method: 'POST', body: JSON.stringify(data) })
    $('#newInviteCode').textContent = result.code
    show($('#newInviteCode'), true)
    event.currentTarget.reset()
    message('邀请码已创建')
    await loadInvites()
  } catch (err) { message(err.message) }
})

document.addEventListener('click', async event => {
  const target = event.target.closest('button')
  if (!target) return
  try {
    if (target.dataset.removeDevice) {
      await api(`/api/me/devices/${target.dataset.removeDevice}`, { method: 'DELETE' })
      await loadDevices()
      message('设备已删除')
    } else if (target.dataset.toggleUser) {
      await api(`/api/admin/users/${target.dataset.toggleUser}`, { method: 'PATCH', body: JSON.stringify({ status: target.dataset.status }) })
      await loadUsers()
    } else if (target.dataset.resetUserCode) {
      const data = await api(`/api/admin/users/${target.dataset.resetUserCode}/sync-code/reset`, { method: 'POST' })
      message(`新连接码：${data.syncCode}`)
    } else if (target.dataset.toggleInvite) {
      await api(`/api/admin/invites/${target.dataset.toggleInvite}`, { method: 'PATCH', body: JSON.stringify({ disabled: target.dataset.disabled === 'true' }) })
      await loadInvites()
    } else if (target.dataset.deleteInvite) {
      await api(`/api/admin/invites/${target.dataset.deleteInvite}`, { method: 'DELETE' })
      await loadInvites()
    }
  } catch (err) { message(err.message) }
})

void loadMe()
