import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { SYNC_CODE } from '../src/constants'
import { getServerId } from '../src/user'
import { parseJson, resetTestState } from './helpers'
import type { FastifyInstance } from 'fastify'

describe('sync protocol contracts', () => {
  let app: FastifyInstance

  beforeEach(() => {
    app = resetTestState()
  })

  it('GET /hello returns protocol hello message', async() => {
    const res = await app.inject({ method: 'GET', url: '/hello' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, SYNC_CODE.helloMsg)
  })

  it('GET /id returns idPrefix + serverId', async() => {
    const res = await app.inject({ method: 'GET', url: '/id' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, SYNC_CODE.idPrefix + getServerId())
  })

  it('GET /api/health returns ok', async() => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    assert.equal(res.statusCode, 200)
    const body = parseJson(res.body)
    assert.equal(body.ok, true)
    assert.equal(typeof body.version, 'string')
  })

  it('returns 404 for retired cloud source APIs', async() => {
    const endpoints = [
      { method: 'GET', url: '/api/admin/sources' },
      { method: 'POST', url: '/api/admin/sources' },
      { method: 'POST', url: '/api/admin/sources/retired/enable' },
      { method: 'POST', url: '/api/admin/sources/retired/disable' },
      { method: 'PUT', url: '/api/admin/sources/order' },
      { method: 'DELETE', url: '/api/admin/sources/retired' },
      { method: 'POST', url: '/api/admin/sources/retired/test' },
      { method: 'GET', url: '/api/source/stream/retired' },
    ] as const
    for (const endpoint of endpoints) {
      const res = await app.inject(endpoint)
      assert.equal(res.statusCode, 404, `${endpoint.method} ${endpoint.url}`)
      assert.equal(parseJson(res.body).message, 'API route not found')
    }
  })
})
