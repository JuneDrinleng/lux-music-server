import assert from 'node:assert/strict'
import { it } from 'node:test'
import { dispatchCommand, validateCommand, type DeviceCommand, type DeviceResult } from '../src/server/deviceCommands'
import { song } from './together/fakes'

const input = validateCommand({ type: 'playback', payload: { action: 'pause' } })
const peer = (run: (command: DeviceCommand) => Promise<DeviceResult>) => {
  const listeners = new Set<(error: Error) => void>()
  const socket = { isReady: true, readyState: 1, feature: { 'device.command': true },
    onClose: (handler: (error: Error) => void) => { listeners.add(handler); return () => { listeners.delete(handler) } },
    remote: { 'device:command': run } } as unknown as LX.Socket
  return { socket, listeners }
}
const code = (expected: string) => (error: any) => error.code == expected

it('dispatcher rejects offline/unsupported peers without sending and validates command payloads', async() => {
  let calls = 0
  const { socket } = peer(async() => { calls++; return { ok: true } })
  socket.isReady = false
  await assert.rejects(dispatchCommand(socket, input), code('DEVICE_OFFLINE'))
  socket.isReady = true; socket.feature['device.command'] = false
  await assert.rejects(dispatchCommand(socket, input), code('DEVICE_UNSUPPORTED'))
  assert.equal(calls, 0)
  for (const body of [{}, { type: 'playback', payload: { action: 'stop' } }, { type: 'play_song', payload: { song: {}, mode: 'now' } }]) {
    assert.throws(() => validateCommand(body), code('INVALID_REQUEST'))
  }
  assert.equal(validateCommand({ type: 'play_song', payload: { song: song('one'), mode: 'next' } }).type, 'play_song')
})
it('dispatcher enforces the ACK deadline, cleans listeners, and ignores late ACKs', async() => {
  let ack!: (result: DeviceResult) => void
  const { socket, listeners } = peer(async() => new Promise(resolve => { ack = resolve }))
  await assert.rejects(dispatchCommand(socket, input, 10), code('DEVICE_TIMEOUT'))
  assert.equal(listeners.size, 0)
  ack({ ok: true }); await Promise.resolve()
  assert.equal(listeners.size, 0)
})
it('dispatcher sets a 30 second TTL and rejects expired dispatches and expired ACKs', async() => {
  let now = 1000; let calls = 0
  const { socket } = peer(async command => {
    calls++
    assert.equal(command.issuedAt, 1000)
    assert.equal(command.expiresAt, 31000)
    now = 31000
    return { ok: true }
  })
  await assert.rejects(dispatchCommand(socket, input, 8000, () => now, -30000), code('DEVICE_TIMEOUT'))
  assert.equal(calls, 0)
  await assert.rejects(dispatchCommand(socket, input, 8000, () => now), code('DEVICE_TIMEOUT'))
})
it('concurrent commands on one peer keep distinct IDs and ACKs even in reverse order', async() => {
  const acks: Array<(result: DeviceResult) => void> = []; const ids: string[] = []
  const { socket, listeners } = peer(async command => {
    ids.push(command.id)
    return new Promise(resolve => { acks.push(resolve) })
  })
  const first = dispatchCommand(socket, input); const second = dispatchCommand(socket, input)
  assert.notEqual(ids[0], ids[1])
  acks[1]({ ok: false, code: 'BUSY', message: 'Busy' }); acks[0]({ ok: true, state: { playing: false } })
  assert.deepEqual(await first, { ok: true, state: { playing: false } })
  assert.deepEqual(await second, { ok: false, code: 'BUSY', message: 'Busy' })
  assert.equal(listeners.size, 0)
})
it('disconnect while waiting produces DEVICE_OFFLINE and malformed ACKs are rejected', async() => {
  const { socket, listeners } = peer(async() => new Promise(() => {}))
  const pending = dispatchCommand(socket, input)
  for (const listener of listeners) listener(new Error('closed'))
  listeners.clear()
  await assert.rejects(pending, code('DEVICE_OFFLINE'))
  assert.equal(listeners.size, 0)
  const bad = peer(async() => null as any)
  await assert.rejects(dispatchCommand(bad.socket, input), code('DEVICE_INVALID_ACK'))
})

