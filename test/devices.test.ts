import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type http from 'node:http'
import type { FastifyInstance } from 'fastify'
import { getAccountStore } from '../src/account/store'
import { File, SYNC_CODE } from '../src/constants'
import { authConnect } from '../src/server/auth'
import { getUserDirname, getUserName, getUserSpace, releaseUserSpace, UserDataManage } from '../src/user'
import { toMD5 } from '../src/utils'
import { aesDecrypt, aesEncrypt, rsaDecrypt } from '../src/utils/tools'
import { parseJson, resetTestState } from './helpers'

let userNumber = 0
const rsaKeys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const publicKeyBody = rsaKeys.publicKey.split('\n').filter(line => line && !line.startsWith('-----')).join('')

const connectRequest = (clientId: string, key: string) => ({
  url: '/?' + new URLSearchParams({ i: clientId, t: aesEncrypt(SYNC_CODE.msgConnect, key) }),
  headers: {},
  socket: { remoteAddress: '127.0.0.1' },
}) as http.IncomingMessage

const storedClient = (clientId: string, patch: Partial<LX.Sync.KeyInfo> = {}): LX.Sync.KeyInfo => ({
  clientId,
  key: randomBytes(16).toString('base64'),
  deviceName: 'Same phone model',
  isMobile: true,
  lastConnectDate: 100,
  ...patch,
})

