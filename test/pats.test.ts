import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { PatStore } from '../src/account/pats'
import { getAccountStore, initAccountStore } from '../src/account/store'
import { authenticatePat } from '../src/server/api/pats'
import { parseJson, resetTestState } from './helpers'

const file = () => path.join(global.lx.dataPath, 'lux', 'tokens.json')
describe('personal access tokens', () => {
  let app: FastifyInstance
  beforeEach(() => { app = resetTestState() })
  it('persists only hashes, reloads, expires at the boundary and revokes idempotently', () => {
    let time = Date.now()
    const store = new PatStore(file(), () => time)
    const first = store.create('user', 'Bot', ['playlist:read'], '30d')
    const year = store.create('user', 'Year', ['history:read'], '1y')
    const forever = store.create('user', 'Forever', ['playlist:read'], 'never')
    assert.match(first.token, /^lux_mcp_[A-Za-z0-9_-]{43}$/)
    const disk = fs.readFileSync(file(), 'utf-8')
    assert.ok(!disk.includes(first.token))
    assert.match(JSON.parse(disk).tokens[0].hash, /^[a-f0-9]{64}$/)
    assert.equal(new PatStore(file()).lookup(first.token)?.id, first.id)
    assert.equal(year.expiresAt! - year.createdAt, 365 * 86400000)
    time = first.expiresAt!
    assert.equal(store.lookup(first.token), null)
    assert.ok(store.lookup(year.token))
    assert.ok(store.lookup(forever.token))
    assert.equal(store.revoke(forever.id, 'other'), false)
    assert.equal(store.revoke(forever.id, 'user'), true)
    assert.equal(store.revoke(forever.id, 'user'), true)
    assert.equal(store.lookup(forever.token), null)
  })
  it('throttles last-used persistence to once per minute and writes atomically', t => {
    let time = Date.now()
    const store = new PatStore(file(), () => time)
    const token = store.create('user', 'Bot', ['playlist:read'], 'never')
    store.touch(token.id)
    const disk = fs.readFileSync(file(), 'utf-8')
    time += 59999
    store.touch(token.id)
    assert.equal(fs.readFileSync(file(), 'utf-8'), disk)
    time++
    store.touch(token.id)
    assert.equal(store.listForUser('user')[0].lastUsedAt, time)
    const saved = fs.readFileSync(file(), 'utf-8')
    t.mock.method(fs, 'renameSync', () => { throw new Error('rename failed') })
    assert.throws(() => store.revoke(token.id, 'user'), /rename failed/)
    assert.equal(fs.readFileSync(file(), 'utf-8'), saved)
    assert.ok(store.lookup(token.token))
    assert.ok(!fs.readdirSync(path.dirname(file())).some(name => name.includes('.tmp-')))
  })
  it('keeps activity unchanged if atomic persistence fails', t => {
    const store = new PatStore(file())
    const token = store.create('user', 'Bot', ['playlist:read'], 'never')
    const entry = { at: Date.now(), action: 'history.read', summary: 'GET 200', ok: true }
    store.recordActivity(token.id, entry)
    t.mock.method(fs, 'renameSync', () => { throw new Error('rename failed') })
    assert.throws(() => store.recordActivity(token.id, { ...entry, ok: false }), /rename failed/)
    assert.deepEqual(store.activity(token.id, 'user'), [entry])
    assert.deepEqual(new PatStore(file()).activity(token.id, 'user'), [entry])
  })
  it('refuses corrupt stores without replacing them', () => {
    fs.writeFileSync(file(), '{broken')
    assert.throws(() => new PatStore(file()), /Refusing to start/)
    assert.equal(fs.readFileSync(file(), 'utf-8'), '{broken')
  })
  it('validates settings, returns plaintext once, isolates ownership and rejects PATs on session routes', async() => {
    let store = getAccountStore()
    await store.createUser({ username: 'alice', password: 'secret-pass' })
    await store.createUser({ username: 'bob', password: 'secret-pass' })
    const login = async(username: string) => parseJson((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'secret-pass' } })).body).accessToken
    const headers = { authorization: `Bearer ${await login('alice')}` }
    const payload = { name: 'Bot', scopes: ['playlist:read'], expiry: 'never' }
    for (const invalid of [{ name: '' }, { name: 'a'.repeat(41) }, { scopes: [] }, { scopes: ['unknown'] }, { expiry: '7d' }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/me/tokens', headers, payload: { ...payload, ...invalid } })).statusCode, 400)
    }
    const created = await app.inject({ method: 'POST', url: '/api/me/tokens', headers, payload })
    assert.equal(created.statusCode, 201)
    const token = parseJson(created.body)
    assert.equal(token.hash, undefined)
    const list = await app.inject({ url: '/api/me/tokens', headers })
    assert.ok(!list.body.includes(token.token))
    assert.ok(!list.body.includes('hash'))
    assert.equal(parseJson(list.body).tokens[0].last4, token.token.slice(-4))
    const patHeaders = { authorization: `Bearer ${token.token}` }
    const who = await app.inject({ url: '/api/v1/token/whoami', headers: patHeaders })
    assert.equal(who.statusCode, 200)
    assert.deepEqual(parseJson(who.body), { name: 'Bot', scopes: ['playlist:read'], username: 'alice' })
    for (const [method, url] of [['GET', '/api/auth/me'], ['GET', '/api/me/profile'], ['GET', '/api/admin/users'], ['GET', '/api/me/tokens'], ['POST', '/api/me/tokens'], ['DELETE', `/api/me/tokens/${token.id}`]] as const) {
      assert.equal((await app.inject({ method, url, headers: patHeaders, ...(method == 'POST' ? { payload } : {}) })).statusCode, 401)
    }
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/me/tokens/${token.id}`, headers: { authorization: `Bearer ${await login('bob')}` } })).statusCode, 404)
    // Scope enforcement is also directly callable by future route handlers.
    assert.throws(() => authenticatePat({ headers: patHeaders } as any, ['playlist:write']), { statusCode: 403 })
    const user = store.findManagedUserByUsername('alice')!
    store.updateUser(user.id, { status: 'disabled' })
    const probe = (value = token.token) => app.inject({ url: '/api/v1/token/whoami', headers: { authorization: `Bearer ${value}` } })
    assert.equal((await probe()).statusCode, 401)
    store.updateUser(user.id, { status: 'active' })
    assert.equal((await probe()).statusCode, 200)
    assert.equal((await probe('lux_mcp_' + 'x'.repeat(43))).statusCode, 401)
    const now = Date.now() - 31 * 86400000
    const expired = new PatStore(file(), () => now).create(user.id, 'Expired', ['playlist:read'], '30d')
    // Load the persisted expired token into the live store.
    store = initAccountStore(global.lx.dataPath)
    assert.equal((await probe(expired.token)).statusCode, 401)
    for (let i = 0; i < 2; i++) assert.equal((await app.inject({ method: 'DELETE', url: `/api/me/tokens/${token.id}`, headers: { authorization: `Bearer ${await login('alice')}` } })).statusCode, 200)
    assert.equal((await probe()).statusCode, 401)
    store.updateUser(user.id, { status: 'disabled' })
    store.updateUser(user.id, { status: 'active' })
    assert.equal((await probe()).statusCode, 401)
    const surviving = store.pats.create(user.id, 'Delete', ['playlist:read'], 'never')
    store.deleteManagedUser(user.id)
    assert.equal((await probe(surviving.token)).statusCode, 401)
  })
  it('advertises token capability and the configured MCP address', async() => {
    const previous = process.env.LUX_PUBLIC_URL
    try {
      delete process.env.LUX_PUBLIC_URL
      const local = resetTestState()
      const info = parseJson((await local.inject({ url: '/api/server-info' })).body)
      assert.deepEqual(info.mcp, { tokens: true })
      assert.equal(info.mcpUrl, undefined)
      process.env.LUX_PUBLIC_URL = 'https://lux.example'
      const configured = resetTestState()
      assert.equal(parseJson((await configured.inject({ url: '/api/server-info' })).body).mcpUrl, 'https://lux.example/mcp')
    } finally {
      if (previous === undefined) delete process.env.LUX_PUBLIC_URL
      else process.env.LUX_PUBLIC_URL = previous
    }
  })
})
