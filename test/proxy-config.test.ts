import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { parseTrustProxy } from '../src/server/proxyConfig'
import { AUTH_FAIL_LIMIT, getRequestIP } from '../src/server/api/rateLimit'
import { parseJson, resetTestState } from './helpers'

describe('proxy configuration', () => {
  let app: FastifyInstance | undefined
  let env: NodeJS.ProcessEnv
  beforeEach(() => {
    env = { ...process.env }
    delete process.env.LUX_TRUST_PROXY
    delete process.env.LUX_PUBLIC_URL
  })
  afterEach(async() => {
    await app?.close()
    app = undefined
    process.env = env
  })

  for (const [setting, expected] of [
    [undefined, '127.0.0.1'], ['false', '127.0.0.1'], ['0', '127.0.0.1'],
    ['1', '198.51.100.8'], ['true', '198.51.100.8'],
    ['2', '198.51.100.8'], ['127.0.0.0/8, ::1/128', '198.51.100.8'],
    ['10.0.0.0/8', '127.0.0.1'],
  ] as const) {
    it(`resolves request.ip and limiter IP with trust=${setting}`, async() => {
      if (setting !== undefined) process.env.LUX_TRUST_PROXY = setting
      app = resetTestState()
      app.get('/test-ip', async request => ({ ip: request.ip, limiterIP: getRequestIP(request) }))
      const res = await app.inject({ url: '/test-ip', headers: { 'x-forwarded-for': '198.51.100.8' } })
      assert.deepEqual(parseJson(res.body), { ip: expected, limiterIP: expected })
    })
  }

  it('uses the hop count to stop at the nearest untrusted address', async() => {
    process.env.LUX_TRUST_PROXY = '2'
    app = resetTestState()
    app.get('/test-ip', async request => request.ip)
    const res = await app.inject({ url: '/test-ip', headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.8, 192.0.2.1' } })
    assert.equal(res.body, '198.51.100.8')
  })

  it('fails closed and warns on invalid proxy settings', t => {
    const warning = t.mock.method(console, 'warn', () => {})
    for (const input of ['yes', '-1', '10.0.0.0/99', '127.0.0.1,', '::1/129']) {
      assert.equal(parseTrustProxy(input), false)
    }
    assert.equal(warning.mock.callCount(), 5)
  })

  for (const trusted of [false, true]) {
    it(`rate limits by ${trusted ? 'forwarded' : 'socket'} IP with legacy PROXY_HEADER enabled`, async() => {
      process.env.LUX_TRUST_PROXY = trusted ? '127.0.0.1/32' : '0'
      const config = { ...global.lx.config }
      try {
        global.lx.config['proxy.enabled'] = true
        global.lx.config['proxy.header'] = 'x-forwarded-for'
        app = resetTestState()
        const check = (ip: string) => app!.inject({
          url: '/api/auth/invite/check?inviteCode=unknown', headers: { 'x-forwarded-for': ip },
        })
        for (let i = 0; i < AUTH_FAIL_LIMIT; i++) assert.equal((await check('198.51.100.8')).statusCode, 404)
        assert.equal((await check('198.51.100.8')).statusCode, 429)
        assert.equal((await check('198.51.100.9')).statusCode, trusted ? 404 : 429)
      } finally {
        global.lx.config = config
      }
    })
  }

  for (const value of [undefined, '', 'https://lux.example.com', 'http://localhost:9527/base',
    'https://lux.example.com/', 'ftp://lux.example.com', 'invalid', 'https://',
    ' https://lux.example.com', 'https://user:password@lux.example.com']) {
    it(`exposes only a valid public base URL: ${JSON.stringify(value)}`, async t => {
      if (value !== undefined) process.env.LUX_PUBLIC_URL = value
      const valid = value == 'https://lux.example.com' || value == 'http://localhost:9527/base'
      const warning = t.mock.method(console, 'warn', () => {})
      app = resetTestState()
      const res = await app.inject({ url: '/api/server-info' })
      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['cache-control'], 'no-store')
      assert.equal(parseJson(res.body).publicUrl, valid ? value : null)
      assert.equal(warning.mock.callCount(), value && !valid ? 1 : 0)
    })
  }
})
