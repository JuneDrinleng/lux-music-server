import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readTogetherConfig } from '../../src/modules/together/protocol'
import { codeOf, createFakeSocket, createTestManager, song, unwrap } from './fakes'

const setupRoom = (config = {}) => {
  const ctx = createTestManager(config)
  const host = createFakeSocket('c_host', 'alice')
  const room = unwrap(ctx.manager.createRoom(host))
  return { ...ctx, host, room }
}

const stateReq = (roomId: string, baseVersion: number, patch: Record<string, unknown> = {}) => ({
  roomId,
  baseVersion,
  musicInfo: song('1'),
  quality: '320k',
  isPlaying: true,
  positionMs: 10_000,
  durationMs: 180_000,
  sampledAt: 0,
  ...patch,
})

describe('together rooms: lifecycle', () => {
  it('creates a room with initial state and a 6-digit code', () => {
    const { manager, host, room, clock } = setupRoom()
    assert.match(room.code, /^[1-9]\d{5}$/)
    assert.match(room.roomId, /^[0-9a-f-]{36}$/)
    assert.equal(room.hostId, 'c_host')
    assert.deepEqual([room.version, room.playbackVersion, room.queueVersion], [1, 1, 1])
    assert.deepEqual(room.playback, { musicInfo: null, quality: null, isPlaying: false, positionMs: 0, durationMs: 0, updatedAt: clock.now() })
    assert.deepEqual(room.queue, { items: [], currentId: null })
    assert.equal(room.maxMembers, 10)
    assert.deepEqual(room.members.map(m => [m.memberId, m.userId, m.displayName, m.online]), [['c_host', 'u_alice', 'Alice', true]])
    assert.equal(codeOf(manager.createRoom(host)), 'ALREADY_IN_ROOM')
    assert.deepEqual(manager.getStats(), { activeRooms: 1, members: 1, onlineMembers: 1 })
  })

  it('evicts all memberships when a Lux account is deleted', () => {
    const { manager, host, room } = setupRoom()
    const bobPhone = createFakeSocket('c_bob_phone', 'bob')
    unwrap(manager.joinRoom(bobPhone, { code: room.code }))
    assert.equal(manager.getStats().members, 2)

    manager.evictUser('u_bob')
    assert.equal(manager.getStats().members, 1)
    assert.deepEqual(room.members.map(m => m.memberId), ['c_host'])
  })

  it('rejects accounts that are not active Lux accounts', () => {
    const { manager, room } = setupRoom()
    const legacy = createFakeSocket('c_legacy', 'config-user')
    assert.equal(codeOf(manager.createRoom(legacy)), 'NOT_LUX_ACCOUNT')
    assert.equal(codeOf(manager.joinRoom(legacy, { code: room.code })), 'NOT_LUX_ACCOUNT')
    assert.equal(codeOf(manager.getRoom(legacy)), 'NOT_LUX_ACCOUNT')
  })

  it('joins by code (whitespace tolerant), is idempotent, and broadcasts join to others', () => {
    const { manager, host, room, advance } = setupRoom()
    advance(10)
    const bob = createFakeSocket('c_bob', 'bob')
    const spaced = ` ${room.code.slice(0, 3)} ${room.code.slice(3)} `
    const joined = unwrap(manager.joinRoom(bob, { code: spaced }))
    assert.equal(joined.version, 2)
    assert.deepEqual(joined.members.map(m => m.memberId), ['c_host', 'c_bob'])
    assert.equal(joined.members[1].avatar, 'data:image/png;base64,AA==')

    const [push] = host.takePushes('together:onMemberChanged')
    assert.deepEqual(push.payload.change, { type: 'join', memberId: 'c_bob' })
    assert.equal(push.payload.version, 2)
    assert.equal(push.payload.roomId, room.roomId)
    assert.equal(bob.pushes.length, 0)

    const again = unwrap(manager.joinRoom(bob, { code: room.code }))
    assert.equal(again.version, 2)
    assert.equal(host.pushes.length, 0)

    const same = unwrap(manager.getRoom(bob))
    assert.equal(same?.roomId, room.roomId)
    assert.equal(unwrap(manager.getRoom(createFakeSocket('c_other', 'carol'))), null)
  })

  it('uses canonical device identity across alias reconnects while preserving public member IDs', () => {
    const { manager, advance, pendingTimers } = createTestManager({}, { c_alias: 'c_host' })
    const original = createFakeSocket('c_alias', 'alice')
    const host = createFakeSocket('c_host', 'alice', 'Renamed device')
    const bob = createFakeSocket('c_bob', 'bob')
    const room = unwrap(manager.createRoom(original))
    unwrap(manager.joinRoom(bob, { code: room.code }))
    manager.handleSocketClosed(original)
    advance(29_000)
    bob.takePushes()

    manager.handleSocketReady(host)
    const restored = unwrap(manager.getRoom(host))!
    assert.equal(restored.roomId, room.roomId)
    assert.equal(restored.hostId, 'c_alias')
    assert.deepEqual(restored.members.map(member => member.memberId), ['c_alias', 'c_bob'])
    assert.equal(restored.members[0].deviceName, 'Renamed device')
    assert.equal(restored.members[0].online, true)
    assert.equal(pendingTimers(), 0)
    assert.deepEqual(bob.takePushes('together:onMemberChanged')[0].payload.change, { type: 'online', memberId: 'c_alias' })
    assert.equal(codeOf(manager.createRoom(host)), 'ALREADY_IN_ROOM')
    assert.equal(unwrap(manager.joinRoom(host, { code: room.code })).members.length, 2)

    // Late events from the superseded credential cannot affect the bound socket.
    manager.handleSocketClosed(original)
    manager.handleSocketDisabled(original)
    assert.equal(pendingTimers(), 0)
    assert.equal(unwrap(manager.getRoom(host))!.members[0].online, true)
    assert.equal(codeOf(manager.hostUpdateState(host, stateReq(room.roomId, 1))), 'OK')
    unwrap(manager.transferHost(host, { roomId: room.roomId, memberId: 'c_bob' }))
    unwrap(manager.transferHost(bob, { roomId: room.roomId, memberId: 'c_alias' }))
    unwrap(manager.closeRoom(host, { roomId: room.roomId }))
    assert.equal(unwrap(manager.getRoom(original)), null)
    unwrap(manager.createRoom(host))
    assert.equal(codeOf(manager.createRoom(original)), 'ALREADY_IN_ROOM')
  })

  it('rebinds an idempotent join through an alias and removes the canonical membership on leave', () => {
    const { manager } = createTestManager({}, { c_alias: 'c_bob' })
    const host = createFakeSocket('c_host', 'alice')
    const bob = createFakeSocket('c_bob', 'bob')
    const alias = createFakeSocket('c_alias', 'bob')
    const room = unwrap(manager.createRoom(host))
    unwrap(manager.joinRoom(bob, { code: room.code }))
    const joined = unwrap(manager.joinRoom(alias, { code: room.code }))
    assert.deepEqual(joined.members.map(member => member.memberId), ['c_host', 'c_bob'])
    manager.handleSocketClosed(bob)
    assert.equal(unwrap(manager.getRoom(alias))!.members[1].online, true)
    unwrap(manager.leaveRoom(alias, { roomId: room.roomId }))
    assert.equal(unwrap(manager.getRoom(bob)), null)
    assert.equal(unwrap(manager.getRoom(alias)), null)
    assert.equal(unwrap(manager.joinRoom(alias, { code: room.code })).members[1].memberId, 'c_alias')
  })

  it('reports ROOM_NOT_FOUND, ROOM_FULL, ALREADY_IN_ROOM and ROOM_LIMIT', () => {
    const { manager, room } = setupRoom({ maxMembers: 2, maxRooms: 2 })
    assert.equal(codeOf(manager.joinRoom(createFakeSocket('c_x', 'bob'), { code: room.code == '999999' ? '888888' : '999999' })), 'ROOM_NOT_FOUND')
    assert.equal(codeOf(manager.joinRoom(createFakeSocket('c_x', 'bob'), { code: '12345' })), 'INVALID_PARAMS')
    assert.equal(codeOf(manager.joinRoom(createFakeSocket('c_x', 'bob'), {})), 'INVALID_PARAMS')
    unwrap(manager.joinRoom(createFakeSocket('c_bob', 'bob'), { code: room.code }))
    assert.equal(codeOf(manager.joinRoom(createFakeSocket('c_carol', 'carol'), { code: room.code })), 'ROOM_FULL')

    const other = unwrap(manager.createRoom(createFakeSocket('c_carol', 'carol')))
    assert.equal(codeOf(manager.joinRoom(createFakeSocket('c_carol', 'carol'), { code: room.code })), 'ALREADY_IN_ROOM')
    assert.notEqual(other.code, room.code)
    assert.equal(codeOf(manager.createRoom(createFakeSocket('c_dave', 'dave'))), 'ROOM_LIMIT')
  })

  it('rate-limits failed joins per device', () => {
    const { manager, room, advance } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    const wrong = room.code == '999999' ? '888888' : '999999'
    for (let i = 0; i < 10; i++) assert.equal(codeOf(manager.joinRoom(bob, { code: wrong })), 'ROOM_NOT_FOUND')
    assert.equal(codeOf(manager.joinRoom(bob, { code: room.code })), 'RATE_LIMITED')
    assert.equal(codeOf(manager.joinRoom(createFakeSocket('c_bob2', 'bob'), { code: room.code })), 'OK')
    advance(60_000)
    assert.equal(codeOf(manager.joinRoom(bob, { code: room.code })), 'OK')
  })

  it('member leave broadcasts leave/left; closeRoom is host-only and notifies everyone', () => {
    const { manager, host, room } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    const carol = createFakeSocket('c_carol', 'carol')
    unwrap(manager.joinRoom(bob, { code: room.code }))
    unwrap(manager.joinRoom(carol, { code: room.code }))
    host.takePushes(); bob.takePushes()

    assert.equal(codeOf(manager.leaveRoom(carol, { roomId: 'nope' })), 'NOT_IN_ROOM')
    unwrap(manager.leaveRoom(carol, { roomId: room.roomId }))
    const [leave] = host.takePushes('together:onMemberChanged')
    assert.deepEqual(leave.payload.change, { type: 'leave', memberId: 'c_carol', reason: 'left' })
    assert.deepEqual(leave.payload.members.map((m: any) => m.memberId), ['c_host', 'c_bob'])
    assert.equal(carol.pushes.length, 0)
    assert.equal(codeOf(manager.leaveRoom(carol, { roomId: room.roomId })), 'NOT_IN_ROOM')

    assert.equal(codeOf(manager.closeRoom(bob, { roomId: room.roomId })), 'NOT_HOST')
    unwrap(manager.closeRoom(host, { roomId: room.roomId }))
    for (const socket of [host, bob]) {
      assert.deepEqual(socket.takePushes('together:onRoomClosed').map(p => p.payload), [{ roomId: room.roomId, reason: 'host_closed' }])
    }
    assert.equal(unwrap(manager.getRoom(bob)), null)
    assert.deepEqual(manager.getStats(), { activeRooms: 0, members: 0, onlineMembers: 0 })
    unwrap(manager.createRoom(bob))
  })

  it('feature disable immediately removes members, transfers the host, and closes an empty room', () => {
    const { manager, host, room, pendingTimers } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    unwrap(manager.joinRoom(bob, { code: room.code }))
    host.takePushes()
    bob.moduleReadys.together = false
    manager.handleSocketDisabled(bob)
    assert.equal(unwrap(manager.getRoom(bob)), null)
    assert.deepEqual(host.takePushes('together:onMemberChanged')[0].payload.change, { type: 'leave', memberId: 'c_bob', reason: 'left' })

    bob.moduleReadys.together = true
    unwrap(manager.joinRoom(bob, { code: room.code }))
    bob.takePushes()
    host.moduleReadys.together = false
    manager.handleSocketDisabled(host)
    const remaining = unwrap(manager.getRoom(bob))!
    assert.equal(remaining.hostId, 'c_bob')
    assert.deepEqual(remaining.members.map(member => member.memberId), ['c_bob'])
    assert.equal(bob.takePushes('together:onHostChanged')[0].payload.reason, 'host_left')
    assert.equal(pendingTimers(), 0)

    bob.moduleReadys.together = false
    manager.handleSocketDisabled(bob)
    assert.deepEqual(manager.getStats(), { activeRooms: 0, members: 0, onlineMembers: 0 })
  })

  it('cleans up bound sockets without resolving credentials after account or credential removal', () => {
    let credentialsAvailable = true
    const aliases = new Proxy({ c_alias: 'c_host' }, {
      get(target, key) {
        assert.equal(credentialsAvailable, true, 'close and disable must not reload deleted user data')
        return Reflect.get(target, key)
      },
    })
    const { manager, pendingTimers } = createTestManager({}, aliases)
    const original = createFakeSocket('c_alias', 'alice')
    const replacement = createFakeSocket('c_host', 'alice')
    const bob = createFakeSocket('c_bob', 'bob')
    const room = unwrap(manager.createRoom(original))
    unwrap(manager.joinRoom(bob, { code: room.code }))
    manager.handleSocketReady(replacement)
    credentialsAvailable = false

    manager.handleSocketClosed(original)
    manager.handleSocketDisabled(original)
    assert.deepEqual(manager.getStats(), { activeRooms: 1, members: 2, onlineMembers: 2 })
    manager.handleSocketClosed(replacement)
    assert.deepEqual(manager.getStats(), { activeRooms: 1, members: 2, onlineMembers: 1 })
    assert.equal(pendingTimers(), 1)
    manager.handleSocketDisabled(bob)
    assert.deepEqual(manager.getStats(), { activeRooms: 1, members: 1, onlineMembers: 0 })

    manager.evictUser('u_alice')
    manager.handleSocketClosed(replacement)
    manager.handleSocketDisabled(replacement)
    manager.handleSocketClosed(createFakeSocket('never_joined', 'alice'))
    assert.deepEqual(manager.getStats(), { activeRooms: 0, members: 0, onlineMembers: 0 })
    assert.equal(pendingTimers(), 0)
  })
})

