import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { getAccountStore } from '../src/account/store'
import { getRoomManager, RoomManager, setRoomManager } from '../src/modules/together'
import * as server from '../src/server/server'
import { parseJson, resetTestState } from './helpers'
import { createFakeClock, createFakeSocket, unwrap } from './together/fakes'

describe('admin disable user', () => {
  let app: FastifyInstance

  beforeEach(() => {
    app = resetTestState()
    setRoomManager(new RoomManager({ clock: createFakeClock().clock }))
  })

  afterEach(async() => {
    setRoomManager(null)
    await app.close()
  })

  it('disconnects a disabled account and removes every membership, transferring its host role', async t => {
    const store = getAccountStore()
    const admin = await store.createUser({ username: 'disable-admin', password: 'admin-pass', role: 'admin' })
    const target = await store.createUser({ username: 'disable-target', password: 'target-pass', role: 'user' })
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: admin.username, password: 'admin-pass' } })
    assert.equal(login.statusCode, 200)
    const adminSocket = createFakeSocket('admin-device', admin.username)
    const targetHost = createFakeSocket('target-host', target.username)
    const targetMember = createFakeSocket('target-member', target.username)
    const targetOffline = createFakeSocket('target-offline', target.username)
    const manager = getRoomManager()
    const hostedRoom = unwrap(manager.createRoom(targetHost))
    unwrap(manager.joinRoom(adminSocket, { code: hostedRoom.code }))
    unwrap(manager.joinRoom(targetMember, { code: hostedRoom.code }))
    unwrap(manager.createRoom(targetOffline))
    manager.handleSocketClosed(targetOffline)

    const disconnect = t.mock.method(server, 'disconnectUserSessions', (username: string) => {
      assert.equal(username, target.username)
      assert.equal(store.findManagedUserById(target.id)!.status, 'disabled')
      for (const socket of [targetHost, targetMember]) {
        socket.moduleReadys.together = false
        socket.close()
        manager.handleSocketClosed(socket)
      }
    })
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${target.id}`,
      headers: { authorization: `Bearer ${parseJson(login.body).token}` },
      payload: { status: 'disabled' },
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(disconnect.mock.callCount(), 1)
    const remaining = unwrap(manager.getRoom(adminSocket))!
    assert.equal(remaining.hostId, adminSocket.keyInfo.clientId)
    assert.deepEqual(remaining.members.map(member => member.userId), [admin.id])
    assert.deepEqual(manager.getStats(), { activeRooms: 1, members: 1, onlineMembers: 1 })
    assert.equal(targetHost.takePushes('together:onHostChanged').length, 0)
    assert.equal(targetMember.takePushes('together:onHostChanged').length, 0)
  })
})
