import assert from 'node:assert/strict'
import { it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { getAccountStore } from '../../../src/account/store'
import { setDeviceCommandTimeoutForTests, type DeviceCommand, type DeviceResult } from '../../../src/server/deviceCommands'
import { song } from '../fakes'
import { createFixture } from './fixture'
import { loginAndGetKey } from './client'

it('HTTP and SDK MCP commands target only capable owned WS peers, propagate ACKs, and share the command limit', { timeout: 30000 }, async t => {
  const fixture = await createFixture()
  const clients: Client[] = []
  setDeviceCommandTimeoutForTests(250)
  try {
    fixture.reset()
    const received: DeviceCommand[] = []
    let answer: DeviceResult | null = { ok: true, state: { playing: true } }
    const device = await fixture.connect('host', { command: async command => {
      received.push(command)
      return answer ?? new Promise(() => {})
    } })
    const old = await fixture.connect('member', {}, true, fixture.credentials.old)
    const other = await fixture.connect('member', { command: async() => { throw new Error('Foreign command') } })
    const store = getAccountStore()
    const pat = store.pats.create(fixture.users.host.id, 'Remote', ['player:control'], 'never')
    const member = store.pats.create(fixture.users.member.id, 'Remote member', ['player:control'], 'never')
    const denied = store.pats.create(fixture.users.host.id, 'Denied', ['playlist:read'], 'never')
    const http = async(route: string, body?: unknown, token = pat.token) => {
      const response = await fetch(fixture.baseUrl + '/api/v1/devices' + route, {
        method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: response.status, body: await response.json() as any }
    }
    const play = { type: 'play_song', payload: { song: song('one'), mode: 'now' } }
    const playback = { type: 'playback', payload: { action: 'pause' } }
    const listed = await http('')
    assert.equal(listed.status, 200); assert.equal(listed.body.items.length, 1)
    const id = listed.body.items[0].deviceId
    assert.equal(id, fixture.credentials.host.clientId)
    assert.equal(listed.body.items[0].name, 'Host device')
    assert.equal(listed.body.items[0].supportsCommands, true)
    assert.ok(listed.body.items[0].connectedAt > 0)
    assert.ok(device.handshake.some(h => h.method == 'getEnabledFeatures' && (h.args[1] as any)['device.command'] == 1))
    assert.deepEqual(await http(`/${encodeURIComponent(id)}/commands`, play), { status: 200, body: answer })
    assert.equal(received[0].type, 'play_song'); assert.deepEqual(received[0].payload, play.payload)
    assert.equal(received[0].expiresAt - received[0].issuedAt, 30000)
    answer = { ok: false, code: 'BUSY', message: 'Cannot play now' }
    assert.deepEqual(await http('/commands', playback), { status: 200, body: answer })
    answer = null
    const timeout = await http('/commands', play)
    assert.equal(timeout.status, 504); assert.equal(timeout.body.code, 'DEVICE_TIMEOUT')
    assert.equal((await http(`/${encodeURIComponent(fixture.credentials.member.clientId)}/commands`, play)).status, 404)
    assert.equal((await http('/unknown/commands', play)).status, 404)
    assert.equal((await http('', undefined, denied.token)).status, 403)
    assert.equal((await http('/commands', play, denied.token)).status, 403)
    const unsupported = await http(`/${encodeURIComponent(fixture.credentials.old.clientId)}/commands`, play, member.token)
    assert.equal(unsupported.status, 409); assert.equal(unsupported.body.code, 'DEVICE_UNSUPPORTED')
    assert.equal(old.frames.filter(f => f.path == 'device:command').length, 0)
    assert.equal(other.frames.filter(f => f.path == 'device:command').length, 0)
    const connect = async(token: string) => {
      const client = new Client({ name: 'device-e2e', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL(fixture.baseUrl + '/mcp'), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }))
      return client
    }
    const mcp = await connect(pat.token)
    answer = { ok: true }
    const result = await mcp.callTool({ name: 'play_on_device', arguments: { song: song('sdk') } })
    assert.ok(!result.isError); assert.deepEqual(JSON.parse((result.content as any)[0].text), answer)
    assert.deepEqual(received.at(-1)!.payload, { song: song('sdk'), mode: 'now' })
    assert.ok(!(await mcp.callTool({ name: 'list_devices', arguments: {} })).isError)
    const restricted = await connect(denied.token)
    for (const [name, args] of [['list_devices', {}], ['play_on_device', { song: song('sdk') }], ['control_playback', { action: 'pause' }]] as const) {
      assert.equal((await restricted.callTool({ name, arguments: args })).isError, true)
    }
    answer = { ok: false, code: 'BUSY', message: 'Busy' }
    assert.equal((await mcp.callTool({ name: 'control_playback', arguments: { action: 'pause', deviceId: id } })).isError, true)
    answer = { ok: true }
    for (let i = 0; i < 3; i++) assert.equal((await http('/commands', playback)).status, 200)
    const limited = await mcp.callTool({ name: 'control_playback', arguments: { action: 'pause' } })
    assert.equal(limited.isError, true); assert.match((limited.content as any)[0].text, /RATE_LIMITED/)
    const activity = store.pats.activity(pat.id, fixture.users.host.id)!
    assert.ok(activity.some(a => a.action == 'device.command' && a.summary == `play_song now ${song('one').name}` && a.ok))
    assert.ok(activity.every(a => !a.summary.includes('"meta"')))
    await device.close()
    const fresh = store.pats.create(fixture.users.host.id, 'Offline', ['player:control'], 'never')
    for (const route of [`/${encodeURIComponent(id)}/commands`, '/commands']) {
      const offline = await http(route, play, fresh.token)
      assert.equal(offline.status, 503); assert.equal(offline.body.code, 'DEVICE_OFFLINE')
    }
    const key = await loginAndGetKey(fixture.baseUrl, fixture.users.host.username, 'together-e2e-password', { deviceId: 'second', deviceName: 'Second' })
    const first = await fixture.connect('host', { command: async() => ({ ok: true, state: 'first' }) })
    const second = await fixture.connect('host', { command: async() => ({ ok: true, state: 'second' }) }, true, key)
    assert.deepEqual((await http('/commands', playback, fresh.token)).body, { ok: true, state: 'second' })
    const activeAt = Date.now() + 1000
    t.mock.method(Date, 'now', () => activeAt)
    await first.ping(Date.now())
    assert.deepEqual((await http('/commands', playback, fresh.token)).body, { ok: true, state: 'first' })
    await first.onFeatureChanged({ 'device.command': false })
    assert.deepEqual((await http('/commands', playback, fresh.token)).body, { ok: true, state: 'second' })
    assert.equal((await http(`/${encodeURIComponent(id)}/commands`, playback, fresh.token)).status, 409)
    assert.equal((await http('', undefined, fresh.token)).body.items.find((d: any) => d.deviceId == id).supportsCommands, false)
    await second.close()
  } finally {
    await Promise.all(clients.map(async client => client.close()))
    setDeviceCommandTimeoutForTests()
    await fixture.close()
  }
})
