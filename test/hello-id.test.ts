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
  })
})