describe('together rooms: host updates and versions', () => {
  it('applies state, pushes onRoomState to members only, and acks versions', () => {
    const { manager, host, room, clock } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    unwrap(manager.joinRoom(bob, { code: room.code }))
    host.takePushes()

    const now = clock.now()
    const ack = unwrap(manager.hostUpdateState(host, stateReq(room.roomId, 1, { sampledAt: now - 200 })))
    assert.deepEqual(ack, { version: 3, subVersion: 2, updatedAt: now - 200 })
    assert.equal(host.pushes.length, 0)
    const [push] = bob.takePushes('together:onRoomState')
    assert.equal(push.payload.version, 3)
    assert.equal(push.payload.playbackVersion, 2)
    assert.equal(push.payload.queueVersion, 1)
    assert.equal('queue' in push.payload, false)
    assert.equal(push.payload.playback.musicInfo.id, 'kw_1')
    assert.equal(push.payload.playback.positionMs, 10_000)
    assert.equal(push.payload.playback.isPlaying, true)
  })

  it('returns VERSION_CONFLICT with a snapshot, and the host can resend with that version', () => {
    const { manager, host, room } = setupRoom()
    unwrap(manager.hostUpdateState(host, stateReq(room.roomId, 1)))
    const conflict = manager.hostUpdateState(host, stateReq(room.roomId, 1))
    assert.equal(codeOf(conflict), 'VERSION_CONFLICT')
    const snapshot = (conflict as { detail: LX.Sync.Together.RoomSnapshot }).detail
    assert.equal(snapshot.playbackVersion, 2)
    assert.equal(snapshot.roomId, room.roomId)
    const ack = unwrap(manager.hostUpdateState(host, stateReq(room.roomId, snapshot.playbackVersion)))
    assert.equal(ack.subVersion, 3)
  })

  it('clamps sampledAt into [now-5s, now] and keeps positionMs consistent with updatedAt', () => {
    const { manager, host, room, clock } = setupRoom()
    const now = clock.now()
    const old = unwrap(manager.hostUpdateState(host, stateReq(room.roomId, 1, { sampledAt: now - 8000, positionMs: 1000 })))
    assert.equal(old.updatedAt, now - 5000)
    assert.equal(unwrap(manager.getRoom(host))!.playback.positionMs, 4000)

    const future = unwrap(manager.hostUpdateState(host, stateReq(room.roomId, 2, { sampledAt: now + 3000, positionMs: 5000, isPlaying: false })))
    assert.equal(future.updatedAt, now)
    assert.equal(unwrap(manager.getRoom(host))!.playback.positionMs, 5000)
  })

  it('rejects local or malformed music, bad params, non-hosts and wrong rooms', () => {
    const { manager, host, room } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    unwrap(manager.joinRoom(bob, { code: room.code }))
    const local = { ...song('1'), source: 'local' }
    assert.equal(codeOf(manager.hostUpdateState(host, stateReq(room.roomId, 1, { musicInfo: local }))), 'INVALID_MUSIC')
    assert.equal(codeOf(manager.hostUpdateState(host, stateReq(room.roomId, 1, { musicInfo: { id: 1 } }))), 'INVALID_MUSIC')
    assert.equal(codeOf(manager.hostUpdateState(host, stateReq(room.roomId, 1, { positionMs: -1 }))), 'INVALID_PARAMS')
    assert.equal(codeOf(manager.hostUpdateState(host, stateReq(room.roomId, 1, { quality: 'best' }))), 'INVALID_PARAMS')
    assert.equal(codeOf(manager.hostUpdateState(bob, stateReq(room.roomId, 1))), 'NOT_HOST')
    assert.equal(codeOf(manager.hostUpdateState(host, stateReq('other-room', 1))), 'NOT_IN_ROOM')
    assert.equal(codeOf(manager.hostUpdateState(createFakeSocket('c_carol', 'carol'), stateReq(room.roomId, 1))), 'NOT_IN_ROOM')

    const stopped = unwrap(manager.hostUpdateState(host, stateReq(room.roomId, 1, { musicInfo: null, quality: null, isPlaying: false })))
    assert.equal(stopped.subVersion, 2)
    assert.equal(unwrap(manager.getRoom(bob))!.playback.musicInfo, null)
  })

  it('strips meta.toggleMusicInfo from relayed songs', () => {
    const { manager, host, room } = setupRoom()
    const info = { ...song('1'), meta: { ...song('1').meta, toggleMusicInfo: song('2', 'tx') } }
    unwrap(manager.hostUpdateState(host, stateReq(room.roomId, 1, { musicInfo: info })))
    assert.equal('toggleMusicInfo' in unwrap(manager.getRoom(host))!.playback.musicInfo!.meta, false)
  })

  it('updates the queue with its own version, pushes it, and enforces the 200-song cap', () => {
    const { manager, host, room } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    unwrap(manager.joinRoom(bob, { code: room.code }))
    bob.takePushes()
    const items = [song('1'), song('2', 'wy')]
    const ack = unwrap(manager.hostUpdateQueue(host, { roomId: room.roomId, baseVersion: 1, items, currentId: 'kw_1' }))
    assert.equal(ack.subVersion, 2)
    const [push] = bob.takePushes('together:onRoomState')
    assert.equal(push.payload.queueVersion, 2)
    assert.deepEqual(push.payload.queue.items.map((s: any) => s.id), ['kw_1', 'wy_2'])
    assert.equal(push.payload.queue.currentId, 'kw_1')

    assert.equal(codeOf(manager.hostUpdateQueue(host, { roomId: room.roomId, baseVersion: 1, items, currentId: null })), 'VERSION_CONFLICT')
    const tooMany = Array.from({ length: 201 }, (_, i) => song(String(i)))
    assert.equal(codeOf(manager.hostUpdateQueue(host, { roomId: room.roomId, baseVersion: 2, items: tooMany, currentId: null })), 'INVALID_PARAMS')
    const withLocal = [song('1'), { ...song('3'), source: 'local' }]
    assert.equal(codeOf(manager.hostUpdateQueue(host, { roomId: room.roomId, baseVersion: 2, items: withLocal, currentId: null })), 'INVALID_MUSIC')
    const atCap = Array.from({ length: 200 }, (_, i) => song(String(i)))
    assert.equal(codeOf(manager.hostUpdateQueue(host, { roomId: room.roomId, baseVersion: 2, items: atCap, currentId: null })), 'OK')
  })

  it('rate-limits host updates per room to 10 per second', () => {
    const { manager, host, room, advance } = setupRoom()
    let version = 1
    for (let i = 0; i < 10; i++) version = unwrap(manager.hostUpdateState(host, stateReq(room.roomId, version))).subVersion
    assert.equal(codeOf(manager.hostUpdateQueue(host, { roomId: room.roomId, baseVersion: 1, items: [], currentId: null })), 'RATE_LIMITED')
    advance(1000)
    assert.equal(codeOf(manager.hostUpdateState(host, stateReq(room.roomId, version))), 'OK')
  })

  it('keeps the room version strictly increasing across every kind of change', () => {
    const { manager, host, room } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    const seen = [room.version]
    seen.push(unwrap(manager.joinRoom(bob, { code: room.code })).version)
    seen.push(unwrap(manager.hostUpdateState(host, stateReq(room.roomId, 1))).version)
    seen.push(unwrap(manager.hostUpdateQueue(host, { roomId: room.roomId, baseVersion: 1, items: [], currentId: null })).version)
    unwrap(manager.transferHost(host, { roomId: room.roomId, memberId: 'c_bob' }))
    seen.push(unwrap(manager.getRoom(host))!.version)
    assert.deepEqual(seen, [1, 2, 3, 4, 5])
  })
})

