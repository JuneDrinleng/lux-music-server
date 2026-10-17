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

  const login = (password = 'old-pass') => app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'alice', password },
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
    token = parseJson(result.body).token
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
    assert.equal((await me(token)).statusCode, 200)
    assert.equal((await login()).statusCode, 200)
    assert.equal((await login('new-pass')).statusCode, 401)
  })

  for (const revokeOtherDevices of [undefined, false, true]) {
    it(`rotates all bearer sessions and preserves sync credentials (revokeOtherDevices=${String(revokeOtherDevices)})`, async() => {
      const store = getAccountStore()
      const user = store.findManagedUserByUsername('alice')!
      const sessionVersion = user.sessionVersion
      const syncCode = store.getSyncCode(user.id)
      const otherToken = createToken({
        userId: user.id,
        username: user.username,
        role: user.role,
        sessionVersion,
        secret: store.getTokenSecret(),
        ttlMs: 60_000,
      })
      const device = await app.inject({
        method: 'POST',
        url: '/api/sync/key',
        headers: { authorization: `Bearer ${token}` },
        payload: { deviceId: 'password-change-test', deviceName: 'Phone' },
      })
      assert.equal(device.statusCode, 200)
      const devicesBefore = await app.inject({
        method: 'GET', url: '/api/me/devices', headers: { authorization: `Bearer ${token}` },
      })

      const result = await changePassword({ oldPassword: 'old-pass', password: 'new-pass', revokeOtherDevices })
      assert.equal(result.statusCode, 200, result.body)
      const body = parseJson(result.body)
      assert.equal(body.ok, true)
      assert.equal(typeof body.token, 'string')
      assert.notEqual(body.token, token)
      assert.equal(body.user.id, user.id)
      assert.equal(body.user.loginPasswordHash, undefined)
      assert.equal(body.user.lxSyncCode, undefined)
      assert.equal(user.sessionVersion, sessionVersion + 1)
      assert.equal((await me(token)).statusCode, 401)
      assert.equal((await me(otherToken)).statusCode, 401)
      const current = await me(body.token)
      assert.equal(current.statusCode, 200)
      assert.deepEqual(parseJson(current.body).user, body.user)
      assert.equal(store.getSyncCode(user.id), syncCode)
      const devicesAfter = await app.inject({
        method: 'GET', url: '/api/me/devices', headers: { authorization: `Bearer ${body.token}` },
      })
      assert.equal(devicesAfter.statusCode, 200)
      assert.deepEqual(parseJson(devicesAfter.body), parseJson(devicesBefore.body))
      assert.equal((await login('new-pass')).statusCode, 200)
      assert.equal((await login()).statusCode, 401)
    })
  }

  it('reuses the login failure rate limit', async() => {
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) {
      assert.equal((await changePassword({ oldPassword: 'wrong', password: 'new-pass' })).statusCode, 403)
    }
    const blocked = await changePassword({ oldPassword: 'old-pass', password: 'new-pass' })
    assert.equal(blocked.statusCode, 403)
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
