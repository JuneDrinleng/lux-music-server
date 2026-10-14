import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { getAccountStore } from '../src/account/store'
import { getUserDirname } from '../src/user'
import { parseJson, resetTestState } from './helpers'

describe('admin delete user', () => {
  let app: FastifyInstance

  beforeEach(() => {
    app = resetTestState()
  })

  afterEach(async() => {
    await app.close()
  })

  const login = async(username: string, password: string) => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username, password },
    })
    assert.equal(result.statusCode, 200, result.body)
    return parseJson(result.body).token as string
  }

  const setupAdminAndUser = async() => {
    const admin = await getAccountStore().createUser({ username: 'admin-del', password: 'admin-pass', role: 'admin' })
    const victim = await getAccountStore().createUser({ username: 'victim-user', password: 'victim-pass', role: 'user' })
    const adminToken = await login('admin-del', 'admin-pass')
    return { admin, victim, adminToken }
  }

  it('deletes a managed user and removes on-disk data', async() => {
    const { victim, adminToken } = await setupAdminAndUser()
    const userDir = path.join(global.lx.userPath, getUserDirname(victim.username))
    assert.ok(fs.existsSync(userDir))

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${victim.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(parseJson(res.body).ok, true)
    assert.equal(getAccountStore().findManagedUserById(victim.id), null)
    assert.equal(fs.existsSync(userDir), false)
  })

  it('rejects deleting yourself', async() => {
    const { admin, adminToken } = await setupAdminAndUser()
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${admin.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    assert.equal(res.statusCode, 400)
    assert.match(parseJson(res.body).message as string, /yourself/i)
  })

  it('rejects deleting the last active admin', async() => {
    const { admin } = await setupAdminAndUser()
    assert.throws(
      () => getAccountStore().deleteManagedUser(admin.id),
      (err: unknown) => err instanceof Error && /last admin/i.test(err.message),
    )
  })

  it('allows deleting an admin when another active admin remains', async() => {
    await getAccountStore().createUser({ username: 'admin-a', password: 'pass-a', role: 'admin' })
    const adminB = await getAccountStore().createUser({ username: 'admin-b', password: 'pass-b', role: 'admin' })
    const token = await login('admin-a', 'pass-a')

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${adminB.id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(getAccountStore().findManagedUserByUsername('admin-b'), null)
  })

  it('removes invites created by the deleted user', async() => {
    const { victim, adminToken } = await setupAdminAndUser()
    const { invite } = getAccountStore().createInvite({ createdBy: victim.id, role: 'user', maxUses: 1 })
    assert.ok(getAccountStore().getInvites().some(row => row.id == invite.id))

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${victim.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(getAccountStore().getInvites().some(row => row.id == invite.id), false)
  })

  it('requires admin auth', async() => {
    const { victim } = await setupAdminAndUser()
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${victim.id}`,
    })
    assert.equal(res.statusCode, 401)
  })
})
