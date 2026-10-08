import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { getAccountStore } from '../src/account/store'
import { AUTH_FAIL_LIMIT } from '../src/server/api/rateLimit'
import { parseJson, resetTestState } from './helpers'
import type { FastifyInstance } from 'fastify'

describe('auth api', () => {
  let app: FastifyInstance

  beforeEach(() => {
    app = resetTestState()
  })

  it('rejects remote bootstrap without token when no admin exists', async() => {
    const status = await app.inject({
      method: 'GET',
      url: '/api/auth/bootstrap',
      remoteAddress: '203.0.113.10',
    })
    assert.equal(status.statusCode, 200)
    const statusBody = parseJson(status.body)
    assert.equal(statusBody.needsAdmin, true)
    assert.equal(statusBody.allowed, false)

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      remoteAddress: '203.0.113.10',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'admin', password: 'password123' },
    })
    assert.equal(res.statusCode, 403)
  })

  it('allows loopback bootstrap when no admin and no token', async() => {
    const status = await app.inject({
      method: 'GET',
      url: '/api/auth/bootstrap',
      remoteAddress: '127.0.0.1',
    })
    assert.equal(parseJson(status.body).allowed, true)

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      remoteAddress: '127.0.0.1',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'admin', password: 'password123' },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(parseJson(res.body).user.role, 'admin')
  })

  it('allows remote bootstrap with LUX_BOOTSTRAP_TOKEN', async() => {
    process.env.LUX_BOOTSTRAP_TOKEN = 'test-bootstrap-token'
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      remoteAddress: '203.0.113.10',
      headers: {
        'content-type': 'application/json',
        'x-lux-bootstrap-token': 'test-bootstrap-token',
      },
      payload: { username: 'admin', password: 'password123' },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(parseJson(res.body).user.username, 'admin')
  })

  it('login / logout revokes the current session', async() => {
    await getAccountStore().createUser({
      username: 'alice',
      password: 'secret-pass',
      role: 'user',
    })

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.1',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'alice', password: 'secret-pass' },
    })
    assert.equal(login.statusCode, 200)
    const token = parseJson(login.body).token as string
    assert.ok(token)

    const meBefore = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(meBefore.statusCode, 200)

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(logout.statusCode, 200)
    assert.equal(parseJson(logout.body).ok, true)

    const meAfter = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(meAfter.statusCode, 401)
  })

  it('rate-limits repeated login failures by IP', async() => {
    await getAccountStore().createUser({
      username: 'bob',
      password: 'correct-horse',
      role: 'user',
    })

    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '198.51.100.20',
        headers: { 'content-type': 'application/json' },
        payload: { username: 'bob', password: 'wrong' },
      })
      assert.equal(res.statusCode, 401)
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.20',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'bob', password: 'correct-horse' },
    })
    assert.equal(blocked.statusCode, 403)
  })

  it('rate-limits register failures by username', async() => {
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        remoteAddress: `198.51.100.${30 + i}`,
        headers: { 'content-type': 'application/json' },
        payload: {
          inviteCode: 'invalid-invite',
          username: 'carol',
          password: 'password123',
        },
      })
      assert.equal(res.statusCode, 400)
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      remoteAddress: '198.51.100.99',
      headers: { 'content-type': 'application/json' },
      payload: {
        inviteCode: 'still-invalid',
        username: 'carol',
        password: 'password123',
      },
    })
    assert.equal(blocked.statusCode, 403)
  })
})
