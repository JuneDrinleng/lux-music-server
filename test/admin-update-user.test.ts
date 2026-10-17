import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { getAccountStore } from '../src/account/store'
import * as server from '../src/server/server'
import { parseJson, resetTestState } from './helpers'

describe('admin update user protection', () => {
  let app: FastifyInstance

  beforeEach(() => {
    app = resetTestState()
  })

  afterEach(async() => {
    await app.close()
  })

  const createAdmin = (username: string) => getAccountStore().createUser({ username, password: 'admin-pass', role: 'admin' })
  const login = async(username: string) => {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { username, password: 'admin-pass' },
    })
    assert.equal(response.statusCode, 200, response.body)
    return { authorization: `Bearer ${parseJson(response.body).token}` }
  }
  const snapshot = () => ({
    users: structuredClone(getAccountStore().getManagedUsers()),
    syncUsers: structuredClone(global.lx.config.users),
    file: fs.readFileSync(path.join(global.lx.dataPath, 'lux', 'accounts.json'), 'utf-8'),
  })

  for (const patch of [{ status: 'disabled' }, { role: 'user' }] as const) {
    const action = 'status' in patch ? 'disable' : 'demote'

    for (const otherActiveAdmin of [false, true]) {
      it(`rejects self ${action} with ${otherActiveAdmin ? 'two active admins' : 'one admin'} without changing state`, async t => {
        const admin = await createAdmin('admin-a')
        if (otherActiveAdmin) await createAdmin('admin-b')
        const headers = await login(admin.username)
        const before = snapshot()
        const disconnect = t.mock.method(server, 'disconnectUserSessions', () => {})
        const response = await app.inject({
          method: 'PATCH', url: `/api/admin/users/${admin.id}`, headers,
          payload: { ...patch, displayName: 'must not persist' },
        })
        assert.equal(response.statusCode, 409, response.body)
        assert.deepEqual(parseJson(response.body), { message: 'Cannot disable or demote yourself', code: 'SELF_DEMOTE' })
        assert.deepEqual(snapshot(), before)
        assert.equal(disconnect.mock.callCount(), 0)
      })
    }

    it(`allows an admin to ${action} another admin when two are active`, async() => {
      const admin = await createAdmin('admin-a')
      const target = await createAdmin('admin-b')
      const headers = await login(admin.username)
      const response = await app.inject({
        method: 'PATCH', url: `/api/admin/users/${target.id}`, headers, payload: patch,
      })
      assert.equal(response.statusCode, 200, response.body)
      const updated = getAccountStore().findManagedUserById(target.id)!
      assert.equal(updated.status, 'status' in patch ? 'disabled' : 'active')
      assert.equal(updated.role, 'role' in patch ? 'user' : 'admin')
      assert.equal(getAccountStore().hasManagedAdmin(), true)
    })

    for (const disabledAdmin of [false, true]) {
      it(`store rejects last active admin ${action} ${disabledAdmin ? 'with a disabled admin' : 'with one admin'}`, async() => {
        const store = getAccountStore()
        const admin = await createAdmin('admin-a')
        if (disabledAdmin) {
          const other = await createAdmin('admin-b')
          store.updateUser(other.id, { status: 'disabled' })
        }
        store.setBaselineConfigUsers([{ name: 'legacy', password: 'sync-code', dataPath: '' }])
        const before = snapshot()
        assert.throws(
          () => store.updateUser(admin.id, { ...patch, displayName: 'must not persist' }),
          { message: 'Cannot disable or demote the last active admin' },
        )
        assert.deepEqual(snapshot(), before)
      })
    }

    it(`returns 409 for last active admin ${action} when the actor is disabled after authorization`, async t => {
      const store = getAccountStore()
      const actor = await createAdmin('admin-a')
      const target = await createAdmin('admin-b')
      const headers = await login(actor.username)
      const updateUser = store.updateUser.bind(store)
      let before: ReturnType<typeof snapshot> | undefined
      // Model an already authorized request while another admin disables its actor.
      // A new request using that actor's token would instead receive 401.
      t.mock.method(store, 'updateUser', (...args: Parameters<typeof store.updateUser>) => {
        updateUser(actor.id, { status: 'disabled' }, target.id)
        before = snapshot()
        return updateUser(...args)
      })
      const disconnect = t.mock.method(server, 'disconnectUserSessions', () => {})
      const response = await app.inject({
        method: 'PATCH', url: `/api/admin/users/${target.id}`, headers,
        payload: { ...patch, displayName: 'must not persist' },
      })
      assert.equal(response.statusCode, 409, response.body)
      assert.deepEqual(parseJson(response.body), { message: 'Cannot disable or demote the last active admin', code: 'LAST_ADMIN' })
      assert.ok(before)
      assert.deepEqual(snapshot(), before)
      // Disabling the actor revokes its sync access; the rejected target update
      // must not disconnect any additional user.
      assert.deepEqual(disconnect.mock.calls.map(call => call.arguments), [[actor.username, undefined]])
    })

    it(`store rejects self ${action} even when another active admin remains`, async() => {
      const admin = await createAdmin('admin-a')
      await createAdmin('admin-b')
      const before = snapshot()
      assert.throws(
        () => getAccountStore().updateUser(admin.id, patch, admin.id),
        { message: 'Cannot disable or demote yourself' },
      )
      assert.deepEqual(snapshot(), before)
    })
  }

  it('allows self profile edits', async() => {
    const admin = await createAdmin('admin-a')
    const headers = await login(admin.username)
    const response = await app.inject({
      method: 'PATCH', url: `/api/admin/users/${admin.id}`, headers,
      payload: { displayName: 'New name', role: 'admin', status: 'active' },
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(parseJson(response.body).user.displayName, 'New name')
    assert.equal(getAccountStore().findManagedUserById(admin.id)!.displayName, 'New name')
  })

  it('keeps 404 for missing users', async() => {
    const admin = await createAdmin('admin-a')
    const headers = await login(admin.username)
    const response = await app.inject({
      method: 'PATCH', url: '/api/admin/users/missing', headers, payload: { status: 'disabled' },
    })
    assert.equal(response.statusCode, 404, response.body)
    assert.deepEqual(parseJson(response.body), { message: 'User not found', code: 'USER_NOT_FOUND' })
  })
})
