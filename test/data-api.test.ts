import assert from 'node:assert/strict'
import fs from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import { after, before, describe, it } from 'node:test'
import { getAccountStore, initAccountStore } from '../src/account/store'
import { recordTokenActivity } from '../src/account/tokenActivity'
import { getUserSpace, releaseUserSpace } from '../src/user'
import { resetTestState, parseJson } from './helpers'
import { createModuleEvent } from '../src/event'
import type { FastifyInstance, HTTPMethods } from 'fastify'
import { song } from './together/fakes'

describe('PAT HTTP data API', { concurrency: false, timeout: 25000 }, () => {
  let app: FastifyInstance
  let fixture: { users: Record<'host' | 'member', { id: string, username: string }>, credentials: Record<'host' | 'member', { token: string }> }
  before(async() => {
    app = resetTestState(); createModuleEvent()
    const host = await getAccountStore().createUser({ username: 'http-host', password: 'test-password' })
    const member = await getAccountStore().createUser({ username: 'http-member', password: 'test-password' })
    const login = async(username: string) => ({ token: parseJson((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'test-password' } })).body).token })
    fixture = { users: { host, member }, credentials: { host: await login(host.username), member: await login(member.username) } }
  })
  after(async() => { await app?.close(); for (const user of Object.values(fixture?.users ?? {})) releaseUserSpace(user.username, true) })
  const token = (who: 'host' | 'member' = 'host', scopes = ['history:read', 'playlist:read', 'playlist:write']) =>
    getAccountStore().pats.create(fixture.users[who].id, 'Data API', scopes as any, 'never')
  const request = async(auth: string, url: string, method = 'GET', body?: unknown) => {
    const response = await app.inject({ url, method: method as HTTPMethods, headers: { authorization: `Bearer ${auth}` }, ...(body === undefined ? {} : { payload: body as any }) })
    return { status: response.statusCode, data: parseJson(response.body) }
  }
  it('pages history by start time with stable ties, filters ISO/ms ranges and aggregates songs', async() => {
    const pat = token()
    const history = getUserSpace(fixture.users.host.username).playHistoryManage
    const record = (deviceId: string, startedAt: number, songmid: string, flags = {}) => ({ id: `${deviceId}:${startedAt}`, deviceId,
      startedAt, endedAt: startedAt + 10, listenedMs: 10, song: { source: 'kw', songmid, name: songmid, singer: 'Artist' }, ...flags })
    await history.push({ records: [record('a', 1000, 'one'), record('a', 2000, 'two', { completed: true }),
      record('b', 2000, 'one', { skipped: true }), record('a', 3000, 'one')] })
    const first = await request(pat.token, '/api/v1/history?limit=2')
    assert.equal(first.status, 200)
    assert.deepEqual(first.data.items.map((r: any) => r.id), ['a:3000', 'b:2000'])
    assert.equal(first.data.items[1].skipped, true)
    const second = await request(pat.token, `/api/v1/history?limit=2&cursor=${first.data.nextCursor}`)
    assert.deepEqual(second.data.items.map((r: any) => r.id), ['a:2000', 'a:1000'])
    assert.equal(second.data.items[0].completed, true)
    assert.equal(second.data.nextCursor, null)
    const range = await request(pat.token, '/api/v1/history?from=1970-01-01T00:00:02.000Z&to=2000')
    assert.equal(range.data.items.length, 2)
    const top = await request(pat.token, '/api/v1/stats/top-tracks?from=1000&to=3000&limit=1')
    assert.equal(top.data.items[0].song.songmid, 'one')
    assert.equal(top.data.items[0].playCount, 3)
    assert.equal((await request(pat.token, '/api/v1/stats/top-tracks?from=2000&to=2000')).data.items.length, 2)
    for (const query of ['limit=0', 'cursor=bad', 'from=oops', 'from=3000&to=2000', 'limit=1.2']) {
      assert.equal((await request(pat.token, '/api/v1/history?' + query)).status, 400)
    }
    assert.deepEqual((await request(token('member').token, '/api/v1/history')).data.items, [])
    await history.push({ records: Array.from({ length: 205 }, (_, i) => record('limit', 10000 + i, `song-${i}`)) })
    assert.equal((await request(pat.token, '/api/v1/history')).data.items.length, 50)
    assert.equal((await request(pat.token, '/api/v1/history?limit=999')).data.items.length, 200)
    assert.equal((await request(pat.token, '/api/v1/stats/top-tracks')).data.items.length, 20)
    assert.equal((await request(pat.token, '/api/v1/stats/top-tracks?limit=999')).data.items.length, 100)
  })
  it('creates, adds and removes through list sync and persists snapshots', async() => {
    const pat = token()
    const created = await request(pat.token, '/api/v1/playlists', 'POST', { name: 'HTTP mix', songs: [song('one'), song('one')] })
    assert.equal(created.status, 201)
    assert.equal(created.data.added, 1); assert.equal(created.data.skipped, 1)
    const id = created.data.id
    const manage = getUserSpace(fixture.users.host.username).listManage
    const key = await manage.getCurrentListInfoKey()
    const snapshot = await manage.snapshotDataManage.getSnapshot(key)
    assert.equal(snapshot!.userList.find(l => l.id == id)!.list[0].id, song('one').id)
    const listing = (await request(pat.token, '/api/v1/playlists')).data.items
    assert.deepEqual(listing.slice(0, 2).map((l: any) => l.id), ['default', 'love'])
    assert.equal(listing.find((l: any) => l.id == id).songCount, 1)
    const add = await request(pat.token, `/api/v1/playlists/${id}/songs`, 'POST', { songs: [song('one'), song('two'), song('two')], position: 'top' })
    assert.deepEqual(add.data, { added: 1, skipped: 2 })
    const detail = await request(pat.token, `/api/v1/playlists/${id}?offset=0&limit=1`)
    assert.equal(detail.data.total, 2); assert.equal(detail.data.items[0].id, song('two').id)
    const remove = await request(pat.token, `/api/v1/playlists/${id}/songs`, 'DELETE', { songIds: [song('two').id, song('two').id, 'unknown'] })
    assert.deepEqual(remove.data, { removed: 1, skipped: 2 })
    assert.equal((await request(pat.token, `/api/v1/playlists/${id}?offset=1`)).data.items.length, 0)
    const alien = token('member')
    for (const method of ['GET', 'POST', 'DELETE']) {
      const url = `/api/v1/playlists/${id}` + (method == 'GET' ? '' : '/songs')
      assert.equal((await request(alien.token, url, method, method == 'GET' ? undefined : method == 'POST' ? { songs: [] } : { songIds: [] })).status, 404)
    }
    for (const body of [{ name: '' }, { name: 'x'.repeat(61) }, { name: 'bad', songs: [{}] }, { name: 'bad', songs: Array(501).fill(song('one')) }]) {
      assert.equal((await request(pat.token, '/api/v1/playlists', 'POST', body)).status, 400)
    }
    assert.equal((await request(pat.token, `/api/v1/playlists/${id}/songs`, 'POST', { songs: [], position: 'middle' })).status, 400)
    for (let i = 0; i < 100; i++) {
      const file = manage.snapshotDataManage.snapshotInfoFilePath
      // The snapshot info file may be observed mid-write; treat unparsable content as not ready yet.
      let latest: unknown
      try { latest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).latest : undefined } catch { latest = undefined }
      if (latest !== undefined && latest == await manage.getCurrentListInfoKey()) break
      await setTimeout(10)
    }
    releaseUserSpace(fixture.users.host.username, true)
    assert.equal((await request(pat.token, `/api/v1/playlists/${id}`)).data.items[0].id, song('one').id)
  })
  it('enforces scopes, records successes/failures, isolates token activity and allows only session owners', async() => {
    const pat = token('host', ['playlist:read'])
    assert.equal((await request(pat.token, '/api/v1/history')).status, 403)
    assert.equal((await request(pat.token, '/api/v1/playlists', 'POST', { name: 'denied' })).status, 403)
    assert.equal((await request(pat.token, '/api/v1/token/whoami')).status, 200)
    const activity = await request(pat.token, '/api/v1/token/activity')
    assert.deepEqual(activity.data.items.map((a: any) => [a.action, a.ok]), [['token.whoami', true], ['playlist.create', false], ['history.read', false]])
    assert.equal((await request(pat.token, '/api/v1/token/activity')).data.items.length, 3)
    assert.deepEqual((await request(token().token, '/api/v1/token/activity')).data.items, [])
    assert.equal((await request(fixture.credentials.host.token, `/api/me/tokens/${pat.id}/activity?limit=1`)).data.items.length, 1)
    assert.equal((await request(fixture.credentials.member.token, `/api/me/tokens/${pat.id}/activity`)).status, 404)
    assert.equal((await request(pat.token, `/api/me/tokens/${pat.id}/activity`)).status, 401)
    getAccountStore().pats.revoke(pat.id, fixture.users.host.id)
    assert.equal((await request(pat.token, '/api/v1/history')).status, 401)
    assert.equal((await request('bad', '/api/v1/playlists')).status, 401)
    for (let i = 0; i < 202; i++) recordTokenActivity(pat.id, 'mcp.test', `Call ${i}`, true)
    initAccountStore(global.lx.dataPath)
    const saved = getAccountStore().pats.activity(pat.id, fixture.users.host.id, 200)!
    assert.equal(saved.length, 200); assert.equal(saved[0].summary, 'Call 201'); assert.equal(saved[199].summary, 'Call 2')
  })
  it('limits each token independently to 60 calls per minute and resets the window', async t => {
    const pat = token(); const now = Date.now()
    t.mock.method(Date, 'now', () => now)
    for (let i = 0; i < 60; i++) assert.equal((await request(pat.token, '/api/v1/token/whoami')).status, 200)
    const denied = await request(pat.token, '/api/v1/token/whoami')
    assert.equal(denied.status, 429); assert.equal(denied.data.code, 'RATE_LIMITED')
    assert.equal((await request(token().token, '/api/v1/token/whoami')).status, 200)
    assert.equal(getAccountStore().pats.activity(pat.id, fixture.users.host.id)![0].ok, false)
    t.mock.method(Date, 'now', () => now + 60000)
    assert.equal((await request(pat.token, '/api/v1/token/whoami')).status, 200)
  })
})