it('HTTP commands distinguish owned offline devices from unknown and foreign devices, including base64 IDs and aliases', async t => {
  const { resetTestState } = await import('./helpers')
  const { getAccountStore } = await import('../src/account/store')
  const { getUserSpace, releaseUserSpace } = await import('../src/user')
  const server = await import('../src/server/server')
  const app = resetTestState()
  const username = 'offline-unit'; const otherUsername = 'offline-other'
  try {
    const store = getAccountStore()
    const user = await store.createUser({ username, password: 'offline-unit-password', role: 'admin' })
    await store.createUser({ username: otherUsername, password: 'offline-other-password', role: 'user' })
    const pat = store.pats.create(user.id, 'Offline', ['player:control'], 'never')
    const id = 'known/device+id=='
    const data = getUserSpace(username).dataManage
    const keyInfo = { clientId: id, key: 'unit-key', deviceId: 'installation', deviceName: 'Phone', isMobile: true, lastConnectDate: Date.now() + 1000 }
    data.saveClientKeyInfo(keyInfo)
    data.saveClientKeyInfo({ ...keyInfo, clientId: 'historical-client', lastConnectDate: 1 })
    // Reload through the real migration to group historical credentials.
    releaseUserSpace(username, true)
    const reloaded = getUserSpace(username).dataManage
    assert.equal(reloaded.getDeviceClientId('historical-client'), id)
    assert.equal(reloaded.getClientKeyInfo(id)!.clientId, id)
    getUserSpace(otherUsername).dataManage.saveClientKeyInfo({ ...keyInfo, clientId: 'foreign/device+id==' })
    const socket = peer(async() => ({ ok: true })).socket
    socket.userInfo = { name: username } as LX.UserConfig
    socket.keyInfo = reloaded.getClientKeyInfo('historical-client')!
    socket.connectedAt = socket.lastActiveAt = 1
    let connected = true
    t.mock.method(server, 'broadcastListClients', (handler: (socket: LX.Socket) => void) => { if (connected) handler(socket) })
    const headers = { authorization: `Bearer ${pat.token}` }
    const listed = await app.inject({ method: 'GET', url: '/api/v1/devices', headers })
    assert.equal(listed.json().items[0].deviceId, id)
    connected = false
    const command = (target: string) => app.inject({ method: 'POST', url: `/api/v1/devices/${target}/commands`, headers, payload: input })
    // A raw slash changes the route, reproducing the intermittent e2e 404.
    assert.equal((await command(id)).statusCode, 404)
    for (const [target, status, expected] of [
      [id, 503, 'DEVICE_OFFLINE'],
      ['historical-client', 503, 'DEVICE_OFFLINE'],
      ['unknown/device+id==', 404, 'NOT_FOUND'],
      ['foreign/device+id==', 404, 'NOT_FOUND'],
    ] as const) {
      const response = await command(encodeURIComponent(target))
      assert.equal(response.statusCode, status)
      assert.equal(response.json().code, expected)
    }
  } finally {
    releaseUserSpace(username, true)
    releaseUserSpace(otherUsername, true)
    await app.close()
  }
})

it('HTTP routes reuse the service for ownership, capability, scope, ACKs, auditing and command rate limits', async t => {
  const { resetTestState } = await import('./helpers')
  const { getAccountStore } = await import('../src/account/store')
  const server = await import('../src/server/server')
  const { setDeviceCommandTimeoutForTests } = await import('../src/server/deviceCommands')
  const app = resetTestState()
  setDeviceCommandTimeoutForTests(10)
  try {
    const store = getAccountStore()
    const user = await store.createUser({ username: 'remote-unit', password: 'remote-unit-password', role: 'admin' })
    const pat = store.pats.create(user.id, 'Remote', ['player:control'], 'never')
    const denied = store.pats.create(user.id, 'Denied', ['playlist:read'], 'never')
    const ready = peer(async() => ({ ok: true, state: 'playing' })).socket
    const old = peer(async() => { throw new Error('Old peer received command') }).socket
    const foreign = peer(async() => { throw new Error('Foreign peer received command') }).socket
    for (const [index, socket] of [ready, old, foreign].entries()) {
      socket.userInfo = { name: index == 2 ? 'someone-else' : user.username } as LX.UserConfig
      socket.keyInfo = { clientId: `peer-${index}`, deviceName: `Peer ${index}` } as LX.Sync.KeyInfo
      socket.connectedAt = socket.lastActiveAt = index + 1
    }
    old.feature['device.command'] = false
    t.mock.method(server, 'broadcastListClients', (handler: (socket: LX.Socket) => void) => { [ready, old, foreign].forEach(handler) })
    const http = async(route: string, body?: unknown, token = pat.token) => {
      const response = await app.inject({ method: body === undefined ? 'GET' : 'POST', url: '/api/v1/devices' + route,
        headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { payload: body as any }) })
      return { status: response.statusCode, body: response.json() }
    }
    const listed = await http('')
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.items.map((d: any) => [d.deviceId, d.supportsCommands]), [['peer-1', false], ['peer-0', true]])
    assert.deepEqual(await http('/commands', input), { status: 200, body: { ok: true, state: 'playing' } })
    ready.remote['device:command'] = async() => ({ ok: false, code: 'BUSY', message: 'Busy' })
    assert.deepEqual(await http('/peer-0/commands', input), { status: 200, body: { ok: false, code: 'BUSY', message: 'Busy' } })
    assert.equal((await http('/peer-1/commands', input)).status, 409)
    assert.equal((await http('/peer-2/commands', input)).status, 404)
    assert.equal((await http('/commands', input, denied.token)).status, 403)
    ready.remote['device:command'] = async() => new Promise(() => {})
    assert.equal((await http('/commands', input)).status, 504)
    ready.remote['device:command'] = async() => ({ ok: true })
    for (let i = 0; i < 5; i++) assert.equal((await http('/commands', input)).status, 200)
    assert.equal((await http('/commands', input)).status, 429)
    assert.ok(store.pats.activity(pat.id, user.id)!.some(a => a.action == 'device.command' && a.summary == 'playback pause' && a.ok))
  } finally { setDeviceCommandTimeoutForTests(); await app.close() }
})