describe('together rooms: host transfer, disconnects and grace period', () => {
  it('transferHost validates the target and broadcasts onHostChanged to everyone', () => {
    const { manager, host, room } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    const carol = createFakeSocket('c_carol', 'carol')
    unwrap(manager.joinRoom(bob, { code: room.code }))
    unwrap(manager.joinRoom(carol, { code: room.code }))
    manager.handleSocketClosed(carol)
    host.takePushes(); bob.takePushes()

    assert.equal(codeOf(manager.transferHost(bob, { roomId: room.roomId, memberId: 'c_bob' })), 'NOT_HOST')
    assert.equal(codeOf(manager.transferHost(host, { roomId: room.roomId, memberId: 'c_zed' })), 'MEMBER_NOT_FOUND')
    assert.equal(codeOf(manager.transferHost(host, { roomId: room.roomId, memberId: 'c_carol' })), 'MEMBER_OFFLINE')
    unwrap(manager.transferHost(host, { roomId: room.roomId, memberId: 'c_bob' }))
    for (const socket of [host, bob]) {
      const [push] = socket.takePushes('together:onHostChanged')
      assert.deepEqual({ ...push.payload, version: undefined }, { roomId: room.roomId, version: undefined, hostId: 'c_bob', previousHostId: 'c_host', reason: 'transfer' })
    }
    assert.equal(codeOf(manager.hostUpdateState(host, stateReq(room.roomId, 1))), 'NOT_HOST')
    assert.equal(codeOf(manager.hostUpdateState(bob, stateReq(room.roomId, 1))), 'OK')
  })

  it('host leaving hands over to the earliest online member and keeps playback', () => {
    const { manager, host, room, advance } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    const carol = createFakeSocket('c_carol', 'carol')
    const dave = createFakeSocket('c_dave', 'dave')
    advance(1); unwrap(manager.joinRoom(bob, { code: room.code }))
    advance(1); unwrap(manager.joinRoom(carol, { code: room.code }))
    advance(1); unwrap(manager.joinRoom(dave, { code: room.code }))
    unwrap(manager.hostUpdateState(host, stateReq(room.roomId, 1)))
    manager.handleSocketClosed(bob)
    carol.takePushes()

    unwrap(manager.leaveRoom(host, { roomId: room.roomId }))
    const pushes = carol.takePushes()
    assert.deepEqual(pushes.map(p => p.method), ['together:onHostChanged', 'together:onMemberChanged'])
    assert.equal(pushes[0].payload.hostId, 'c_carol')
    assert.equal(pushes[0].payload.reason, 'host_left')
    assert.deepEqual(pushes[1].payload.change, { type: 'leave', memberId: 'c_host', reason: 'left' })
    assert.equal(pushes[1].payload.version, pushes[0].payload.version + 1)
    assert.equal(host.takePushes('together:onHostChanged').length, 0)

    const snap = unwrap(manager.getRoom(carol))!
    assert.equal(snap.hostId, 'c_carol')
    assert.equal(snap.playback.musicInfo?.id, 'kw_1')
    assert.equal(snap.playbackVersion, 2)
    assert.equal(unwrap(manager.getRoom(host)), null)
  })

  it('host leaving with no online members closes the room as empty', () => {
    const { manager, host, room } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    unwrap(manager.joinRoom(bob, { code: room.code }))
    manager.handleSocketClosed(bob)
    unwrap(manager.leaveRoom(host, { roomId: room.roomId }))
    assert.equal(manager.getStats().activeRooms, 0)
    assert.equal(unwrap(manager.getRoom(bob)), null)
    const lone = setupRoom()
    unwrap(lone.manager.leaveRoom(lone.host, { roomId: lone.room.roomId }))
    assert.equal(lone.manager.getStats().activeRooms, 0)
  })

  it('member reconnect inside the grace period restores them; timeout removes them', () => {
    const { manager, host, room, advance, pendingTimers } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    unwrap(manager.joinRoom(bob, { code: room.code }))
    host.takePushes()

    manager.handleSocketClosed(bob)
    const [offline] = host.takePushes('together:onMemberChanged')
    assert.deepEqual(offline.payload.change, { type: 'offline', memberId: 'c_bob' })
    const offMember = offline.payload.members.find((m: any) => m.memberId == 'c_bob')
    assert.equal(offMember.online, false)
    assert.equal(typeof offMember.offlineAt, 'number')
    assert.deepEqual(manager.getStats(), { activeRooms: 1, members: 2, onlineMembers: 1 })

    advance(29_000)
    const bob2 = createFakeSocket('c_bob', 'bob')
    manager.handleSocketReady(bob2)
    const [online] = host.takePushes('together:onMemberChanged')
    assert.deepEqual(online.payload.change, { type: 'online', memberId: 'c_bob' })
    assert.equal(pendingTimers(), 0)
    // A late close event from the replaced socket must not mark the member offline.
    manager.handleSocketClosed(bob)
    assert.equal(host.pushes.length, 0)

    manager.handleSocketClosed(bob2)
    host.takePushes()
    advance(30_000)
    const [leave] = host.takePushes('together:onMemberChanged')
    assert.deepEqual(leave.payload.change, { type: 'leave', memberId: 'c_bob', reason: 'timeout' })
    assert.equal(unwrap(manager.getRoom(bob2)), null)
  })

  it('host timeout transfers to the earliest online member, or closes the room', () => {
    const { manager, host, room, advance } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    const carol = createFakeSocket('c_carol', 'carol')
    advance(1); unwrap(manager.joinRoom(bob, { code: room.code }))
    advance(1); unwrap(manager.joinRoom(carol, { code: room.code }))
    manager.handleSocketClosed(host)
    manager.handleSocketClosed(bob)
    carol.takePushes()

    advance(30_000)
    const pushes = carol.takePushes()
    const hostChanged = pushes.find(p => p.method == 'together:onHostChanged')!
    assert.deepEqual([hostChanged.payload.hostId, hostChanged.payload.reason], ['c_carol', 'host_timeout'])
    const leaves = pushes.filter(p => p.method == 'together:onMemberChanged').map(p => p.payload.change)
    assert.deepEqual(leaves, [
      { type: 'leave', memberId: 'c_host', reason: 'timeout' },
      { type: 'leave', memberId: 'c_bob', reason: 'timeout' },
    ])
    assert.equal(unwrap(manager.getRoom(carol))!.hostId, 'c_carol')

    manager.handleSocketClosed(carol)
    advance(30_000)
    assert.equal(manager.getStats().activeRooms, 0)
  })

  it('host timeout with nobody online closes the room with host_timeout', () => {
    const { manager, host, room, advance } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    unwrap(manager.joinRoom(bob, { code: room.code }))
    manager.handleSocketClosed(bob)
    manager.handleSocketClosed(host)
    advance(30_000)
    assert.equal(manager.getStats().activeRooms, 0)

    const ctx = setupRoom()
    const member = createFakeSocket('c_bob', 'bob')
    unwrap(ctx.manager.joinRoom(member, { code: ctx.room.code }))
    ctx.manager.handleSocketClosed(ctx.host)
    member.takePushes()
    ctx.manager.handleSocketClosed(member)
    ctx.advance(30_000)
    assert.equal(ctx.manager.getStats().activeRooms, 0)
  })

  it('host reconnecting in time keeps the host role', () => {
    const { manager, host, room, advance } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    unwrap(manager.joinRoom(bob, { code: room.code }))
    manager.handleSocketClosed(host)
    advance(10_000)
    const host2 = createFakeSocket('c_host', 'alice')
    manager.handleSocketReady(host2)
    advance(60_000)
    const snap = unwrap(manager.getRoom(host2))!
    assert.equal(snap.hostId, 'c_host')
    assert.equal(snap.members.every(m => m.online), true)
    assert.equal(codeOf(manager.hostUpdateState(host2, stateReq(room.roomId, 1))), 'OK')
  })

  it('a closed socket cannot rebind through ready or an idempotent join and cancel its grace timer', () => {
    const { manager, host, room, advance, pendingTimers } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    unwrap(manager.joinRoom(bob, { code: room.code }))
    host.close()
    manager.handleSocketClosed(host)
    manager.handleSocketReady(host)
    assert.equal(unwrap(manager.joinRoom(host, { code: room.code })).members[0].online, false)
    assert.equal(pendingTimers(), 1)
    advance(30_000)
    const remaining = unwrap(manager.getRoom(bob))!
    assert.equal(remaining.hostId, 'c_bob')
    assert.deepEqual(remaining.members.map(member => member.memberId), ['c_bob'])
  })

  it('expires canonical device membership even when its public memberId is an alias', () => {
    const { manager, advance } = createTestManager({}, { c_alias: 'c_host' })
    const host = createFakeSocket('c_alias', 'alice')
    const canonical = createFakeSocket('c_host', 'alice')
    const bob = createFakeSocket('c_bob', 'bob')
    const room = unwrap(manager.createRoom(host))
    unwrap(manager.joinRoom(bob, { code: room.code }))
    manager.handleSocketClosed(host)
    advance(30_000)
    assert.equal(unwrap(manager.getRoom(canonical)), null)
    assert.equal(unwrap(manager.getRoom(bob))!.hostId, 'c_bob')
    assert.equal(unwrap(manager.createRoom(canonical)).hostId, 'c_host')
  })

  it('ping echoes t0 with server time', () => {
    const { manager, clock } = createTestManager()
    assert.deepEqual(unwrap(manager.ping({ t0: 42 })), { t0: 42, serverTime: clock.now() })
    assert.equal(codeOf(manager.ping({})), 'INVALID_PARAMS')
  })
})

