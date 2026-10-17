import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatEnvForLog, redactEnv } from '../src/utils/redactEnv'

describe('environment log redaction', () => {
  it('masks sensitive keys case insensitively without changing the input', () => {
    const env = {
      LX_USER_a: 'secret',
      LX_USER_json: '{"password":"json-password"}',
      LUX_ADMIN_PASSWORD: 'admin-password',
      LUX_TOKEN_SECRET: 'signing-value',
      API_TOKEN: 'token-value',
      api_key: 'key-value',
      clientSecret: 'client-value',
      PASSWORD: '',
      PORT: '9527',
      DEBUG: '1',
      OPTIONAL: undefined,
    }
    const original = { ...env }

    assert.deepEqual(redactEnv(env), {
      LX_USER_a: '***',
      LX_USER_json: '***',
      LUX_ADMIN_PASSWORD: '***',
      LUX_TOKEN_SECRET: '***',
      API_TOKEN: '***',
      api_key: '***',
      clientSecret: '***',
      PASSWORD: '***',
      PORT: '9527',
      DEBUG: '1',
      OPTIONAL: undefined,
    })
    assert.deepEqual(env, original)
  })

  it('formats redacted values while preserving ordinary settings', () => {
    assert.equal(formatEnvForLog({ LX_USER_a: 'secret', PORT: '9527' }), 'LX_USER_a: ***\n  PORT: 9527')
    assert.equal(formatEnvForLog({}), '')
  })
})
