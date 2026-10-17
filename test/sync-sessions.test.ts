import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID, generateKeyPairSync, privateDecrypt, constants } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { getAccountStore, initAccountStore } from '../src/account/store'
import { SYNC_CODE } from '../src/constants'
import { createModuleEvent } from '../src/event'
import { authConnect } from '../src/server/auth'
import { createApp } from '../src/server/app'
import { startServerForTests } from '../src/server/server'
import { getUserSpace, releaseUserSpace, UserDataManage } from '../src/user'
import { toMD5 } from '../src/utils'
import { syncLog } from '../src/utils/log4js'
import cache from '../src/utils/cache'
import { aesEncrypt } from '../src/utils/tools'
import { parseJson, resetTestState } from './helpers'
import { TogetherClient, type SyncCredentials } from './together/e2e/client'

const connectRequest = (key: SyncCredentials) => ({
  url: '/?' + new URLSearchParams({ i: key.clientId, t: aesEncrypt(SYNC_CODE.msgConnect, key.key) }),
  headers: {}, socket: { remoteAddress: '127.0.0.1' },
}) as IncomingMessage

describe('sync key session lifecycle', { concurrency: false, timeout: 15000 }, () => {
  let app: FastifyInstance
  let server: Awaited<ReturnType<typeof startServerForTests>>
  let username: string
  let userId: string
  let login: Record<string, any>
  let bound: SyncCredentials
  let legacy: SyncCredentials
  const clients: TogetherClient[] = []
  const headers = (token: string) => ({ authorization: `Bearer ${token}` })
  const post = (url: string, payload: any = {}, token = login.token) => app.inject({ method: 'POST', url, payload, headers: headers(token) })
  const issue = async(token: string, deviceId = randomUUID()) => {
    const res = await post('/api/sync/key', { deviceId }, token)
    assert.equal(res.statusCode, 200, res.body)
    return parseJson(res.body) as SyncCredentials
  }
  const authenticate = async(key: SyncCredentials, accepted: boolean) => {
    const res = await app.inject({ url: '/ah', headers: { i: key.clientId, m: aesEncrypt(SYNC_CODE.authMsg + 'Test', key.key) } })
    assert.equal(res.statusCode, accepted ? 200 : 401, res.body)
    if (accepted) await assert.doesNotReject(authConnect(connectRequest(key)))
    else await assert.rejects(authConnect(connectRequest(key)), /failed/)
  }
  const connect = async(key: SyncCredentials) => {
    const client = await TogetherClient.connect(`http://127.0.0.1:${server.port}`, key)
    clients.push(client)
    await client.waitReady()
    return client
  }
  const closed = async(client: TogetherClient) => client.waitFor(() => client.ws.readyState == WebSocket.CLOSED, 'revoked socket closed')
  const stored = (key: SyncCredentials) => getUserSpace(username).dataManage.getClientKeyInfo(key.clientId)

  before(async() => {
    app = resetTestState()
  })
  beforeEach(async() => {
    cache.clear()
    username = `sync-${randomUUID()}`
    userId = (await getAccountStore().createUser({ username, password: 'secret-pass' })).id
    login = parseJson((await post('/api/auth/login', { username, password: 'secret-pass', deviceId: 'phone' }, '')).body)
    bound = await issue(login.accessToken)
    legacy = await issue(login.token)
  })
  afterEach(async() => {
    await Promise.all(clients.splice(0).map(async client => client.close()))
    releaseUserSpace(username, true)
  })
  after(async() => { await server?.close(); await app?.close() })

  it('binds sid keys, keeps legacy keys working with one warning, and revokes only the logged-out key', async t => {
    const warnings: unknown[][] = []
    t.mock.method(syncLog, 'warn', (...args: unknown[]) => { warnings.push(args) })
    assert.equal(stored(bound)?.sessionId, login.sessionId)
    assert.equal(stored(bound)?.origin, 'account')
    assert.equal(stored(legacy)?.sessionId, undefined)
    assert.equal(stored(legacy)?.origin, 'account')
    await authenticate(legacy, true)
    assert.equal((await post('/api/auth/logout', {}, login.accessToken)).statusCode, 200)
    assert.equal(stored(bound), null)
    await authenticate(bound, false)
    await authenticate(legacy, true)
    const expected = `legacy sync key without session: ${legacy.clientId} user ${username}`
    assert.deepEqual(warnings, [[expected]])
    assert.equal(new UserDataManage(username).getClientKeyInfo(bound.clientId), null)
  })

  it('self-service session deletion invalidates access, refresh and bound sync authentication', async() => {
    await authenticate(bound, true)
    const response = await app.inject({ method: 'DELETE', url: `/api/me/sessions/${login.sessionId}`, headers: headers(login.accessToken) })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(parseJson(response.body), { ok: true })
    assert.equal((await app.inject({ url: '/api/auth/me', headers: headers(login.accessToken) })).statusCode, 401)
    assert.equal((await post('/api/auth/refresh', { refreshToken: login.refreshToken })).statusCode, 401)
    assert.equal(stored(bound), null)
    await authenticate(bound, false)
    await authenticate(legacy, true)
  })

  it('revoke-others deletes other session keys and preserves current and sessionless keys', async() => {
    const other = parseJson((await post('/api/auth/login', { username, password: 'secret-pass' })).body)
    const otherKey = await issue(other.accessToken)
    await authenticate(otherKey, true)
    const response = await post('/api/me/sessions/revoke-others', {}, login.accessToken)
    assert.equal(response.statusCode, 200)
    assert.deepEqual(parseJson(response.body), { ok: true, revoked: 1 })
    assert.equal(stored(otherKey), null)
    await authenticate(otherKey, false)
    await authenticate(bound, true)
    await authenticate(legacy, true)
  })

  it('legacy revoke-others deletes all session keys while preserving sessionless keys', async() => {
    const response = await post('/api/me/sessions/revoke-others')
    assert.equal(response.statusCode, 200)
    assert.deepEqual(parseJson(response.body), { ok: true, revoked: 1 })
    assert.equal(stored(bound), null)
    await authenticate(bound, false)
    await authenticate(legacy, true)
  })

  it('password change deletes both key types', async() => {
    const response = await post('/api/me/password', { oldPassword: 'secret-pass', password: 'new-pass', revokeOtherDevices: false })
    assert.equal(response.statusCode, 200, response.body)
    for (const key of [bound, legacy]) {
      assert.equal(stored(key), null)
      await authenticate(key, false)
    }
  })

  it('disable deletes all keys and re-enable cannot restore them', async() => {
    const store = getAccountStore()
    store.updateUser(userId, { status: 'disabled' })
    for (const key of [bound, legacy]) await authenticate(key, false)
    store.updateUser(userId, { status: 'active' })
    for (const key of [bound, legacy]) {
      assert.equal(stored(key), null)
      await authenticate(key, false)
    }
  })

  it('code reset removes code and historical sessionless keys, preserving the session key', async() => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString().split('\n').filter(line => line && !line.startsWith('-----')).join('')
    const codeKey = Buffer.from(toMD5(getAccountStore().getSyncCode(userId)).substring(0, 16)).toString('base64')
    const response = await app.inject({ url: '/ah', headers: { m: aesEncrypt(`${SYNC_CODE.authMsg}\n${publicKey}\nCode device\nlx_music_mobile`, codeKey) } })
    assert.equal(response.statusCode, 200)
    const code = JSON.parse(privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(response.body, 'base64')).toString()) as SyncCredentials
    assert.equal(stored(code)?.origin, 'code')
    // Simulate a pre-upgrade key with neither new optional field.
    const old = stored(legacy)!
    delete old.origin
    getUserSpace(username).dataManage.saveClientKeyInfo(old)
    assert.equal((await post('/api/me/sync-code/reset')).statusCode, 200)
    await authenticate(bound, true)
    for (const key of [legacy, code]) {
      assert.equal(stored(key), null)
      await authenticate(key, false)
    }
  })

  it('refresh replay revokes the session key immediately and preserves legacy auth', async() => {
    const refreshed = await post('/api/auth/refresh', { refreshToken: login.refreshToken })
    assert.equal(refreshed.statusCode, 200)
    assert.equal((await post('/api/auth/refresh', { refreshToken: login.refreshToken })).statusCode, 401)
    assert.equal(stored(bound), null)
    await authenticate(bound, false)
    await authenticate(legacy, true)
  })

  it('re-login on the same device and direct session revocation use the same deletion hook', async() => {
    assert.equal((await post('/api/auth/login', { username, password: 'secret-pass', deviceId: 'phone' })).statusCode, 200)
    assert.equal(stored(bound), null)
    await authenticate(bound, false)
    await authenticate(legacy, true)
    const other = getAccountStore().sessions.create(userId)
    const key = await issue(login.token)
    const info = stored(key)!
    info.sessionId = other.session.id
    getUserSpace(username).dataManage.saveClientKeyInfo(info)
    getAccountStore().sessions.revoke(other.session.id)
    assert.equal(stored(key), null)
  })

  it('rejects unknown and expired sessions at both key challenge and WS upgrade after reload', async() => {
    const info = stored(bound)!
    info.sessionId = 'unknown-session'
    getUserSpace(username).dataManage.saveClientKeyInfo(info)
    await authenticate(bound, false)
    process.env.LUX_REFRESH_TOKEN_TTL_DAYS = '0.000000000001'
    try {
      info.sessionId = getAccountStore().sessions.create(userId).session.id
    } finally { delete process.env.LUX_REFRESH_TOKEN_TTL_DAYS }
    getUserSpace(username).dataManage.saveClientKeyInfo(info)
    releaseUserSpace(username, true)
    initAccountStore(global.lx.dataPath)
    const oldApp = app
    app = createApp()
    await oldApp.close()
    await authenticate(bound, false)
    await authenticate(legacy, true)
  })

  it('revokes canonical and alias credentials independently, retaining surviving credentials after reload', async() => {
    const data = getUserSpace(username).dataManage
    const filename = data.devicesFilePath
    const original = stored(bound)!
    const devices = JSON.parse(fs.readFileSync(filename, 'utf8'))
    const alias = { ...stored(legacy)!, deviceId: original.deviceId, deviceClientId: bound.clientId }
    delete devices.clients[legacy.clientId]
    devices.clientAliases = { [legacy.clientId]: alias }
    fs.writeFileSync(filename, JSON.stringify(devices))
    releaseUserSpace(username, true)
    assert.equal(getUserSpace(username).dataManage.getDeviceClientId(legacy.clientId), bound.clientId)
    getAccountStore().sessions.revoke(login.sessionId)
    assert.equal(stored(bound), null)
    await authenticate(legacy, true)
    releaseUserSpace(username, true)
    assert.equal(stored(bound), null)
    await authenticate(legacy, true)
    assert.equal((await post('/api/me/sync-code/reset')).statusCode, 200)
    assert.equal(stored(legacy), null)
  })

  it('code reset promotes a surviving session alias instead of deleting its device group', async() => {
    const filename = getUserSpace(username).dataManage.devicesFilePath
    const devices = JSON.parse(fs.readFileSync(filename, 'utf8'))
    const canonical = stored(legacy)!
    devices.clientAliases = {
      [bound.clientId]: { ...stored(bound)!, deviceId: canonical.deviceId, deviceClientId: legacy.clientId },
    }
    delete devices.clients[bound.clientId]
    fs.writeFileSync(filename, JSON.stringify(devices))
    releaseUserSpace(username, true)
    assert.equal((await post('/api/me/sync-code/reset')).statusCode, 200)
    assert.equal(stored(legacy), null)
    releaseUserSpace(username, true)
    await authenticate(bound, true)
    getAccountStore().sessions.revokeUser(userId)
    assert.equal(stored(bound), null)
  })

  it('closes a real session socket on logout while the legacy socket stays open', async t => {
    createModuleEvent()
    try {
      server = await startServerForTests()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code != 'EPERM') throw error
      t.skip('Loopback TCP is blocked by this environment (EPERM); auth and HTTP cases run separately')
      return
    }
    const a = await connect(bound)
    const b = await connect(legacy)
    assert.equal((await post('/api/auth/logout', {}, login.accessToken)).statusCode, 200)
    await closed(a)
    assert.equal(b.ws.readyState, WebSocket.OPEN)
    await authenticate(bound, false)
    await authenticate(legacy, true)
  })

  it('keeps metadata and secrets out of user/admin device listings and admin status', async() => {
    await getAccountStore().createUser({ username: `admin-${randomUUID()}`, password: 'admin-pass', role: 'admin' })
    const admin = getAccountStore().getManagedUsers().find(user => user.role == 'admin')!
    const auth = parseJson((await post('/api/auth/login', { username: admin.username, password: 'admin-pass' })).body)
    for (const url of ['/api/me/devices', `/api/admin/users/${userId}/devices`, '/api/admin/status']) {
      const response = await app.inject({ url, headers: headers(url == '/api/me/devices' ? login.token : auth.token) })
      assert.equal(response.statusCode, 200)
      const body = parseJson(response.body)
      const devices = body.devices ?? body.status.devices
      for (const device of devices) {
        for (const field of ['sessionId', 'origin', 'key']) assert.equal(field in device, false)
      }
    }
    assert.equal((await post(`/api/admin/users/${userId}/sync-code/reset`, {}, auth.token)).statusCode, 200)
    await authenticate(bound, true)
    await authenticate(legacy, false)
    assert.equal((await post(`/api/admin/users/${userId}/password/reset`, { password: 'admin-reset' }, auth.token)).statusCode, 200)
    await authenticate(bound, false)
  })
})