describe('together config', () => {
  it('reads env vars with range checks and falls back to defaults', () => {
    assert.deepEqual(readTogetherConfig({}), { maxMembers: 10, maxRooms: 100, graceMs: 30_000 })
    assert.deepEqual(readTogetherConfig({ LUX_TOGETHER_MAX_MEMBERS: '50', LUX_TOGETHER_MAX_ROOMS: '3', LUX_TOGETHER_GRACE_MS: '5000' }),
      { maxMembers: 50, maxRooms: 3, graceMs: 5000 })
    assert.deepEqual(readTogetherConfig({ LUX_TOGETHER_MAX_MEMBERS: '1', LUX_TOGETHER_MAX_ROOMS: 'x', LUX_TOGETHER_GRACE_MS: '300001' }),
      { maxMembers: 10, maxRooms: 100, graceMs: 30_000 })
  })
})


describe('together rooms: reactions', () => {
  it('broadcasts only to opted-in sockets, includes the sender, and leaves snapshots unchanged', () => {
    const { manager, host, room, clock } = setupRoom()
    const bob = createFakeSocket('c_bob', 'bob')
    const old = createFakeSocket('c_carol', 'carol')
    host.feature['together.reaction'] = true
    bob.feature['together.reaction'] = true
    unwrap(manager.joinRoom(bob, { code: room.code }))
    unwrap(manager.joinRoom(old, { code: room.code }))
    host.takePushes(); bob.takePushes(); old.takePushes()
    const before = unwrap(manager.getRoom(host))
    unwrap(manager.reaction(bob, { emoji: '❤️', memberId: 'forged', displayName: 'forged', at: 0 }))
    for (const socket of [host, bob]) {
      assert.deepEqual(socket.takePushes('together:onReaction').map(p => p.payload), [{
        roomId: room.roomId, memberId: 'c_bob', displayName: 'bob', emoji: '❤️', at: clock.now(),
      }])
    }
    assert.equal(old.takePushes().length, 0)
    assert.deepEqual(unwrap(manager.getRoom(host)), before)
    assert.equal(codeOf(manager.reaction(createFakeSocket('outsider', 'dave'), { emoji: '👍' })), 'NOT_IN_ROOM')
    manager.handleSocketClosed(bob)
    assert.equal(codeOf(manager.reaction(bob, { emoji: '👍' })), 'NOT_IN_ROOM')
    unwrap(manager.closeRoom(host, { roomId: room.roomId }))
    assert.equal(codeOf(manager.reaction(host, { emoji: '👍' })), 'NOT_IN_ROOM')
  })

  it('limits each member to 5 per 3 seconds and 60 per minute with sliding expiry', () => {
    const { manager, host, room, advance } = setupRoom()
    host.feature['together.reaction'] = true
    const bob = createFakeSocket('c_bob', 'bob')
    unwrap(manager.joinRoom(bob, { code: room.code }))
    host.takePushes()
    for (let batch = 0; batch < 12; batch++) {
      for (let i = 0; i < 5; i++) unwrap(manager.reaction(host, { emoji: '🔥' }))
      assert.equal(host.takePushes('together:onReaction').length, 5)
      const limited = manager.reaction(host, { emoji: '🔥' })
      assert.equal(codeOf(limited), 'RATE_LIMITED')
      if (!limited.ok) assert.match(limited.message, /Too many reactions/)
      assert.equal(host.takePushes('together:onReaction').length, 0)
      advance(2999)
      assert.equal(codeOf(manager.reaction(host, { emoji: '🔥' })), 'RATE_LIMITED')
      advance(1)
    }
    assert.equal(codeOf(manager.reaction(host, { emoji: '🔥' })), 'RATE_LIMITED')
    unwrap(manager.reaction(bob, { emoji: '👏' }))
    advance(23_999)
    assert.equal(codeOf(manager.reaction(host, { emoji: '🔥' })), 'RATE_LIMITED')
    advance(1)
    for (let i = 0; i < 5; i++) unwrap(manager.reaction(host, { emoji: '🔥' }))
    assert.equal(codeOf(manager.reaction(host, { emoji: '🔥' })), 'RATE_LIMITED')
  })

  it('keeps member identity and rate limits when a credential alias reconnects', () => {
    const { manager, advance } = createTestManager({}, { c_alias: 'c_host' })
    const host = createFakeSocket('c_alias', 'alice')
    unwrap(manager.createRoom(host))
    for (let i = 0; i < 5; i++) unwrap(manager.reaction(host, { emoji: '🎉' }))
    manager.handleSocketClosed(host)
    const replacement = createFakeSocket('c_host', 'alice')
    replacement.feature['together.reaction'] = true
    manager.handleSocketReady(replacement)
    assert.equal(codeOf(manager.reaction(host, { emoji: '🎉' })), 'NOT_IN_ROOM')
    assert.equal(codeOf(manager.reaction(replacement, { emoji: '🎉' })), 'RATE_LIMITED')
    advance(3000)
    unwrap(manager.reaction(replacement, { emoji: '🎉' }))
    assert.equal(replacement.takePushes('together:onReaction')[0].payload.memberId, 'c_alias')
  })
})


