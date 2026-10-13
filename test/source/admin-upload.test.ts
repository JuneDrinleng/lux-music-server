import fs from 'node:fs'
import path from 'node:path'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { getAccountStore } from '../../src/account/store'
import { SOURCE_LIMITS } from '../../src/modules/source/protocol'
import { parseJson, resetTestState } from '../helpers'
import type { FastifyInstance } from 'fastify'

const YEHUA = path.join(__dirname, '../fixtures/yehua-v1.js')

const HEADER = `/**
 * @name test-src
 * @description sandbox test
 * @version 1.0.0
 * @author test
 * @homepage https://example.com
 */`

const minimalScript = `${HEADER}
void lx.send('inited', { sources: { kw: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } })
`

async function adminToken(app: FastifyInstance) {
  await getAccountStore().createUser({ username: 'admin', password: 'pass', role: 'admin' })
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: { username: 'admin', password: 'pass' },
  })
  assert.equal(login.statusCode, 200)
  return parseJson(login.body).token as string
}

describe('admin sources upload', () => {
  let app: FastifyInstance

  beforeEach(() => {
    app = resetTestState()
  })

  it('accepts pasted minimal valid script', async() => {
    const token = await adminToken(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/sources',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: { script: minimalScript },
    })
    assert.equal(res.statusCode, 200, res.body)
    const body = parseJson(res.body)
    assert.equal(body.script.name, 'test-src')
    assert.equal(body.script.enabled, false)
  })

  it('accepts yehua fixture with emoji in @name', async() => {
    const token = await adminToken(app)
    const script = fs.readFileSync(YEHUA, 'utf8')
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/sources',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: { script },
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(parseJson(res.body).script.name, '野花🌷')
  })

  it('rejects script without header with readable message', async() => {
    const token = await adminToken(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/sources',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: { script: 'void lx.send("inited", {})' },
    })
    assert.equal(res.statusCode, 422)
    assert.match(parseJson(res.body).message, /header comment/i)
  })

  it('accepts scriptBase64 payload', async() => {
    const token = await adminToken(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/sources',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: { scriptBase64: Buffer.from(minimalScript, 'utf8').toString('base64') },
    })
    assert.equal(res.statusCode, 200, res.body)
  })

  it('accepts script with leading blank lines before header', async() => {
    const token = await adminToken(app)
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/sources',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: { script: `\n\n${minimalScript}` },
    })
    assert.equal(res.statusCode, 200, res.body)
  })

  it('preserves leading and trailing whitespace in script body', async() => {
    const token = await adminToken(app)
    const padded = `\n${minimalScript}\n`
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/sources',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: { script: padded },
    })
    assert.equal(res.statusCode, 200, res.body)
    const id = parseJson(res.body).script.id as string
    const stored = fs.readFileSync(path.join(global.lx.dataPath, 'lux', 'sources', `${id}.js`), 'utf8')
    assert.equal(stored, padded)
  })

  it('returns JSON for unknown api routes', async() => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/sources/nope' })
    assert.equal(res.statusCode, 404)
    assert.equal(parseJson(res.body).message, 'API route not found')
  })

  it('allows large script bodies up to source limit on this route', async() => {
    const token = await adminToken(app)
    const pad = 'x'.repeat(300 * 1024)
    const big = `${HEADER}\nconst pad = ${JSON.stringify(pad)};\nvoid lx.send('inited', { sources: { kw: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } })\n`
    assert.ok(big.length > 256 * 1024)
    assert.ok(big.length < SOURCE_LIMITS.scriptChars)
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/sources',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: JSON.stringify({ script: big }),
    })
    assert.equal(res.statusCode, 200, res.body)
  })
})
