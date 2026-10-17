import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { getAccountStore, initAccountStore } from '../src/account/store'
import { parseJson, resetTestState } from './helpers'

describe('self profile validation', () => {
  let app: FastifyInstance
  let headers: { authorization: string }
  const accountFile = () => path.join(global.lx.dataPath, 'lux', 'accounts.json')
  const snapshot = () => ({
    users: structuredClone(getAccountStore().getManagedUsers()),
    syncUsers: structuredClone(global.lx.config.users),
    file: fs.readFileSync(accountFile(), 'utf8'),
  })

  beforeEach(async() => {
    app = resetTestState()
    await getAccountStore().createUser({ username: 'profile-user', password: 'profile-pass', displayName: 'Before' })
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { username: 'profile-user', password: 'profile-pass' },
    })
    assert.equal(login.statusCode, 200, login.body)
    headers = { authorization: `Bearer ${parseJson(login.body).token}` }
  })

  afterEach(async() => { await app.close() })

  for (const method of ['POST', 'PATCH'] as const) {
    for (const [field, value, code, status] of [
      ['displayName', 12, 'INVALID_DISPLAY_NAME', 400],
      ['displayName', 'x'.repeat(101), 'INVALID_DISPLAY_NAME', 400],
      ['avatar', {}, 'INVALID_AVATAR', 400],
      ['avatar', 'data:image/png;base64,' + 'a'.repeat(200 * 1024), 'AVATAR_TOO_LARGE', 413],
      ['signature', false, 'INVALID_SIGNATURE', 400],
      ['signature', 'x'.repeat(141), 'INVALID_SIGNATURE', 400],
      ['gender', 'other', 'INVALID_GENDER', 400],
      ['gender', null, 'INVALID_GENDER', 400],
      ['username', 'renamed', 'USERNAME_READONLY', 400],
    ] as const) {
      it(`${method} rejects invalid ${field} (${code}, ${typeof value}) without saving any fields`, async() => {
        const before = snapshot()
        const response = await app.inject({
          method, url: '/api/me/profile', headers,
          payload: { displayName: 'Changed', avatar: 'new-avatar', signature: 'Changed', gender: 'female', [field]: value },
        })
        assert.equal(response.statusCode, status, response.body)
        const error = parseJson(response.body)
        assert.equal(error.code, code)
        assert.ok(error.message)
        assert.deepEqual(snapshot(), before)
      })
    }

    it(`${method} trims and persists the compatible mobile payload and keeps the response fields`, async() => {
      const response = await app.inject({
        method, url: '/api/me/profile', headers,
        payload: { displayName: ' Nickname ', avatar: ' data:image/png;base64,YQ== ', gender: ' female ', signature: ' Hello ', ignored: true },
      })
      const expected = { username: 'profile-user', displayName: 'Nickname', avatar: 'data:image/png;base64,YQ==', gender: 'female', signature: 'Hello' }
      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(parseJson(response.body), { profile: expected })
      const get = await app.inject({ url: '/api/me/profile', headers })
      assert.deepEqual(parseJson(get.body), { profile: expected })
      const user = initAccountStore(global.lx.dataPath).findManagedUserByUsername('profile-user')!
      for (const [field, value] of Object.entries(expected)) assert.equal(user[field as keyof typeof user], value)
    })
  }

  it('accepts exact limits without truncation and all mobile genders', async() => {
    for (const gender of ['male', 'female', 'unknown']) {
      const payload = { displayName: 'x'.repeat(100), avatar: 'a'.repeat(200 * 1024), signature: 'x'.repeat(140), gender }
      const response = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers, payload })
      assert.equal(response.statusCode, 200, response.body.slice(0, 200))
      assert.deepEqual(parseJson(response.body), { profile: { username: 'profile-user', ...payload } })
    }
  })

  it('accepts empty fields, resets empty gender, and preserves omitted fields', async() => {
    const cleared = await app.inject({
      method: 'POST', url: '/api/me/profile', headers,
      payload: { displayName: ' ', avatar: '', signature: '', gender: '' },
    })
    assert.equal(cleared.statusCode, 200, cleared.body)
    assert.deepEqual(parseJson(cleared.body), {
      profile: { username: 'profile-user', displayName: '', avatar: '', gender: 'unknown', signature: '' },
    })
    const response = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers, payload: { ignored: 'value' } })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(parseJson(response.body), parseJson(cleared.body))
  })

  it('returns PROFILE_SAVE_FAILED and restores memory when persistence fails', async t => {
    const before = snapshot()
    t.mock.method(fs, 'renameSync', () => { throw new Error('disk unavailable') })
    const response = await app.inject({
      method: 'PATCH', url: '/api/me/profile', headers,
      payload: { displayName: 'Changed', avatar: 'new-avatar', gender: 'male', signature: 'Changed' },
    })
    assert.equal(response.statusCode, 500, response.body)
    assert.deepEqual(parseJson(response.body), { code: 'PROFILE_SAVE_FAILED', message: 'Failed to save profile' })
    assert.deepEqual(snapshot(), before)
  })
})