describe('device identity', () => {
  let app: FastifyInstance
  const users: string[] = []

  beforeEach(() => {
    app = resetTestState()
  })

  afterEach(async() => {
    await app.close()
    for (const username of users) releaseUserSpace(username, true)
    users.length = 0
  })

  const login = async(username: string) => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password: 'device-test-password' },
    })
    assert.equal(result.statusCode, 200, result.body)
    return parseJson(result.body).token as string
  }

  const createUser = async() => {
    const username = `devices-${++userNumber}`
    users.push(username)
    const user = await getAccountStore().createUser({ username, password: 'device-test-password', role: 'admin' })
    return { ...user, token: await login(username) }
  }

  const issueKey = (token: string, payload: Record<string, unknown>) => app.inject({
    method: 'POST',
    url: '/api/sync/key',
    headers: { authorization: `Bearer ${token}` },
    payload,
  })

  const devices = async(token: string, userId?: string) => {
    const result = await app.inject({
      method: 'GET',
      url: userId ? `/api/admin/users/${userId}/devices` : '/api/me/devices',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(result.statusCode, 200, result.body)
    return parseJson(result.body).devices as LX.Sync.KeyInfo[]
  }

  const authorizeByCode = async(username: string, deviceName: string, options: { deviceId?: string, publicKey?: string } = {}) => {
    const user = getAccountStore().findManagedUserByUsername(username)!
    const codeKey = Buffer.from(toMD5(user.lxSyncCode).substring(0, 16)).toString('base64')
    const lines = [SYNC_CODE.authMsg, options.publicKey ?? publicKeyBody, deviceName, 'lx_music_mobile']
    if (options.deviceId !== undefined) lines.push(options.deviceId)
    return app.inject({
      method: 'GET',
      url: '/ah',
      headers: { m: aesEncrypt(lines.join('\n'), codeKey) },
    })
  }

  const unpackKey = (body: string, privateKey = rsaKeys.privateKey) => JSON.parse(rsaDecrypt(Buffer.from(body, 'base64'), privateKey).toString()) as { clientId: string, key: string, serverName: string }

  const seedDevices = (username: string, clients: LX.Sync.KeyInfo[]) => {
    const userDir = path.join(global.lx.userPath, getUserDirname(username))
    fs.mkdirSync(userDir, { recursive: true })
    const file = path.join(userDir, File.userDevicesJSON)
    fs.writeFileSync(file, JSON.stringify({ userName: username, clients: Object.fromEntries(clients.map(client => [client.clientId, client])) }))
    return { userDir, file }
  }

  it('reuses one device across concurrent issuance, token rotation, rename and reload', async() => {
    const user = await createUser()
    const start = Date.now()
    const responses = await Promise.all(Array.from({ length: 12 }, () => issueKey(user.token, {
      deviceId: 'installation-1', deviceName: 'My phone', platform: 'lux_music_mobile',
    })))
    for (const response of responses) assert.equal(response.statusCode, 200, response.body)
    const keys = responses.map(response => parseJson(response.body))
    assert.equal(new Set(keys.map(key => key.clientId)).size, 1)
    assert.equal(new Set(keys.map(key => key.key)).size, 1)
    assert.equal(responses[0].headers['cache-control'], 'no-store')
    const first = (await devices(user.token))[0]
    assert.equal(first.isMobile, true)
    assert.ok(first.lastSeen! >= start)

    getAccountStore().invalidateSessions(user.id)
    const rotatedToken = await login(user.username)
    const renamed = await issueKey(rotatedToken, { deviceId: 'installation-1', deviceName: 'Renamed phone' })
    assert.equal(renamed.statusCode, 200, renamed.body)
    assert.equal(parseJson(renamed.body).clientId, keys[0].clientId)
    assert.equal(parseJson(renamed.body).key, keys[0].key)
    const listed = await devices(rotatedToken, user.id)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].deviceName, 'Renamed phone')
    assert.equal(listed[0].isMobile, true)
    assert.ok(listed[0].lastSeen! >= first.lastSeen!)

    releaseUserSpace(user.username, true)
    const reloaded = await issueKey(rotatedToken, { deviceId: 'installation-1' })
    assert.equal(parseJson(reloaded.body).clientId, keys[0].clientId)
    assert.equal(parseJson(reloaded.body).deviceName, 'Renamed phone')
    assert.equal((await devices(rotatedToken)).length, 1)
    await assert.doesNotReject(authConnect(connectRequest(keys[0].clientId, keys[0].key)))
  })

  it('keeps same-name installations and accounts separate, even with a foreign clientId', async() => {
    const alice = await createUser()
    const bob = await createUser()
    const first = parseJson((await issueKey(alice.token, { deviceId: 'phone-a', deviceName: 'iPhone' })).body)
    const second = parseJson((await issueKey(alice.token, { deviceId: 'phone-b', deviceName: 'iPhone' })).body)
    const otherAccount = await issueKey(bob.token, { deviceId: 'phone-a', clientId: first.clientId, deviceName: 'iPhone' })
    assert.equal(otherAccount.statusCode, 200, otherAccount.body)
    const third = parseJson(otherAccount.body)
    assert.equal(new Set([first.clientId, second.clientId, third.clientId]).size, 3)
    assert.equal(new Set([first.key, second.key, third.key]).size, 3)
    assert.equal((await devices(alice.token)).length, 2)
    assert.equal((await devices(bob.token)).length, 1)
    assert.equal(getUserName(first.clientId), alice.username)
    assert.equal(getUserName(third.clientId), bob.username)
  })

  it('reuses the old clientId and can attach a stable installation id to it', async() => {
    const user = await createUser()
    const original = parseJson((await issueKey(user.token, { deviceName: 'Old client' })).body)
    const fallback = await issueKey(user.token, { clientId: original.clientId, deviceName: 'Updated name' })
    assert.equal(parseJson(fallback.body).clientId, original.clientId)
    assert.equal(parseJson(fallback.body).key, original.key)
    const upgraded = await issueKey(user.token, { clientId: original.clientId, deviceId: 'stable-upgrade' })
    assert.equal(upgraded.statusCode, 200, upgraded.body)
    const reconnect = await issueKey(user.token, { deviceId: 'stable-upgrade' })
    assert.equal(parseJson(reconnect.body).clientId, original.clientId)
    assert.equal(parseJson(reconnect.body).deviceName, 'Updated name')
    assert.equal((await devices(user.token)).length, 1)
  })

  it('does not trust unknown clientIds or collapse anonymous clients just by name', async() => {
    const user = await createUser()
    const unknown = await issueKey(user.token, { clientId: 'unrecognized-client-id', deviceName: 'Phone' })
    assert.equal(unknown.statusCode, 200, unknown.body)
    const first = parseJson(unknown.body)
    assert.notEqual(first.clientId, 'unrecognized-client-id')
    const anonymous = await issueKey(user.token, { deviceName: 'Phone' })
    assert.equal(anonymous.statusCode, 200, anonymous.body)
    assert.notEqual(parseJson(anonymous.body).clientId, first.clientId)
    assert.equal((await devices(user.token)).length, 2)
  })

  it('rejects malformed and conflicting identities without creating extra records', async() => {
    const user = await createUser()
    for (const field of ['deviceId', 'clientId']) {
      for (const value of [null, 123, {}, [], '', '   ', 'a'.repeat(257)]) {
        const response = await issueKey(user.token, { [field]: value })
        assert.equal(response.statusCode, 400, `${field}=${JSON.stringify(value)}: ${response.body}`)
      }
    }
    assert.equal((await devices(user.token)).length, 0)
    const first = parseJson((await issueKey(user.token, { deviceId: 'identity-a' })).body)
    const second = parseJson((await issueKey(user.token, { deviceId: 'identity-b' })).body)
    for (const deviceId of ['identity-b', 'unknown-identity']) {
      const response = await issueKey(user.token, { deviceId, clientId: first.clientId })
      assert.equal(response.statusCode, 409, response.body)
    }
    assert.equal((await devices(user.token)).length, 2)
    assert.equal(getUserSpace(user.username).dataManage.getClientKeyInfo(second.clientId)?.deviceId, 'identity-b')
  })

  it('deduplicates legacy code authentication by normalized RSA key and preserves key authentication', async() => {
    const user = await createUser()
    const firstResponse = await authorizeByCode(user.username, 'Old phone name')
    assert.equal(firstResponse.statusCode, 200, firstResponse.body)
    const first = unpackKey(firstResponse.body)
    const secondResponse = await authorizeByCode(user.username, 'New phone name', {
      publicKey: publicKeyBody.match(/.{1,64}/g)!.join(' '),
    })
    assert.equal(secondResponse.statusCode, 200, secondResponse.body)
    const second = unpackKey(secondResponse.body)
    assert.equal(second.clientId, first.clientId)
    assert.equal(second.key, first.key)
    assert.equal(second.serverName, global.lx.config.serverName)
    assert.equal((await devices(user.token)).length, 1)

    const reconnect = await app.inject({
      method: 'GET', url: '/ah',
      headers: { i: first.clientId, m: aesEncrypt(SYNC_CODE.authMsg + 'Renamed in LX', first.key) },
    })
    assert.equal(reconnect.statusCode, 200, reconnect.body)
    assert.equal(aesDecrypt(reconnect.body, first.key), SYNC_CODE.helloMsg)
    const listed = await devices(user.token)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].deviceName, 'Renamed in LX')
    assert.ok(listed[0].lastSeen! > 0)
    await assert.doesNotReject(authConnect(connectRequest(first.clientId, first.key)))
  })

  it('honors the optional legacy deviceId and keeps explicit distinct identities separate', async() => {
    const user = await createUser()
    const rotatedKeys = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const first = await authorizeByCode(user.username, 'Phone', { deviceId: 'legacy-install-1' })
    const again = await authorizeByCode(user.username, 'Phone renamed', {
      deviceId: 'legacy-install-1',
      publicKey: rotatedKeys.publicKey.split('\n').filter(line => line && !line.startsWith('-----')).join(''),
    })
    const other = await authorizeByCode(user.username, 'Phone', { deviceId: 'legacy-install-2' })
    for (const response of [first, again, other]) assert.equal(response.statusCode, 200, response.body)
    assert.equal(unpackKey(again.body, rotatedKeys.privateKey).clientId, unpackKey(first.body).clientId)
    assert.equal(unpackKey(again.body, rotatedKeys.privateKey).key, unpackKey(first.body).key)
    assert.notEqual(unpackKey(other.body).clientId, unpackKey(first.body).clientId)
    assert.equal((await devices(user.token)).length, 2)
  })

  it('rejects malformed RSA authorization without persisting a phantom device', async() => {
    const user = await createUser()
    const response = await authorizeByCode(user.username, 'Invalid client', { publicKey: 'not-an-rsa-public-key' })
    assert.equal(response.statusCode, 401, response.body)
    assert.equal((await devices(user.token)).length, 0)
  })

  it('migrates strong duplicates conservatively and preserves all historical credentials after reload', async() => {
    const user = await createUser()
    const sharedKey = randomBytes(16).toString('base64')
    const clients = [
      storedClient('install-old', { deviceId: 'same-install', publicKeyHash: 'retired-fingerprint', deviceName: 'Old name', lastConnectDate: 100, lastSeen: 110 }),
      storedClient('install-new', { deviceId: 'same-install', publicKeyHash: 'current-fingerprint', deviceName: 'Newest name', isMobile: false, lastConnectDate: 200, lastSeen: 220 }),
      storedClient('rsa-old', { publicKeyHash: 'same-public-key', lastConnectDate: 120 }),
      storedClient('rsa-new', { publicKeyHash: 'same-public-key', lastConnectDate: 240 }),
      storedClient('aes-old', { key: sharedKey, lastConnectDate: 130 }),
      storedClient('aes-new', { key: sharedKey, lastConnectDate: 260 }),
      storedClient('name-only-a'), storedClient('name-only-b'),
      storedClient('distinct-a', { deviceId: 'distinct-install-a', publicKeyHash: 'same-public-key', key: sharedKey }),
      storedClient('distinct-b', { deviceId: 'distinct-install-b', publicKeyHash: 'same-public-key', key: sharedKey }),
    ]
    const { file } = seedDevices(user.username, clients)
    const store = new UserDataManage(user.username)
    assert.equal(store.getAllClientKeyInfo().length, 7)
    const merged = store.getAllClientKeyInfo().find(client => client.deviceId == 'same-install')!
    assert.equal(merged.deviceName, 'Newest name')
    assert.equal(merged.isMobile, false)
    assert.equal(merged.lastConnectDate, 200)
    assert.equal(merged.lastSeen, 220)
    assert.equal(store.getDeviceClientId('install-old'), store.getDeviceClientId('install-new'))
    assert.equal(store.getDeviceClientId('rsa-old'), store.getDeviceClientId('rsa-new'))
    assert.equal(store.getDeviceClientId('aes-old'), store.getDeviceClientId('aes-new'))
    assert.notEqual(store.getDeviceClientId('name-only-a'), store.getDeviceClientId('name-only-b'))
    assert.notEqual(store.getDeviceClientId('distinct-a'), store.getDeviceClientId('distinct-b'))
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).clients).length, 7)

    const reloaded = new UserDataManage(user.username)
    assert.equal(reloaded.getAllClientKeyInfo().length, 7)
    assert.deepEqual(new Set(reloaded.getDeviceClientIds('install-old')), new Set(['install-old', 'install-new']))
    for (const client of clients) {
      assert.equal(reloaded.getClientKeyInfo(client.clientId)?.key, client.key)
      assert.equal(getUserName(client.clientId), user.username)
      await assert.doesNotReject(authConnect(connectRequest(client.clientId, client.key)))
    }
    const original = clients[0]
    const apiReconnect = await issueKey(user.token, { clientId: original.clientId, deviceId: 'same-install' })
    assert.equal(apiReconnect.statusCode, 200, apiReconnect.body)
    assert.equal(parseJson(apiReconnect.body).clientId, original.clientId)
    assert.equal(parseJson(apiReconnect.body).key, original.key)
    assert.equal(parseJson(apiReconnect.body).deviceName, 'Newest name')
    const afterAliasApiReconnect = (await devices(user.token)).find(client => client.deviceId == 'same-install')!
    assert.equal(afterAliasApiReconnect.deviceName, 'Newest name')
    assert.equal(afterAliasApiReconnect.isMobile, false)
    const legacyReconnect = await app.inject({
      method: 'GET', url: '/ah',
      headers: { i: original.clientId, m: aesEncrypt(SYNC_CODE.authMsg + 'Alias reconnect', original.key) },
    })
    assert.equal(legacyReconnect.statusCode, 200, legacyReconnect.body)
    assert.equal(aesDecrypt(legacyReconnect.body, original.key), SYNC_CODE.helloMsg)
    const visible = await devices(user.token)
    assert.equal(visible.length, 7)
    assert.equal(visible.find(client => client.deviceId == 'same-install')?.deviceName, 'Alias reconnect')
    assert.equal(visible.find(client => client.deviceId == 'same-install')?.publicKeyHash, 'current-fingerprint')
    releaseUserSpace(user.username, true)
    const restarted = getUserSpace(user.username).dataManage
    assert.equal(restarted.getAllClientKeyInfo().find(client => client.deviceId == 'same-install')?.publicKeyHash, 'current-fingerprint')
    const fingerprintReconnect = restarted.upsertClientKeyInfo({ publicKeyHash: 'retired-fingerprint' })
    assert.equal(fingerprintReconnect.clientId, original.clientId)
    assert.equal(fingerprintReconnect.key, original.key)
    assert.equal(restarted.getAllClientKeyInfo().length, 7)
  })

  it('migrates at process startup and restores alias ownership before the first authentication', async() => {
    const user = await createUser()
    const clients = [
      storedClient('restart-old', { deviceId: 'restart-install', lastConnectDate: 1 }),
      storedClient('restart-new', { deviceId: 'restart-install', lastConnectDate: 2 }),
    ]
    const { file } = seedDevices(user.username, clients)
    const script = `
      const assert = require('node:assert/strict')
      global.lx.userPath = process.argv[1]
      global.lx.dataPath = process.argv[2]
      const username = process.argv[3]
      const clients = JSON.parse(process.argv[4])
      const { getUserName, getUserSpace } = require('./src/user')
      const { authConnect } = require('./src/server/auth')
      const { aesEncrypt } = require('./src/utils/tools')
      const { SYNC_CODE } = require('./src/constants')
      ;(async() => {
        for (const client of clients) {
          assert.equal(getUserName(client.clientId), username)
          await authConnect({
            url: '/?' + new URLSearchParams({ i: client.clientId, t: aesEncrypt(SYNC_CODE.msgConnect, client.key) }),
            headers: {}, socket: { remoteAddress: '127.0.0.1' },
          })
        }
        const store = getUserSpace(username).dataManage
        assert.equal(store.getAllClientKeyInfo().length, 1)
        for (const client of clients) assert.equal(store.getClientKeyInfo(client.clientId).key, client.key)
      })().catch(error => { console.error(error); process.exitCode = 1 })
    `
    const childEnv = { ...process.env }
    // This is an ordinary server process, not a node:test reporter child.
    delete childEnv.NODE_TEST_CONTEXT
    for (let restart = 0; restart < 2; restart++) {
      const result = spawnSync(process.execPath, [
        '--require', './test/register.cjs', '-e', script,
        global.lx.userPath, global.lx.dataPath, user.username, JSON.stringify(clients),
      ], { cwd: path.resolve(__dirname, '..'), env: childEnv, stdio: 'inherit', timeout: 20_000 })
      assert.ifError(result.error)
      assert.equal(result.status, 0, 'startup authentication failed in the fresh process')
      const persisted = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(Object.keys(persisted.clients).length, 1)
      assert.equal(Object.keys(persisted.clientAliases).length, 1)
    }
  })

  it('preserves embedded v1 snapshot cursors when startup deduplication precedes the v2 migration', () => {
    const dataPath = fs.mkdtempSync(path.join(global.lx.dataPath, 'device-v1-'))
    const userPath = path.join(dataPath, File.userDir)
    const username = 'legacy-device-migration'
    const userDir = path.join(userPath, getUserDirname(username))
    const oldSnapshotDir = path.join(userDir, File.listSnapshotDir)
    fs.mkdirSync(oldSnapshotDir, { recursive: true })
    fs.writeFileSync(path.join(dataPath, File.serverInfoJSON), JSON.stringify({ serverId: 'v1-migration-test', version: 1 }))
    const sharedKey = randomBytes(16).toString('base64')
    const clients = [
      { ...storedClient('v1-old', { key: sharedKey, deviceName: 'Old v1 name' }), lastConnectDate: undefined, lastSyncDate: 100, snapshotKey: 'old-baseline' },
      { ...storedClient('v1-new', { key: sharedKey, deviceName: 'Latest v1 name', isMobile: false }), lastConnectDate: undefined, lastSyncDate: 300, snapshotKey: 'new-baseline' },
    ]
    fs.writeFileSync(path.join(userDir, File.userDevicesJSON), JSON.stringify({
      userName: username, clients: Object.fromEntries(clients.map(client => [client.clientId, client])),
    }))
    fs.writeFileSync(path.join(userDir, File.listSnapshotInfoJSON), JSON.stringify({ latest: 'new-baseline', time: 300, list: ['old-baseline'] }))
    const snapshots = new Map(clients.map(client => [client.snapshotKey, JSON.stringify({
      defaultList: [], loveList: [], userList: [], testMarker: client.snapshotKey,
    })]))
    for (const [key, content] of snapshots) fs.writeFileSync(path.join(oldSnapshotDir, `snapshot_${key}`), content)

    const script = `
      const assert = require('node:assert/strict')
      const fs = require('node:fs')
      const path = require('node:path')
      global.lx.dataPath = process.argv[1]
      global.lx.userPath = process.argv[2]
      const username = process.argv[3]
      global.lx.config.users = [{ name: username, password: 'legacy-test' }]
      const clients = JSON.parse(process.argv[4])
      // Match startup ordering: user import deduplicates before v1 -> v2 runs.
      const { getUserDirname, getUserName, getUserSpace, getVersion } = require('./src/user')
      const userDir = path.join(global.lx.userPath, getUserDirname(username))
      const deviceFile = path.join(userDir, 'devices.json')
      const deduplicated = JSON.parse(fs.readFileSync(deviceFile, 'utf8'))
      assert.equal(Object.keys(deduplicated.clients).length, 1)
      assert.equal(Object.keys(deduplicated.clientAliases).length, 1)
      assert.equal(Object.values(deduplicated.clients)[0].deviceName, 'Latest v1 name')
      require('./src/utils/migrate').default(global.lx.dataPath, global.lx.userPath)
      assert.equal(getVersion(), 2)
      const migrated = JSON.parse(fs.readFileSync(deviceFile, 'utf8'))
      const credentials = [...Object.values(migrated.clients), ...Object.values(migrated.clientAliases)]
      for (const credential of credentials) {
        assert.equal('snapshotKey' in credential, false)
        assert.equal('lastSyncDate' in credential, false)
      }
      ;(async() => {
        const space = getUserSpace(username)
        const visible = space.dataManage.getAllClientKeyInfo()
        assert.equal(visible.length, 1)
        assert.equal(visible[0].deviceName, 'Latest v1 name')
        assert.equal(visible[0].isMobile, false)
        assert.equal(visible[0].lastConnectDate, 300)
        const info = await space.listManage.snapshotDataManage.getSnapshotInfo()
        for (const client of clients) {
          assert.equal(getUserName(client.clientId), username)
          assert.equal(space.dataManage.getClientKeyInfo(client.clientId).key, client.key)
          assert.equal(await space.listManage.getDeviceCurrentSnapshotKey(client.clientId), client.snapshotKey)
          assert.deepEqual(info.clients[client.clientId], { snapshotKey: client.snapshotKey, lastSyncDate: client.lastSyncDate })
        }
      })().catch(error => { console.error(error); process.exitCode = 1 })
    `
    const childEnv = { ...process.env }
    delete childEnv.NODE_TEST_CONTEXT
    try {
      const result = spawnSync(process.execPath, [
        '--require', './test/register.cjs', '-e', script, dataPath, userPath, username, JSON.stringify(clients),
      ], { cwd: path.resolve(__dirname, '..'), env: childEnv, stdio: 'inherit', timeout: 20_000 })
      assert.ifError(result.error)
      assert.equal(result.status, 0, 'legacy snapshot migration failed in the fresh process')
      assert.equal(fs.existsSync(oldSnapshotDir), false)
      assert.equal(fs.existsSync(path.join(userDir, File.listSnapshotInfoJSON)), false)
      for (const [key, content] of snapshots) {
        assert.equal(fs.readFileSync(path.join(userDir, File.listDir, File.listSnapshotDir, `snapshot_${key}`), 'utf8'), content)
      }
    } finally {
      fs.rmSync(dataPath, { recursive: true, force: true })
    }
  })

  it('preserves list/dislike snapshot references during migration and revokes every alias on removal', async() => {
    const user = await createUser()
    const clients = [
      storedClient('snapshot-old', { deviceId: 'snapshot-device', lastConnectDate: 1 }),
      storedClient('snapshot-new', { deviceId: 'snapshot-device', lastConnectDate: 2 }),
      storedClient('unrelated-client', { deviceId: 'unrelated-device' }),
    ]
    const { userDir } = seedDevices(user.username, clients)
    const initialFiles = new Map<string, string>()
    for (const module of ['list', 'dislike']) {
      const directory = path.join(userDir, module)
      fs.mkdirSync(path.join(directory, 'snapshot'), { recursive: true })
      const snapshotInfo = {
        latest: null, time: 42, list: ['old', 'new', 'unrelated'],
        clients: {
          'snapshot-old': { snapshotKey: 'old', lastSyncDate: 11 },
          'snapshot-new': { snapshotKey: 'new', lastSyncDate: 22 },
          'unrelated-client': { snapshotKey: 'unrelated', lastSyncDate: 33 },
        },
      }
      initialFiles.set(path.join(directory, 'snapshotInfo.json'), JSON.stringify(snapshotInfo))
      for (const key of snapshotInfo.list) {
        initialFiles.set(path.join(directory, 'snapshot', `snapshot_${key}`), module == 'list'
          ? JSON.stringify({ defaultList: [], loveList: [], userList: [] }) : `${key}@artist`)
      }
    }
    for (const [file, contents] of initialFiles) fs.writeFileSync(file, contents)
    const space = getUserSpace(user.username)
    assert.equal((await devices(user.token)).length, 2)
    for (const [file, contents] of initialFiles) assert.equal(fs.readFileSync(file, 'utf8'), contents)
    for (const manage of [space.listManage, space.dislikeManage]) {
      assert.equal(await manage.getDeviceCurrentSnapshotKey('snapshot-old'), 'old')
      assert.equal(await manage.getDeviceCurrentSnapshotKey('snapshot-new'), 'new')
    }
    releaseUserSpace(user.username, true)
    const reloaded = getUserSpace(user.username)
    const aliasReconnect = await issueKey(user.token, { clientId: 'snapshot-old', deviceId: 'snapshot-device' })
    assert.equal(aliasReconnect.statusCode, 200, aliasReconnect.body)
    assert.equal(parseJson(aliasReconnect.body).clientId, 'snapshot-old')
    assert.equal(parseJson(aliasReconnect.body).key, clients[0].key)
    for (const manage of [reloaded.listManage, reloaded.dislikeManage]) {
      assert.equal(await manage.getDeviceCurrentSnapshotKey('snapshot-old'), 'old')
      assert.equal(await manage.getDeviceCurrentSnapshotKey('snapshot-new'), 'new')
    }
    const removed = await app.inject({
      method: 'DELETE', url: '/api/me/devices/snapshot-old',
      headers: { authorization: `Bearer ${user.token}` },
    })
    assert.equal(removed.statusCode, 200, removed.body)
    assert.equal((await devices(user.token)).length, 1)
    for (const manage of [reloaded.listManage, reloaded.dislikeManage]) {
      assert.equal(await manage.getDeviceCurrentSnapshotKey('snapshot-old'), undefined)
      assert.equal(await manage.getDeviceCurrentSnapshotKey('snapshot-new'), undefined)
      assert.equal(await manage.getDeviceCurrentSnapshotKey('unrelated-client'), 'unrelated')
    }
    for (const client of clients.slice(0, 2)) {
      assert.equal(reloaded.dataManage.getClientKeyInfo(client.clientId), null)
      assert.equal(getUserName(client.clientId), null)
      await assert.rejects(authConnect(connectRequest(client.clientId, client.key)), /failed/)
    }
    await assert.doesNotReject(authConnect(connectRequest(clients[2].clientId, clients[2].key)))
    // Snapshot stores use a 100 ms write throttle; wait for their deletion to persist.
    await new Promise(resolve => setTimeout(resolve, 180))
    for (const module of ['list', 'dislike']) {
      const info = JSON.parse(fs.readFileSync(path.join(userDir, module, 'snapshotInfo.json'), 'utf8'))
      assert.deepEqual(Object.keys(info.clients), ['unrelated-client'])
    }
    releaseUserSpace(user.username, true)
    assert.equal(getUserSpace(user.username).dataManage.getClientKeyInfo('snapshot-old'), null)
    assert.equal(getUserSpace(user.username).dataManage.getClientKeyInfo('snapshot-new'), null)
  })
})
