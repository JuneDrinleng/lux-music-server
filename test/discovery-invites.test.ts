import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { AccountStore, getAccountStore } from '../src/account/store'
import { createToken } from '../src/account/token'
import { AUTH_FAIL_LIMIT } from '../src/server/api/rateLimit'
import { parseJson, resetTestState } from './helpers'

describe('server discovery and invite registration', () => {
  let app: FastifyInstance
  const env = { LUX_VERSION: process.env.LUX_VERSION, LUX_MIN_CLIENT_VERSION: process.env.LUX_MIN_CLIENT_VERSION }
  const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, payload })
  const register = (inviteCode: string, username = 'new-user') => post('/api/auth/register', { inviteCode, username, password: 'secret' })
  const invite = async(displayName?: string) => {
    const store = getAccountStore()
    const creator = await store.createUser({ username: 'inviter', password: 'secret', displayName })
    return store.createInvite({ createdBy: creator.id })
  }
  const expectError = (res: { statusCode: number, body: string }, status: number, code: string, message: string) => {
    assert.equal(res.statusCode, status, res.body)
    assert.deepEqual(parseJson(res.body), { code, message })
  }

  beforeEach(() => {
    delete process.env.LUX_VERSION
    delete process.env.LUX_MIN_CLIENT_VERSION
    app = resetTestState()
  })
  afterEach(async() => {
    await app.close()
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('discovers the server without auth and uses release/minimum version overrides', async() => {
    const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
    const res = await app.inject({ url: '/api/server-info' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
    const expected = {
      name: global.lx.config.serverName, version, packageVersion: version, minClientVersion: null,
      registration: { inviteOnly: true, enabled: true }, features: ['sessions', 'refresh', 'me-sessions', 'invite-check'],
    }
    assert.deepEqual(parseJson(res.body), expected)
    process.env.LUX_VERSION = '1.2.3-dev.4'
    process.env.LUX_MIN_CLIENT_VERSION = '1.0.0'
    assert.deepEqual(parseJson((await app.inject({ url: '/api/server-info' })).body), {
      ...expected, version: '1.2.3-dev.4', minClientVersion: '1.0.0',
    })
  })

  for (const displayName of ['Friendly Inviter', undefined]) {
    it(`checks invites with inviter ${displayName ? 'display name' : 'username'}`, async() => {
      const { code, invite: record } = await invite(displayName)
      getAccountStore().updateInvite(record.id, { expiresAt: Date.now() + 60_000 })
      for (const res of [
        await app.inject({ url: `/api/auth/invite/check?inviteCode=${encodeURIComponent(code)}` }),
        await post('/api/auth/invite/check', { inviteCode: code }),
      ]) {
        assert.equal(res.statusCode, 200)
        assert.deepEqual(parseJson(res.body), { valid: true, inviterName: displayName || 'inviter', role: 'user', expiresAt: record.expiresAt })
      }
      assert.equal(record.usedCount, 0)
    })
  }

  for (const kind of ['NOT_FOUND', 'DISABLED', 'EXPIRED', 'USED_UP']) {
    it(`reports INVITE_${kind} consistently while preserving registration status/messages`, async() => {
      const { code, invite: record } = await invite()
      const store = getAccountStore()
      if (kind == 'DISABLED') store.updateInvite(record.id, { disabled: true })
      if (kind == 'EXPIRED') store.updateInvite(record.id, { expiresAt: 0 })
      if (kind == 'USED_UP') assert.equal((await register(code)).statusCode, 200)
      const input = kind == 'NOT_FOUND' ? 'unknown' : code
      const message = kind == 'EXPIRED' ? 'Invite code expired' : kind == 'USED_UP' ? 'Invite code used up' : 'Invite code invalid'
      expectError(await post('/api/auth/invite/check', { inviteCode: input }), kind == 'NOT_FOUND' ? 404 : 410, `INVITE_${kind}`, message)
      expectError(await register(input, 'another-user'), 400, `INVITE_${kind}`, message)
    })
  }

  it('consumes a single-use invite once and returns working login credentials', async() => {
    const { code } = await invite()
    const res = await register(code)
    assert.equal(res.statusCode, 200, res.body)
    const body = parseJson(res.body)
    for (const field of ['token', 'accessToken', 'refreshToken', 'sessionId']) assert.equal(typeof body[field], 'string')
    assert.ok(body.accessTokenExpiresAt > Date.now())
    for (const token of [body.token, body.accessToken]) {
      assert.equal((await app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } })).statusCode, 200)
    }
    assert.equal((await post('/api/auth/refresh', { refreshToken: body.refreshToken })).statusCode, 200)
    expectError(await register(code, 'second-user'), 400, 'INVITE_USED_UP', 'Invite code used up')
    const persisted = new AccountStore(global.lx.dataPath)
    assert.throws(() => persisted.checkInvite(code), { code: 'INVITE_USED_UP' })
  })

  it('enforces maxUses during concurrent registrations', async() => {
    const { code, invite: record } = await invite()
    const results = await Promise.all([register(code, 'first'), register(code, 'second')])
    assert.deepEqual(results.map(res => res.statusCode).sort(), [200, 400])
    expectError(results.find(res => res.statusCode == 400)!, 400, 'INVITE_USED_UP', 'Invite code used up')
    assert.equal(record.usedCount, 1)
    assert.equal(record.usedBy.length, 1)
    assert.equal(getAccountStore().getManagedUsers().length, 2)
  })

  for (const kind of ['DISABLED', 'EXPIRED', 'NOT_FOUND']) {
    it(`rechecks INVITE_${kind} after asynchronous password hashing`, async() => {
      const { code, invite: record } = await invite()
      const store = getAccountStore()
      const pending = store.registerByInvite({ code, username: 'late-user', password: 'secret' })
      if (kind == 'DISABLED') store.updateInvite(record.id, { disabled: true })
      if (kind == 'EXPIRED') store.updateInvite(record.id, { expiresAt: 0 })
      if (kind == 'NOT_FOUND') store.deleteInvite(record.id)
      await assert.rejects(pending, { code: `INVITE_${kind}` })
      assert.equal(store.findManagedUserByUsername('late-user'), null)
      assert.equal(record.usedCount, 0)
    })
  }

  it('distinguishes authentication, authorization, credentials and password errors', async() => {
    expectError(await app.inject({ url: '/api/me/profile' }), 401, 'UNAUTHENTICATED', 'Unauthorized')
    const { code } = await invite()
    const body = parseJson((await register(code)).body)
    const headers = { authorization: `Bearer ${body.accessToken}` }
    for (const url of ['/api/admin/users', '/api/admin/together/rooms']) {
      expectError(await app.inject({ url, headers }), 403, 'FORBIDDEN', 'Forbidden')
    }
    expectError(await post('/api/auth/login', { username: 'new-user', password: 'wrong' }), 401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    expectError(await app.inject({ method: 'POST', url: '/api/me/password', headers, payload: { oldPassword: 'wrong', password: 'new' } }), 403, 'INVALID_CURRENT_PASSWORD', 'Invalid current password')
    const user = getAccountStore().findManagedUserById(body.user.id)!
    const expired = createToken({ userId: user.id, username: user.username, role: user.role, sessionVersion: user.sessionVersion, secret: getAccountStore().getTokenSecret(), issuedAt: 0, ttlMs: 1 })
    getAccountStore().sessions.revoke(body.sessionId)
    for (const token of ['invalid', expired, body.accessToken]) {
      expectError(await app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } }), 401, 'UNAUTHENTICATED', 'Unauthorized')
    }
  })

  it('rate-limits invite check failures by IP across both methods', async() => {
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) {
      expectError(await post('/api/auth/invite/check', { inviteCode: 'unknown' }), 404, 'INVITE_NOT_FOUND', 'Invite code invalid')
    }
    const res = await app.inject({ url: '/api/auth/invite/check?inviteCode=unknown' })
    expectError(res, 429, 'RATE_LIMITED', 'Too many failed attempts, try again later')
    expectError(await post('/api/auth/login', { username: 'any', password: 'any' }), 429, 'RATE_LIMITED', 'Too many failed attempts, try again later')
  })
})