describe('together rooms: requests', () => {
  const setup = () => {
    const ctx = setupRoom({ maxMembers: 50 })
    ctx.host.feature['together.request'] = true
    const bob = createFakeSocket('c_bob', 'bob')
    bob.feature['together.request'] = true
    const old = createFakeSocket('c_old', 'carol')
    unwrap(ctx.manager.joinRoom(bob, { code: ctx.room.code }))
    unwrap(ctx.manager.joinRoom(old, { code: ctx.room.code }))
    const snapshot = () => unwrap(ctx.manager.getRoom(ctx.host))!
    return { ...ctx, bob, old, snapshot }
  }

  it('keeps host requests pending, sanitizes songs, gates broadcasts and restores snapshots', () => {
    const { manager, host, bob, old, room, snapshot, clock } = setup()
    host.takePushes(); bob.takePushes(); old.takePushes()
    const music = { ...song('one'), meta: { ...song('one').meta, toggleMusicInfo: song('two') } }
    unwrap(manager.requestAdd(host, { song: music, requestedBy: { memberId: 'forged' }, at: 0 }))
    const state = snapshot()
    assert.equal(state.queueVersion, 1)
    assert.equal(state.queue.items.length, 0)
    assert.equal(state.requestsVersion, 2)
    assert.deepEqual(state.requests![0].requestedBy, { memberId: 'c_host', displayName: 'Alice' })
    assert.equal(state.requests![0].at, clock.now())
    assert.equal(state.requests![0].status, 'pending')
    assert.equal('toggleMusicInfo' in state.requests![0].song.meta, false)
    for (const socket of [host, bob]) assert.deepEqual(socket.takePushes('together:onRequests')[0].payload, {
      roomId: room.roomId, requests: state.requests, version: 2,
    })
    assert.equal(old.takePushes().length, 0)
    assert.equal('requests' in unwrap(manager.getRoom(old))!, false)
    state.requests![0].song.name = 'mutated'
    assert.equal(snapshot().requests![0].song.name, music.name)
    manager.handleSocketClosed(bob)
    const replacement = createFakeSocket('c_bob', 'bob')
    replacement.feature['together.request'] = true
    assert.deepEqual(unwrap(manager.joinRoom(replacement, { code: room.code })).requests, snapshot().requests)
    assert.equal(codeOf(manager.requestAdd(bob, { song: song('stale') })), 'NOT_IN_ROOM')
  })

  it('enforces per-device and room limits, duplicate identity and existing queue songs', () => {
    const { manager, host, bob, room, snapshot } = setup()
    for (let i = 0; i < 3; i++) unwrap(manager.requestAdd(bob, { song: song(String(i)) }))
    const before = snapshot()
    assert.equal(codeOf(manager.requestAdd(bob, { song: song('extra') })), 'REQUEST_LIMIT')
    assert.equal(codeOf(manager.requestAdd(host, { song: song('0') })), 'DUPLICATE_SONG')
    assert.deepEqual(snapshot(), before)
    // Same id with a different source is a different song.
    unwrap(manager.requestAdd(host, { song: { ...song('0'), source: 'tx' } }))
    unwrap(manager.hostUpdateQueue(host, { roomId: room.roomId, baseVersion: 1, items: [song('queued')], currentId: null }))
    assert.equal(codeOf(manager.requestAdd(host, { song: song('queued') })), 'DUPLICATE_SONG')
    for (let i = 0; snapshot().requests!.length < 30; i++) {
      const device = createFakeSocket(`device-${i}`, 'bob')
      unwrap(manager.joinRoom(device, { code: room.code }))
      for (let j = 0; j < 3 && snapshot().requests!.length < 30; j++) unwrap(manager.requestAdd(device, { song: song(`${i}-${j}`) }))
    }
    assert.equal(codeOf(manager.requestAdd(host, { song: song('room-full') })), 'REQUEST_LIMIT')
  })

  it('enforces permissions and exact permutations; remove and reject drop pending entries', () => {
    const { manager, host, bob, old, snapshot } = setup()
    unwrap(manager.requestAdd(bob, { song: song('one') }))
    unwrap(manager.requestAdd(host, { song: song('two') }))
    const ids = snapshot().requests!.map(request => request.id)
    for (const action of ['requestApprove', 'requestReject', 'requestReorder'] as const) {
      assert.equal(codeOf(manager[action](bob, { requestId: ids[0], requestIds: ids })), 'NOT_HOST')
    }
    assert.equal(codeOf(manager.requestRemove(old, { requestId: ids[0] })), 'NOT_REQUESTER')
    assert.equal(codeOf(manager.requestAdd(createFakeSocket('outsider', 'bob'), { song: song('three') })), 'NOT_IN_ROOM')
    for (const requestIds of [[], [ids[0]], [ids[0], ids[0]], [ids[0], 'unknown'], [ids[0], 1]]) {
      assert.equal(codeOf(manager.requestReorder(host, { requestIds })), 'INVALID_PARAMS')
    }
    unwrap(manager.requestReorder(host, { requestIds: [...ids].reverse() }))
    assert.deepEqual(snapshot().requests!.map(request => request.id), [...ids].reverse())
    assert.equal(snapshot().requestsVersion, 4)
    unwrap(manager.requestRemove(bob, { requestId: ids[0] }))
    unwrap(manager.requestReject(host, { requestId: ids[1] }))
    assert.deepEqual(snapshot().requests, [])
    assert.equal(codeOf(manager.requestRemove(host, { requestId: ids[0] })), 'REQUEST_NOT_FOUND')
    unwrap(manager.requestAdd(bob, { song: song('one') }))
    unwrap(manager.requestRemove(host, { requestId: snapshot().requests![0].id }))
    assert.deepEqual(snapshot().requests, [])
  })

  it('approves exactly once, preserves state on stale versions, full queues and duplicates', () => {
    const { manager, host, bob, room, snapshot } = setup()
    unwrap(manager.requestAdd(bob, { song: song('one') }))
    const requestId = snapshot().requests![0].id
    const before = snapshot()
    assert.equal(codeOf(manager.requestApprove(host, { requestId, expectedQueueVersion: 0 })), 'VERSION_CONFLICT')
    assert.deepEqual(snapshot(), before)
    const ack = unwrap(manager.requestApprove(host, { requestId, expectedQueueVersion: 1 }))
    assert.equal(ack.subVersion, 2)
    assert.equal(codeOf(manager.requestApprove(host, { requestId })), 'REQUEST_NOT_FOUND')
    assert.deepEqual(snapshot().queue.items, [song('one')])
    assert.deepEqual(snapshot().requests, [])
    for (const socket of [host, bob]) assert.equal(socket.takePushes('together:onRoomState').at(-1)!.payload.queueVersion, 2)
    unwrap(manager.requestAdd(bob, { song: song('two') }))
    const nextId = snapshot().requests![0].id
    unwrap(manager.hostUpdateQueue(host, { roomId: room.roomId, baseVersion: 2, items: [song('two')], currentId: null }))
    assert.equal(codeOf(manager.requestApprove(host, { requestId: nextId })), 'DUPLICATE_SONG')
    unwrap(manager.hostUpdateQueue(host, { roomId: room.roomId, baseVersion: 3, items: Array.from({ length: 200 }, (_, i) => song(`full-${i}`)), currentId: null }))
    const full = snapshot()
    assert.equal(codeOf(manager.requestApprove(host, { requestId: nextId })), 'INVALID_PARAMS')
    assert.deepEqual(snapshot(), full)
  })

  it('serializes competing approvals against the same expected queue version', async() => {
    const { manager, host, bob, snapshot } = setup()
    unwrap(manager.requestAdd(bob, { song: song('one') }))
    unwrap(manager.requestAdd(bob, { song: song('two') }))
    const ids = snapshot().requests!.map(request => request.id)
    const results = await Promise.all(ids.map(async requestId => manager.requestApprove(host, { requestId, expectedQueueVersion: 1 })))
    assert.deepEqual(results.map(codeOf), ['OK', 'VERSION_CONFLICT'])
    assert.equal(snapshot().queueVersion, 2)
    assert.deepEqual(snapshot().requests!.map(request => request.id), [ids[1]])
    unwrap(manager.requestApprove(host, { requestId: ids[1], expectedQueueVersion: 2 }))
    assert.equal(snapshot().queueVersion, 3)
    assert.deepEqual(snapshot().requests, [])
  })

  it('drops requests on leave, timeout, disable and host departure; close clears the room', () => {
    for (const leave of ['leave', 'timeout', 'disable', 'host'] as const) {
      const { manager, host, bob, room, advance, snapshot } = setup()
      const requester = leave == 'host' ? host : bob
      unwrap(manager.requestAdd(requester, { song: song('one') }))
      if (leave == 'leave' || leave == 'host') unwrap(manager.leaveRoom(requester, { roomId: room.roomId }))
      else if (leave == 'disable') manager.handleSocketDisabled(requester)
      else { manager.handleSocketClosed(requester); advance(30_000) }
      const remaining = unwrap(manager.getRoom(leave == 'host' ? bob : host))!
      assert.deepEqual(remaining.requests, [])
      assert.equal(remaining.requestsVersion, 3)
      if (leave != 'host') assert.deepEqual(snapshot().requests, [])
      unwrap(manager.closeRoom(leave == 'host' ? bob : host, { roomId: room.roomId }))
      assert.equal(unwrap(manager.getRoom(bob)), null)
    }
  })
})
