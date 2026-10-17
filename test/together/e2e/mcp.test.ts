import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { getAccountStore } from '../../../src/account/store'
import { getUserSpace } from '../../../src/user'
import { song } from '../fakes'
import { createFixture, type Fixture } from './fixture'

describe('Streamable HTTP MCP', { concurrency: false, timeout: 30000 }, () => {
  let fixture: Fixture
  const clients: Client[] = []
  before(async() => { process.env.LUX_PUBLIC_URL = 'https://lux.example.com'; fixture = await createFixture(); fixture.reset() })
  after(async() => { await Promise.all(clients.map(async c => c.close())); await fixture?.close(); delete process.env.LUX_PUBLIC_URL })
  const token = (scopes: any = ['history:read', 'playlist:read', 'playlist:write'], member = false) =>
    getAccountStore().pats.create(fixture.users[member ? 'member' : 'host'].id, 'MCP test', scopes, 'never')
  const connect = async(pat = token(), origin?: string) => {
    const client = new Client({ name: 'e2e', version: '1' })
    clients.push(client)
    const responses: Array<{ method?: string, status: number, headers: Headers }> = []
    const transport = new StreamableHTTPClientTransport(new URL(fixture.baseUrl + '/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${pat.token}`, ...(origin ? { origin } : {}) } },
      fetch: async(url, init) => {
        const response = await fetch(url, init)
        responses.push({ method: init?.method, status: response.status, headers: response.headers })
        return response
      },
    })
    await client.connect(transport)
    return { client, transport, pat, responses }
  }
  const raw = async(auth?: string, method = 'POST', sessionId?: string, origin?: string) => fetch(fixture.baseUrl + '/mcp', {
    method, headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(sessionId ? { 'mcp-session-id': sessionId } : {}), ...(origin ? { origin } : {}) },
    ...(method == 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }) } : {}),
  })
  const result = async(client: Client, name: string, args = {}) => {
    const data = await client.callTool({ name, arguments: args })
    assert.ok(!data.isError, JSON.stringify(data))
    return JSON.parse((data.content as any)[0].text)
  }
  it('initializes, lists schemas and reuses data services with live same-user WS sync and activity', async() => {
    const device = await fixture.connect('host', { list: true })
    const other = await fixture.connect('member', { list: true })
    const { client, transport, pat, responses } = await connect()
    assert.ok(transport.sessionId)
    assert.deepEqual(client.getServerVersion(), { name: 'lux-music', version: require('../../../package.json').version })
    const tools = (await client.listTools()).tools
    assert.deepEqual(tools.map(t => t.name).sort(), ['add_songs_to_playlist', 'control_playback', 'create_playlist', 'get_listening_history', 'get_playlist', 'get_top_tracks', 'list_devices', 'list_playlists', 'play_on_device'])
    assert.equal(tools.find(t => t.name == 'create_playlist')!.inputSchema.type, 'object')
    assert.equal((await result(client, 'list_playlists')).items[0].id, 'default')
    const created = await result(client, 'create_playlist', { name: 'MCP mix', songs: [song('one')] })
    await device.waitFor(() => device.handshake.filter(h => h.method == 'onListSyncAction').length >= 2, 'MCP playlist pushes')
    assert.deepEqual(device.handshake.filter(h => h.method == 'onListSyncAction').map(h => (h.args[0] as any).action), ['list_create', 'list_music_add'])
    assert.equal(other.handshake.filter(h => h.method == 'onListSyncAction').length, 0)
    assert.deepEqual(await result(client, 'add_songs_to_playlist', { playlistId: created.id, songs: [song('two')] }), { added: 1, skipped: 0 })
    assert.equal((await result(client, 'get_playlist', { playlistId: created.id, offset: 0, limit: 1 })).total, 2)
    await getUserSpace(fixture.users.host.username).playHistoryManage.push({ records: [{ id: 'mcp:1000', deviceId: 'mcp', startedAt: 1000,
      endedAt: 1100, listenedMs: 100, song: { source: 'kw', songmid: 'one', name: 'One', singer: 'Singer' } }] })
    assert.equal((await result(client, 'get_listening_history', { from: '1000', to: '1100', limit: 1 })).items[0].id, 'mcp:1000')
    assert.equal((await result(client, 'get_top_tracks')).items[0].playCount, 1)
    assert.equal((await client.callTool({ name: 'create_playlist', arguments: { name: '' } })).isError, true)
    const activity = getAccountStore().pats.activity(pat.id, fixture.users.host.id)!
    assert.ok(activity.some(a => a.action == 'mcp.create_playlist' && a.ok))
    assert.ok(activity.some(a => a.action == 'mcp.create_playlist' && !a.ok))
    const stream = responses.find(r => r.method == 'GET' && r.status == 200)
    assert.ok(stream, 'SDK opened a standalone SSE stream')
    assert.match(stream.headers.get('content-type')!, /text\/event-stream/)
    assert.equal(stream.headers.get('x-accel-buffering'), 'no')
    assert.match(stream.headers.get('cache-control')!, /no-cache/)
    const id = transport.sessionId
    await transport.terminateSession()
    const ended = await raw(pat.token, 'POST', id)
    assert.equal(ended.status, 404); await ended.text()
  })
  it('rejects missing/bad/revoked tokens on every method and binds sessions to one token and user', async() => {
    for (const method of ['POST', 'GET', 'DELETE']) for (const auth of [undefined, 'bad']) {
      const response = await raw(auth, method)
      assert.equal(response.status, 401)
      assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="lux-music", error="invalid_token"')
      await response.text()
    }
    const { client, transport, pat } = await connect()
    for (const alien of [token(), token(undefined, true)]) {
      const response = await raw(alien.token, 'POST', transport.sessionId)
      assert.equal(response.status, 403); await response.text()
    }
    assert.ok((await client.listTools()).tools.length)
    getAccountStore().pats.revoke(pat.id, fixture.users.host.id)
    await assert.rejects(client.listTools(), /401|Unauthorized/)
    for (const method of ['GET', 'DELETE']) {
      const response = await raw(pat.token, method, transport.sessionId)
      assert.equal(response.status, 401); await response.text()
    }
  })
  it('returns tool errors for missing scopes; rejects foreign/malformed origins and accepts configured/loopback origins', async() => {
    const { client, pat } = await connect(token(['playlist:read']))
    for (const name of ['create_playlist', 'get_listening_history']) {
      const response = await client.callTool({ name, arguments: name == 'create_playlist' ? { name: 'denied' } : {} })
      assert.equal(response.isError, true)
      assert.match((response.content as any)[0].text, /Missing required scope/)
    }
    assert.ok(getAccountStore().pats.activity(pat.id, fixture.users.host.id)!.every(a => !a.ok))
    for (const origin of ['https://evil.example', 'null', 'http://localhost.evil', 'https://lux.example.com/path']) {
      const response = await raw(pat.token, 'POST', undefined, origin)
      assert.equal(response.status, 403); await response.text()
    }
    for (const origin of ['https://lux.example.com', 'http://localhost:1234', 'http://127.0.0.1:1234']) {
      const connected = await connect(token(), origin)
      assert.ok((await connected.client.listTools()).tools.length)
      await connected.transport.terminateSession()
    }
  })
  it('shares the per-token HTTP rate limit with /api/v1 and expires idle sessions', async t => {
    const { transport, pat } = await connect()
    const now = Date.now()
    t.mock.method(Date, 'now', () => now)
    for (let i = 0; i < 60; i++) {
      const response = await fetch(fixture.baseUrl + '/api/v1/token/whoami', { headers: { authorization: `Bearer ${pat.token}` } })
      await response.text()
      if (response.status == 429) break
    }
    const limited = await raw(pat.token, 'POST', transport.sessionId)
    assert.equal(limited.status, 429); await limited.text()
    t.mock.method(Date, 'now', () => now + 31 * 60000)
    const expired = await raw(pat.token, 'POST', transport.sessionId)
    assert.equal(expired.status, 404); await expired.text()
  })
})
