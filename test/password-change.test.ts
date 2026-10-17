import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import { getAccountStore } from '../src/account/store'
import { createToken } from '../src/account/token'
import { AUTH_FAIL_LIMIT } from '../src/server/api/rateLimit'
import { parseJson, resetTestState } from './helpers'

describe('self-service password change', () => {
  let app: FastifyInstance
  let token: string
  let credentials: Record<string, any>

  const login = (password = 'old-pass') => app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'alice', password, deviceId: 'phone', deviceName: 'Phone', platform: 'ios' },
  })
  const changePassword = (payload: Record<string, unknown>) => app.inject({
    method: 'POST',
    url: '/api/me/password',
    headers: { authorization: `Bearer ${token}` },
    payload,
  })
  const me = (bearer: string) => app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${bearer}` },
  })

  beforeEach(async() => {
    app = resetTestState()
    await getAccountStore().createUser({ username: 'alice', password: 'old-pass' })
    const result = await login()
    assert.equal(result.statusCode, 200)
    credentials = parseJson(result.body)
    token = credentials.accessToken
  })

  afterEach(async() => {
    await app.close()
  })

  it('requires non-empty string passwords and a boolean revokeOtherDevices', async() => {
    const invalidBodies = [
      { password: 'new-pass' },
      { oldPassword: '', password: 'new-pass' },
      { oldPassword: '   ', password: 'new-pass' },
      { oldPassword: 123, password: 'new-pass' },
      { oldPassword: 'old-pass' },
      { oldPassword: 'old-pass', password: '' },
      { oldPassword: 'old-pass', password: '   ' },
      { oldPassword: 'old-pass', password: 123 },
      ...['true', 1, null, {}, []].map(revokeOtherDevices => ({
        oldPassword: 'old-pass', password: 'new-pass', revokeOtherDevices,
      })),
    ]
    for (const payload of invalidBodies) {
      const result = await changePassword(payload)
      assert.equal(result.statusCode, 400, JSON.stringify(payload))
    }
    assert.equal((await me(token)).statusCode, 200)
    assert.equal((await login()).statusCode, 200)
  })

  it('rejects the wrong current password without changing credentials or sessions', async() => {
    const result = await changePassword({ oldPassword: 'wrong', password: 'new-pass' })
    assert.equal(result.statusCode, 403)
    assert.equal(parseJson(result.body).message, 'Invalid current password')
    assert.equal(parseJson(result.body).code, 'INVALID_CURRENT_PASSWORD')
    assert.equal((await me(token)).statusCode, 200)
    assert.equal((await login()).statusCode, 200)
    assert.equal((await login('new-pass')).statusCode, 401)
  })

  const refresh = (refreshToken: string) => app.inject({
    method: 'POST', url: '/api/auth/refresh', payload: { refreshToken },
  })
  const assertRenewable = async(body: Record<string, any>) => {
    assert.equal(typeof body.token, 'string')
    assert.equal(typeof body.sessionId, 'string')
    assert.ok(body.accessTokenExpiresAt > Date.now())
    assert.equal((await me(body.token)).statusCode, 200)
    assert.equal((await me(body.accessToken)).statusCode, 200)
    const rotated = await refresh(body.refreshToken)
    assert.equal(rotated.statusCode, 200, rotated.body)
    const next = parseJson(rotated.body)
    assert.equal(next.sessionId, body.sessionId)
    assert.equal((await me(next.accessToken)).statusCode, 200)
    assert.equal((await refresh(next.refreshToken)).statusCode, 200)
  }

  for (const revokeOtherDevices of [undefined, false, true]) {
    it(`replaces the current session and honors revokeOtherDevices=${String(revokeOtherDevices)}`, async() => {
      const store = getAccountStore()
      const user = store.findManagedUserByUsername('alice')!
      const sessionVersion = user.sessionVersion
      const syncCode = store.getSyncCode(user.id)
      const other = parseJson((await app.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { username: 'alice', password: 'old-pass', deviceId: 'tablet' },
      })).body)
      const result = await changePassword({ oldPassword: 'old-pass', password: 'new-pass', revokeOtherDevices })
      assert.equal(result.statusCode, 200, result.body)
      const body = parseJson(result.body)
      assert.equal(body.ok, true)
      assert.notEqual(body.sessionId, credentials.sessionId)
      assert.equal(body.user.id, user.id)
      assert.equal(body.user.loginPasswordHash, undefined)
      assert.equal(body.user.lxSyncCode, undefined)
      assert.equal(user.sessionVersion, sessionVersion + (revokeOtherDevices === false ? 0 : 1))
      assert.equal((await me(token)).statusCode, 401)
      assert.equal((await refresh(credentials.refreshToken)).statusCode, 401)
      const expected = revokeOtherDevices === false ? 200 : 401
      assert.equal((await me(other.accessToken)).statusCode, expected)
      const otherRefresh = await refresh(other.refreshToken)
      assert.equal(otherRefresh.statusCode, expected)
      if (expected == 200) assert.equal((await me(parseJson(otherRefresh.body).accessToken)).statusCode, 200)
      await assertRenewable(body)
      const session = store.sessions.listForUser(user.id).find(session => session.id == body.sessionId)!
      assert.equal(session.deviceId, 'phone')
      assert.equal(session.deviceName, 'Phone')
      assert.equal(session.platform, 'ios')
      assert.equal(store.getSyncCode(user.id), syncCode)
      assert.equal((await login('new-pass')).statusCode, 200)
      assert.equal((await login()).statusCode, 401)
    })
  }

  it('rejects a legacy token with false without changing the password or sessions', async() => {
    token = credentials.token
    const store = getAccountStore()
    const before = JSON.stringify(store.findManagedUserByUsername('alice'))
    const sessions = JSON.stringify(store.sessions.listForUser(credentials.user.id))
    const result = await changePassword({ oldPassword: 'old-pass', password: 'new-pass', revokeOtherDevices: false })
    assert.equal(result.statusCode, 400)
    assert.deepEqual(parseJson(result.body), {
      code: 'SESSION_REQUIRED', message: 'sign in again to keep other devices signed in',
    })
    assert.equal(JSON.stringify(store.findManagedUserByUsername('alice')), before)
    assert.equal(JSON.stringify(store.sessions.listForUser(credentials.user.id)), sessions)
    assert.equal((await me(credentials.accessToken)).statusCode, 200)
    assert.equal((await refresh(credentials.refreshToken)).statusCode, 200)
    assert.equal((await login('new-pass')).statusCode, 401)
    assert.equal((await login()).statusCode, 200)
  })

  for (const revokeOtherDevices of [undefined, true]) {
    it(`replaces legacy credentials with a renewable session (revokeOtherDevices=${String(revokeOtherDevices)})`, async() => {
      token = credentials.token
      const result = await changePassword({ oldPassword: 'old-pass', password: 'new-pass', revokeOtherDevices })
      assert.equal(result.statusCode, 200, result.body)
      assert.equal((await me(token)).statusCode, 401)
      assert.equal((await me(credentials.accessToken)).statusCode, 401)
      assert.equal((await refresh(credentials.refreshToken)).statusCode, 401)
      await assertRenewable(parseJson(result.body))
    })
  }

  it('reuses the login failure rate limit', async() => {
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) {
      assert.equal((await changePassword({ oldPassword: 'wrong', password: 'new-pass' })).statusCode, 403)
    }
    const blocked = await changePassword({ oldPassword: 'old-pass', password: 'new-pass' })
    assert.equal(blocked.statusCode, 429)
    assert.match(parseJson(blocked.body).message, /Too many failed attempts/)
    assert.equal((await me(token)).statusCode, 200)
  })

  it('keeps config/env-only users unauthorized', async() => {
    global.lx.config.users.push({ name: 'env-only', password: 'sync-code', dataPath: '' })
    token = createToken({
      userId: 'config:env-only', username: 'env-only', role: 'user', sessionVersion: 1,
      secret: getAccountStore().getTokenSecret(),
    })
    const result = await changePassword({ oldPassword: 'sync-code', password: 'new-pass' })
    assert.equal(result.statusCode, 401)
    assert.equal(parseJson(result.body).message, 'Unauthorized')
  })
})
