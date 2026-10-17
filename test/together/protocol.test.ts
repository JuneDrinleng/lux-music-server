import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createMsg2call } from 'message2call'
import { getAccountStore } from '../../src/account/store'
import { featureVersion } from '../../src/modules'
import * as listSyncModule from '../../src/modules/list/sync/sync'
import { getRoomManager, RoomManager, setRoomManager } from '../../src/modules/together'
import { TOGETHER_METHODS } from '../../src/modules/together/protocol'
import handler from '../../src/modules/together/sync/handler'
import { sync as togetherSync } from '../../src/modules/together/sync/sync'
import { callObj } from '../../src/server/sync'
import featureHandler from '../../src/server/sync/handler'
import { sync } from '../../src/server/sync/sync'
import { syncLog } from '../../src/utils/log4js'
import { parseJson, resetTestState } from '../helpers'
import { createFakeClock, createFakeSocket, unwrap } from './fakes'
import type { FastifyInstance } from 'fastify'

describe('together protocol wiring', () => {
  let app: FastifyInstance

  beforeEach(async() => {
    app = resetTestState()
    await getAccountStore().createUser({ username: 'alice', password: 'secret-pass', role: 'admin' })
    await getAccountStore().createUser({ username: 'bob', password: 'secret-pass', role: 'user', displayName: 'Bobby' })
    setRoomManager(new RoomManager({ config: { maxMembers: 10, maxRooms: 100, graceMs: 30_000 }, clock: createFakeClock().clock }))
  })

  afterEach(() => {
    setRoomManager(null)
  })

  it('advertises together=1 and exposes every method on callObj', () => {
    assert.equal(featureVersion.together, 1)
    assert.equal(featureVersion.list, 1)
    assert.equal(featureVersion.dislike, 1)
    for (const method of Object.values(TOGETHER_METHODS)) assert.equal(typeof (callObj as Record<string, unknown>)[method], 'function', method)
  })

  it('only enables together when negotiated, and throws when it is not', async() => {
    const socket = createFakeSocket('c_alice', 'alice')
    socket.moduleReadys.together = false
    socket.feature.together = false
    await assert.rejects(handler['together:ping'](socket, { t0: 1 }), /together is not enabled/)

    let advertised: Record<string, number> | null = null
    socket.remote = {
      async getEnabledFeatures(_type: string, supported: Record<string, number>) {
        advertised = supported
        return {}
      },
      async together_sync_finished() {},
      async finished() {},
    } as unknown as LX.Socket['remote']
    await sync(socket)
    assert.equal(advertised!.together, 1)
    assert.equal(socket.moduleReadys.together, false)

    let togetherFinished = 0
    socket.remote.getEnabledFeatures = async() => ({ together: true })
    socket.remote.together_sync_finished = async() => { togetherFinished++ }
    await sync(socket)
    assert.equal(socket.moduleReadys.together, true)
    assert.equal(togetherFinished, 1)
    assert.equal(socket.feature.together, true)
    assert.equal(unwrap(await handler['together:ping'](socket, { t0: 5 })).t0, 5)

    await featureHandler.onFeatureChanged(socket, { together: false })
    assert.equal(socket.moduleReadys.together, false)
  })

  it('ignores source requests during negotiation and feature changes while keeping together working', async() => {
    const socket = createFakeSocket('c_alice', 'alice')
    socket.moduleReadys.together = false
    socket.feature.together = false
    let finished = 0
    let togetherFinished = 0
    const sourceOnly: LX.Sync.EnabledFeatures & { source: boolean } = { source: true }
    socket.remote = {
      async getEnabledFeatures(_type: string, supported: Record<string, number>) {
        assert.equal('source' in supported, false)
        return sourceOnly
      },
      async together_sync_finished() { togetherFinished++ },
      async finished() { finished++ },
    } as unknown as LX.Socket['remote']

    await sync(socket)
    assert.equal(finished, 1)
    assert.equal(togetherFinished, 0)
    assert.equal(socket.moduleReadys.together, false)
    assert.equal('source' in socket.feature, false)
    assert.equal('source' in socket.moduleReadys, false)

    socket.remote.getEnabledFeatures = async() => ({ ...sourceOnly, together: true })
    await sync(socket)
    assert.equal(finished, 2)
    assert.equal(togetherFinished, 1)
    assert.equal('source' in socket.feature, false)
    assert.equal('source' in socket.moduleReadys, false)
    assert.equal(Object.keys(callObj).some(method => method.startsWith('source:')), false)
    assert.equal(unwrap(await handler['together:ping'](socket, { t0: 7 })).t0, 7)

    await featureHandler.onFeatureChanged(socket, sourceOnly)
    assert.equal(togetherFinished, 1)
    assert.equal(socket.moduleReadys.together, true)
    const disabled = { source: true, together: false }
    await featureHandler.onFeatureChanged(socket, disabled)
    assert.equal(socket.moduleReadys.together, false)
    const enabled = { source: true, together: true }
    await featureHandler.onFeatureChanged(socket, enabled)
    assert.equal(togetherFinished, 2)
    assert.equal('source' in socket.feature, false)
    assert.equal('source' in socket.moduleReadys, false)
    assert.equal(unwrap(await handler['together:ping'](socket, { t0: 8 })).t0, 8)
  })

  it('uses managed account fields, rejects legacy config users, and rebinds on reconnect sync', async() => {
    global.lx.config.users = [{ name: 'legacy', password: 'code', dataPath: '' }]
    const legacy = createFakeSocket('c_legacy', 'legacy')
    assert.equal((await handler['together:createRoom'](legacy)).ok, false)

    const alice = createFakeSocket('c_alice', 'alice')
    const bob = createFakeSocket('c_bob', 'bob')
    const room = unwrap(await handler['together:createRoom'](alice))
    const joined = unwrap(await handler['together:joinRoom'](bob, { code: room.code }))
    const bobMember = joined.members.find(m => m.memberId == 'c_bob')!
    assert.equal(bobMember.displayName, 'Bobby')
    assert.equal(bobMember.username, 'bob')
    assert.equal(bobMember.userId, getAccountStore().findManagedUserByUsername('bob')!.id)
    assert.equal(bobMember.avatar, '')

    await togetherSync(bob)
    alice.takePushes()
    bob.close()
    assert.deepEqual(alice.takePushes('together:onMemberChanged').map(p => p.payload.change.type), ['offline'])

    const bob2 = createFakeSocket('c_bob', 'bob')
    await togetherSync(bob2)
    assert.deepEqual(alice.takePushes('together:onMemberChanged').map(p => p.payload.change.type), ['online'])
    assert.equal(unwrap(await handler['together:getRoom'](bob2))!.roomId, room.roomId)
  })

  it('does not resume together sync after a socket closes during another feature resync', async t => {
    const clock = createFakeClock()
    setRoomManager(new RoomManager({ config: { graceMs: 30_000 }, clock: clock.clock }))
    const alice = createFakeSocket('c_alice', 'alice')
    const bob = createFakeSocket('c_bob', 'bob')
    const room = unwrap(await handler['together:createRoom'](alice))
    unwrap(await handler['together:joinRoom'](bob, { code: room.code }))
    await togetherSync(alice)
    alice.takePushes()
    let resume!: () => void
    t.mock.method(listSyncModule, 'sync', async(socket: LX.Socket) => {
      await new Promise<void>(resolve => { resume = resolve })
      socket.moduleReadys.list = true
    })

    const pending = featureHandler.onFeatureChanged(alice, { list: { skipSnapshot: true }, together: true })
    alice.close()
    resume()
    await assert.rejects(pending, /disconnected/)
    assert.equal(alice.moduleReadys.list, false)
    assert.equal(alice.moduleReadys.together, false)
    assert.equal(alice.takePushes('together_sync_finished').length, 0)
    assert.equal(unwrap(await handler['together:getRoom'](bob))!.members.find(m => m.memberId == room.hostId)!.online, false)
    clock.advance(30_001)
    assert.equal(unwrap(await handler['together:getRoom'](bob))!.hostId, 'c_bob')
    await assert.rejects(togetherSync(alice), /disconnected/)
  })

  it('releases members and transfers the host when the feature is disabled', async() => {
    const alice = createFakeSocket('c_alice', 'alice')
    const bob = createFakeSocket('c_bob', 'bob')
    const room = unwrap(await handler['together:createRoom'](alice))
    unwrap(await handler['together:joinRoom'](bob, { code: room.code }))
    await featureHandler.onFeatureChanged(bob, { together: false })
    assert.equal(unwrap(getRoomManager().getRoom(bob)), null)
    assert.deepEqual(unwrap(await handler['together:getRoom'](alice))!.members.map(m => m.memberId), ['c_alice'])

    await featureHandler.onFeatureChanged(bob, { together: true })
    assert.equal(unwrap(await handler['together:getRoom'](bob)), null)
    unwrap(await handler['together:joinRoom'](bob, { code: room.code }))
    alice.takePushes()
    await featureHandler.onFeatureChanged(alice, { together: false })
    assert.equal(unwrap(getRoomManager().getRoom(alice)), null)
    assert.equal(unwrap(await handler['together:getRoom'](bob))!.hostId, 'c_bob')
    assert.equal(alice.takePushes().length, 0)
  })

  it('does not broadcast room updates to a socket without together readiness', async() => {
    const alice = createFakeSocket('c_alice', 'alice')
    const bob = createFakeSocket('c_bob', 'bob')
    const room = unwrap(await handler['together:createRoom'](alice))
    unwrap(await handler['together:joinRoom'](bob, { code: room.code }))
    bob.takePushes()
    bob.moduleReadys.together = false
    unwrap(await handler['together:closeRoom'](alice, { roomId: room.roomId }))
    assert.equal(bob.takePushes().length, 0)
  })

  it('a newer disable supersedes a together resync suspended behind another module', async t => {
    const alice = createFakeSocket('c_alice', 'alice')
    const bob = createFakeSocket('c_bob', 'bob')
    const room = unwrap(await handler['together:createRoom'](alice))
    unwrap(await handler['together:joinRoom'](bob, { code: room.code }))
    let resume!: () => void
    t.mock.method(listSyncModule, 'sync', async() => new Promise<void>(resolve => { resume = resolve }))
    const pending = featureHandler.onFeatureChanged(alice, { list: { skipSnapshot: true }, together: true })
    await featureHandler.onFeatureChanged(alice, { together: false })
    resume()
    await pending
    assert.equal(alice.feature.together, false)
    assert.equal(alice.moduleReadys.together, false)
    assert.equal(alice.takePushes('together_sync_finished').length, 0)
    assert.equal(unwrap(await handler['together:getRoom'](bob))!.hostId, 'c_bob')

    const olderEnable = featureHandler.onFeatureChanged(alice, { list: { skipSnapshot: true }, together: true })
    await featureHandler.onFeatureChanged(alice, { together: false })
    await featureHandler.onFeatureChanged(alice, { together: true })
    resume()
    await olderEnable
    assert.equal(alice.moduleReadys.together, true)
    assert.equal(alice.takePushes('together_sync_finished').length, 1, 'only the latest enable may sync')
  })

  for (const failure of ['rejection', 'timeout']) {
    it(`logs together_sync_finished ${failure} and releases the failed module's membership`, async t => {
      const alice = createFakeSocket('c_alice', 'alice')
      const bob = createFakeSocket('c_bob', 'bob')
      const room = unwrap(await handler['together:createRoom'](alice))
      unwrap(await handler['together:joinRoom'](bob, { code: room.code }))
      const warnings = t.mock.method(syncLog, 'warn', () => {})
      if (failure == 'timeout') {
        const rpc = createMsg2call({ funcsObj: {}, timeout: 10, sendMessage() {} })
        alice.remote = rpc.remote as LX.Socket['remote']
        t.after(() => rpc.destroy())
      } else {
        alice.remote = { async together_sync_finished() { throw new Error('ack rejected') } } as unknown as LX.Socket['remote']
      }
      // The feature-change path catches module errors; cleanup must happen inside together sync.
      await featureHandler.onFeatureChanged(alice, { together: true })
      assert.equal(warnings.mock.callCount(), 1)
      assert.match(String(warnings.mock.calls[0].arguments[0]), /together sync acknowledgement failed/)
      assert.equal(alice.moduleReadys.together, false)
      await assert.rejects(handler['together:ping'](alice, { t0: 1 }), /together is not enabled/)
      assert.equal(unwrap(getRoomManager().getRoom(alice)), null)
      assert.equal(unwrap(await handler['together:getRoom'](bob))!.hostId, 'c_bob')
    })
  }

  it('an older failed acknowledgement cannot disable a newer successful together sync', async t => {
    const alice = createFakeSocket('c_alice', 'alice')
    const room = unwrap(await handler['together:createRoom'](alice))
    let reject!: (error: Error) => void
    let calls = 0
    alice.remote = {
      async together_sync_finished() {
        if (++calls == 1) await new Promise<void>((_resolve, fail) => { reject = fail })
      },
    } as unknown as LX.Socket['remote']
    t.mock.method(syncLog, 'warn', () => {})
    const pending = featureHandler.onFeatureChanged(alice, { together: true })
    await featureHandler.onFeatureChanged(alice, { together: true })
    reject(new Error('old acknowledgement failed'))
    await pending
    assert.equal(alice.moduleReadys.together, true)
    assert.equal(unwrap(await handler['together:getRoom'](alice))!.roomId, room.roomId)
  })

  it('routes calls and pushes through message2call', async() => {
    const alice = createFakeSocket('c_alice', 'alice')
    const pushes: Array<{ name: string, payload: any }> = []
    const bobSocket = createFakeSocket('c_bob', 'bob')
    let client!: ReturnType<typeof createMsg2call>
    const server = createMsg2call({
      funcsObj: callObj,
      sendMessage(data: unknown) { client.message(data) },
      onCallBeforeParams(rawArgs: unknown[]) { return [bobSocket, ...rawArgs] },
    })
    client = createMsg2call({
      funcsObj: {
        'together:onRoomState'(payload: unknown) { pushes.push({ name: 'state', payload }) },
        'together:onRoomClosed'(payload: unknown) { pushes.push({ name: 'closed', payload }) },
      },
      sendMessage(data: unknown) { server.message(data) },
    })
    bobSocket.remote = server.remote as LX.Socket['remote']
    const remote = client.remote as unknown as LX.Sync.ServerSyncTogetherActions

    const room = unwrap(await handler['together:createRoom'](alice))
    const joined = unwrap(await remote['together:joinRoom']({ code: room.code }))
    assert.equal(joined.roomId, room.roomId)
    assert.equal(unwrap(await remote['together:ping']({ t0: 7 })).t0, 7)
    const notHost = await remote['together:closeRoom']({ roomId: room.roomId })
    assert.equal(notHost.ok, false)

    unwrap(await handler['together:hostUpdateState'](alice, {
      roomId: room.roomId,
      baseVersion: 1,
      musicInfo: null,
      quality: null,
      isPlaying: false,
      positionMs: 0,
      durationMs: 0,
      sampledAt: Date.now(),
    }))
    unwrap(await handler['together:closeRoom'](alice, { roomId: room.roomId }))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(pushes.map(p => p.name), ['state', 'closed'])
    assert.equal(pushes[1].payload.reason, 'host_closed')

    bobSocket.moduleReadys.together = false
    await assert.rejects(remote['together:getRoom'](), /together is not enabled/)
    server.destroy()
    client.destroy()
  })

  it('exposes a read-only admin room count', async() => {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/admin/together/rooms' })
    assert.equal(unauthorized.statusCode, 401)

    const login = async(username: string) => parseJson((await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.1',
      headers: { 'content-type': 'application/json' },
      payload: { username, password: 'secret-pass' },
    })).body).token as string
    const userToken = await login('bob')
    const forbidden = await app.inject({ method: 'GET', url: '/api/admin/together/rooms', headers: { authorization: `Bearer ${userToken}` } })
    assert.equal(forbidden.statusCode, 403)

    const alice = createFakeSocket('c_alice', 'alice')
    const room = unwrap(await handler['together:createRoom'](alice))
    unwrap(await handler['together:joinRoom'](createFakeSocket('c_bob', 'bob'), { code: room.code }))
    const adminToken = await login('alice')
    const res = await app.inject({ method: 'GET', url: '/api/admin/together/rooms', headers: { authorization: `Bearer ${adminToken}` } })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(parseJson(res.body), { activeRooms: 1, members: 2, onlineMembers: 2 })

    const post = await app.inject({ method: 'POST', url: '/api/admin/together/rooms', headers: { authorization: `Bearer ${adminToken}` } })
    assert.notEqual(post.statusCode, 200)
  })
})
