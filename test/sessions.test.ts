import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { getAccountStore, initAccountStore } from '../src/account/store'
import { SessionStore } from '../src/account/sessions'
import { verifyToken } from '../src/account/token'
import { AUTH_FAIL_LIMIT } from '../src/server/api/rateLimit'
import { parseJson, resetTestState } from './helpers'

const sessionsPath = () => path.join(global.lx.dataPath, 'lux', 'sessions.json')
describe('session tokens', () => {
  let app: FastifyInstance
  const login = async(deviceId?: string) => parseJson((await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'alice', password: 'secret-pass', deviceId, deviceName: 'Phone', platform: 'ios' },
  })).body)
  const refresh = (refreshToken: string) => app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken } })
  const me = (token: string) => app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } })

  beforeEach(async() => {
    app = resetTestState()
    await getAccountStore().createUser({ username: 'alice', password: 'secret-pass' })
  })

  it('adds short-lived session credentials while preserving the legacy 14-day token', async() => {
    const body = await login('phone')
    const secret = getAccountStore().getTokenSecret()
    const legacy = verifyToken(body.token, secret)!
    const access = verifyToken(body.accessToken, secret)!
    assert.notEqual(body.token, body.accessToken)
    assert.equal(legacy.sid, undefined)
    assert.equal(legacy.exp - legacy.iat, 14 * 86400000)
    assert.equal(access.exp - access.iat, 3600000)
    assert.equal(access.exp, body.accessTokenExpiresAt)
    assert.equal(access.sid, body.sessionId)
    assert.equal((await me(body.token)).statusCode, 200)
    assert.equal((await me(body.accessToken)).statusCode, 200)
    const disk = fs.readFileSync(sessionsPath(), 'utf-8')
    assert.ok(!disk.includes(body.refreshToken))
    const session = JSON.parse(disk).sessions[0]
    assert.equal(session.deviceId, 'phone')
    assert.equal(session.deviceName, 'Phone')
    assert.equal(session.platform, 'ios')
    assert.equal(session.expiresAt - session.createdAt, 90 * 86400000)
  })

  it('rotates across reloads and revokes the family when a spent refresh token is replayed', async() => {
    const original = await login()
    initAccountStore(global.lx.dataPath)
    const res = await refresh(original.refreshToken)
    assert.equal(res.statusCode, 200)
    const rotated = parseJson(res.body)
    assert.notEqual(rotated.refreshToken, original.refreshToken)
    assert.equal(rotated.sessionId, original.sessionId)
    assert.equal((await me(rotated.accessToken)).statusCode, 200)
    initAccountStore(global.lx.dataPath)
    assert.equal((await refresh(original.refreshToken)).statusCode, 401)
    assert.equal((await refresh(rotated.refreshToken)).statusCode, 401)
    assert.equal((await me(rotated.accessToken)).statusCode, 401)
    assert.equal((await me(original.token)).statusCode, 200)
  })

  it('replaces the same device and logs out only the session carried by sid', async() => {
    const first = await login('phone')
    const second = await login('phone')
    const other = await login('tablet')
    assert.equal((await me(first.accessToken)).statusCode, 401)
    assert.equal((await refresh(first.refreshToken)).statusCode, 401)
    const logout = await app.inject({
      method: 'POST', url: '/api/auth/logout', headers: { authorization: `Bearer ${second.accessToken}` },
    })
    assert.equal(logout.statusCode, 200)
    assert.equal((await me(second.accessToken)).statusCode, 401)
    assert.equal((await refresh(second.refreshToken)).statusCode, 401)
    assert.equal((await me(other.accessToken)).statusCode, 200)
    assert.equal((await me(second.token)).statusCode, 200)
  })

  it('password change revokes every session and preserves the replacement legacy token', async() => {
    const first = await login()
    const second = await login()
    const response = await app.inject({
      method: 'POST', url: '/api/me/password', headers: { authorization: `Bearer ${first.accessToken}` },
      payload: { oldPassword: 'secret-pass', password: 'new-password' },
    })
    assert.equal(response.statusCode, 200)
    for (const body of [first, second]) {
      assert.equal((await refresh(body.refreshToken)).statusCode, 401)
      assert.equal((await me(body.accessToken)).statusCode, 401)
    }
    assert.equal((await me(parseJson(response.body).token)).statusCode, 200)
  })

  it('disable revokes sessions permanently, then re-enable permits a fresh login', async() => {
    const body = await login()
    const store = getAccountStore()
    const user = store.findManagedUserByUsername('alice')!
    store.updateUser(user.id, { status: 'disabled' })
    store.updateUser(user.id, { status: 'active' })
    assert.equal((await refresh(body.refreshToken)).statusCode, 401)
    assert.equal((await me(body.accessToken)).statusCode, 401)
    assert.equal((await me(body.token)).statusCode, 401)
    assert.equal((await me((await login()).accessToken)).statusCode, 200)
  })

  it('honors TTL overrides and rejects expired refresh credentials', async t => {
    let time = Date.now()
    t.mock.method(Date, 'now', () => time)
    process.env.LUX_ACCESS_TOKEN_TTL_SECONDS = '60'
    process.env.LUX_REFRESH_TOKEN_TTL_DAYS = '1'
    try {
      initAccountStore(global.lx.dataPath)
      const body = await login()
      assert.equal(body.accessTokenExpiresAt, time + 60000)
      time += 30000
      const rotated = await refresh(body.refreshToken)
      assert.equal(rotated.statusCode, 200)
      const saved = JSON.parse(fs.readFileSync(sessionsPath(), 'utf-8')).sessions[0]
      assert.equal(saved.lastActiveAt, time)
      assert.equal(saved.expiresAt, time + 86400000)
      time += 86400001
      assert.equal((await refresh(parseJson(rotated.body).refreshToken)).statusCode, 401)
    } finally {
      delete process.env.LUX_ACCESS_TOKEN_TTL_SECONDS
      delete process.env.LUX_REFRESH_TOKEN_TTL_DAYS
    }
  })

  it('lists only own active sessions with a strict public whitelist and current flag', async t => {
    let time = Date.now()
    t.mock.method(Date, 'now', () => time)
    initAccountStore(global.lx.dataPath)
    const first = await login('phone')
    time += 1000
    const second = await login('tablet')
    const store = getAccountStore()
    const alice = store.findManagedUserByUsername('alice')!
    const bob = await store.createUser({ username: 'bob', password: 'bob-pass' })
    store.sessions.create(bob.id)
    const revoked = store.sessions.create(alice.id).session
    store.sessions.revoke(revoked.id)
    const expired = store.sessions.create(alice.id).session
    expired.expiresAt = time
    time += 1000
    assert.equal((await refresh(first.refreshToken)).statusCode, 200)
    const res = await app.inject({ url: '/api/me/sessions', headers: { authorization: `Bearer ${second.accessToken}` } })
    assert.equal(res.statusCode, 200)
    const sessions = parseJson(res.body).sessions
    assert.deepEqual(sessions.map((s: any) => s.id), [first.sessionId, second.sessionId])
    assert.deepEqual(sessions.map((s: any) => s.current), [false, true])
    for (const session of sessions) {
      assert.deepEqual(Object.keys(session).sort(), ['id', 'deviceId', 'deviceName', 'platform', 'createdAt', 'lastActiveAt', 'current'].sort())
      assert.equal(session.deviceName, 'Phone')
      assert.equal(session.platform, 'ios')
    }
    const legacy = await app.inject({ url: '/api/me/sessions', headers: { authorization: `Bearer ${second.token}` } })
    assert.ok(parseJson(legacy.body).sessions.every((s: any) => s.current === false))
  })

  it('hides foreign and unknown sessions on delete and permits deleting the current session', async() => {
    const alice = await login()
    await getAccountStore().createUser({ username: 'bob', password: 'bob-pass' })
    const bob = parseJson((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'bob-pass' } })).body)
    const remove = (id: string) => app.inject({ method: 'DELETE', url: `/api/me/sessions/${id}`, headers: { authorization: `Bearer ${alice.accessToken}` } })
    const foreign = await remove(bob.sessionId)
    const unknown = await remove('unknown')
    assert.equal(foreign.statusCode, 404)
    assert.equal(unknown.statusCode, 404)
    assert.deepEqual(parseJson(foreign.body), parseJson(unknown.body))
    assert.equal((await me(bob.accessToken)).statusCode, 200)
    assert.equal((await refresh(bob.refreshToken)).statusCode, 200)
    const deleted = await remove(alice.sessionId)
    assert.equal(deleted.statusCode, 200)
    assert.deepEqual(parseJson(deleted.body), { ok: true })
    assert.equal((await me(alice.accessToken)).statusCode, 401)
    assert.equal((await refresh(alice.refreshToken)).statusCode, 401)
  })

  it('revokes other sessions once while keeping current and other users working', async() => {
    const current = await login()
    const others = [await login(), await login()]
    const bob = await getAccountStore().createUser({ username: 'bob', password: 'bob-pass' })
    const bobSession = getAccountStore().sessions.create(bob.id).session
    const revoke = () => app.inject({ method: 'POST', url: '/api/me/sessions/revoke-others', headers: { authorization: `Bearer ${current.accessToken}` } })
    const response = await revoke()
    assert.equal(response.statusCode, 200)
    assert.deepEqual(parseJson(response.body), { ok: true, revoked: 2 })
    assert.deepEqual(parseJson((await revoke()).body), { ok: true, revoked: 0 })
    for (const other of others) {
      assert.equal((await me(other.accessToken)).statusCode, 401)
      assert.equal((await refresh(other.refreshToken)).statusCode, 401)
    }
    assert.equal((await me(current.accessToken)).statusCode, 200)
    assert.equal((await refresh(current.refreshToken)).statusCode, 200)
    assert.ok(getAccountStore().sessions.isActive(bobSession.id, bob.id))
  })

  it('legacy revoke-others revokes all sessions because there is no current sid', async() => {
    const sessions = [await login(), await login()]
    const response = await app.inject({ method: 'POST', url: '/api/me/sessions/revoke-others', headers: { authorization: `Bearer ${sessions[0].token}` } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(parseJson(response.body), { ok: true, revoked: 2 })
    for (const session of sessions) {
      assert.equal((await me(session.accessToken)).statusCode, 401)
      assert.equal((await refresh(session.refreshToken)).statusCode, 401)
    }
    assert.equal((await me(sessions[0].token)).statusCode, 200)
  })

  it('requires authentication for all session management endpoints', async() => {
    for (const [method, url] of [['GET', '/api/me/sessions'], ['DELETE', '/api/me/sessions/unknown'], ['POST', '/api/me/sessions/revoke-others']] as const) {
      assert.equal((await app.inject({ method, url })).statusCode, 401)
    }
  })

  it('rate limits unknown refresh tokens by IP', async() => {
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) assert.equal((await refresh('unknown')).statusCode, 401)
    assert.equal((await refresh('unknown')).statusCode, 403)
  })

  it('uses atomic replacement and preserves the previous file when rename fails', async t => {
    const body = await login()
    const original = fs.readFileSync(sessionsPath())
    const rename = fs.renameSync
    const mocked = t.mock.method(fs, 'renameSync', (source: string, destination: string) => {
      if (destination == sessionsPath()) {
        assert.match(source, /sessions\.json\.tmp-/)
        throw new Error('rename failed')
      }
      rename(source, destination)
    })
    assert.throws(() => getAccountStore().sessions.rotate(body.refreshToken), /rename failed/)
    mocked.mock.restore()
    assert.deepEqual(fs.readFileSync(sessionsPath()), original)
    assert.ok(!fs.readdirSync(path.dirname(sessionsPath())).some(name => name.includes('.tmp-')))
    initAccountStore(global.lx.dataPath)
    assert.equal((await refresh(body.refreshToken)).statusCode, 200)
  })

  it('refuses corrupt session files with a byte-for-byte backup', t => {
    t.mock.method(console, 'error', () => {})
    for (const bytes of ['{broken', '{"version":1,"sessions":[{}]}']) {
      fs.writeFileSync(sessionsPath(), bytes)
      assert.throws(() => initAccountStore(global.lx.dataPath), /Sessions file.*Refusing to start/)
      assert.equal(fs.readFileSync(sessionsPath(), 'utf-8'), bytes)
      const backups = fs.readdirSync(path.dirname(sessionsPath())).filter(name => name.startsWith('sessions.json.corrupt-'))
      assert.ok(backups.some(name => fs.readFileSync(path.join(path.dirname(sessionsPath()), name), 'utf-8') == bytes))
    }
  })

  it('prunes sessions 30 days after expiry or revocation on save', () => {
    let time = Date.now()
    const store = new SessionStore(sessionsPath(), () => time)
    const expired = store.create('user').session
    const revoked = store.create('user').session
    store.revoke(revoked.id)
    time += 31 * 86400000
    store.create('other')
    let saved = JSON.parse(fs.readFileSync(sessionsPath(), 'utf-8')).sessions
    assert.ok(!saved.some((s: { id: string }) => s.id == revoked.id))
    assert.ok(saved.some((s: { id: string }) => s.id == expired.id))
    time += 90 * 86400000
    store.create('other')
    saved = JSON.parse(fs.readFileSync(sessionsPath(), 'utf-8')).sessions
    assert.ok(!saved.some((s: { id: string }) => s.id == expired.id))
  })
})
