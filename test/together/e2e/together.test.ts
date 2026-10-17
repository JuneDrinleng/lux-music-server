/**
 * TEST_HOOKS
 * - Added src/server/server.ts:startServerForTests(): the existing real server
 *   binds port 0 and exposes its assigned port plus deterministic shutdown.
 *   Production startServer ignores the private startup return value as before.
 * - Reuse existing setRoomManager/RoomManager.clock and test/together/fakes.ts
 *   clock only for room time/grace; managed account lookup remains real.
 * No sockets, authentication, compression, RPC handlers or pushes are mocked.
 *
 * Run with npm test on Node >=24 in an environment that permits loopback TCP.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { song, unwrap } from '../fakes'
import { createGate, type TogetherClient, type TogetherPush } from './client'
import { createFixture, type Fixture } from './fixture'

const results = new Map<string, 'pass'>()
const GRACE_MS = 30_000
const STATE = 'together:onRoomState'
const MEMBERS = 'together:onMemberChanged'
const HOST = 'together:onHostChanged'
const CLOSED = 'together:onRoomClosed'
const pushesOf = <M extends TogetherPush['method']>(client: TogetherClient, method: M) => (
  client.pushes.filter((push): push is Extract<TogetherPush, { method: M }> => push.method == method)
)

describe('together: two real WebSocket clients', { concurrency: false, timeout: 25_000 }, () => {
  let fixture: Fixture
  before(async() => { fixture = await createFixture() })
  beforeEach(() => { fixture.reset() })
  afterEach(async() => { await fixture?.closeClients() })
  after(async() => {
    await fixture?.close()
    if (results.size) console.table([...results].map(([testCase, status]) => ({ case: testCase, status })))
    else console.log('No e2e cases completed; see the setup/transport failure above.')
    console.log('Product hooks added: startServerForTests() — ephemeral port and shutdown only.')
  })

  const pair = async() => {
    const host = await fixture.connect('host')
    const member = await fixture.connect('member')
    const room = unwrap(await host.createRoom())
    const joined = unwrap(await member.joinRoom(room.code))
    await host.waitFor(() => host.pushes.some(p => p.method == MEMBERS && p.payload.change.type == 'join'), 'join push')
    return { host, member, room: joined }
  }
  const stateRequest = (room: LX.Sync.Together.RoomSnapshot, patch: Partial<LX.Sync.Together.HostUpdateStateRequest> = {}) => ({
    roomId: room.roomId,
    baseVersion: room.playbackVersion,
    musicInfo: song('one'),
    quality: '128k' as LX.Quality,
    isPlaying: true,
    positionMs: 0,
    durationMs: 180_000,
    sampledAt: fixture.now(),
    ...patch,
  })
  const waitOffline = async(client: TogetherClient, memberId: string) => {
    await client.waitFor(() => client.pushes.some(p => p.method == MEMBERS && p.payload.change.type == 'offline' && p.payload.change.memberId == memberId), 'offline push')
  }

  it('delivers reactions to opted-in members and keeps an old client session working', { timeout: 5000 }, async() => {
    const host = await fixture.connect('host', { reaction: true })
    const member = await fixture.connect('member', { reaction: true })
    const old = await fixture.connect('member', {}, true, fixture.credentials.old)
    const advertised = host.handshake[0].args[1] as Record<string, number>
    assert.equal(advertised['together.reaction'], 1)
    const rejected = await member.reaction('👍')
    assert.equal(rejected.ok, false)
    if (!rejected.ok) assert.equal(rejected.code, 'NOT_IN_ROOM')
    const room = unwrap(await host.createRoom())
    unwrap(await member.joinRoom(room.code))
    const joined = unwrap(await old.joinRoom(room.code))
    unwrap(await host.reaction('👍'))
    for (const client of [host, member]) {
      await client.waitFor(() => pushesOf(client, 'together:onReaction').length == 1, 'reaction push')
      assert.deepEqual(pushesOf(client, 'together:onReaction')[0].payload, {
        roomId: room.roomId, memberId: host.credentials.clientId, displayName: 'Host', emoji: '👍', at: fixture.now(),
      })
    }
    // A round trip drains earlier frames; inspect the wire as well as registered pushes.
    assert.deepEqual(unwrap(await old.getRoom()), joined)
    assert.equal(old.frames.some(frame => frame.path == 'together:onReaction'), false)
    assert.equal(pushesOf(old, 'together:onReaction').length, 0)
    assert.deepEqual(unwrap(await old.ping(42)), { t0: 42, serverTime: fixture.now() })
    await member.onFeatureChanged({ 'together.reaction': false })
    unwrap(await host.reaction('🔥'))
    await host.waitFor(() => pushesOf(host, 'together:onReaction').length == 2, 'second sender echo')
    unwrap(await member.ping(1))
    assert.equal(pushesOf(member, 'together:onReaction').length, 1)
    assert.equal(unwrap(await member.getRoom())!.version, joined.version)
    results.set('reaction capability and old client compatibility', 'pass')
  })

  it('1. creates and joins across two authenticated managed accounts', { timeout: 5000 }, async() => {
    const { host, member, room } = await pair()
    assert.match(room.code, /^[1-9]\d{5}$/)
    assert.equal(room.hostId, host.credentials.clientId)
    assert.equal(room.version, 2)
    assert.deepEqual(room.members.map(m => [m.userId, m.displayName, m.online]), [
      [fixture.users.host.id, 'Host', true],
      [fixture.users.member.id, 'Listener', true],
    ])
    assert.deepEqual(unwrap(await host.getRoom()), unwrap(await member.getRoom()))
    assert.deepEqual(unwrap(await member.ping(123)), { t0: 123, serverTime: fixture.now() })
    const joinPush = pushesOf(host, MEMBERS)[0]
    assert.equal(joinPush.payload.version, room.version)

    unwrap(await member.leave(room.roomId))
    await host.waitFor(() => host.pushes.some(p => p.method == MEMBERS && p.payload.change.type == 'leave'), 'leave push')
    assert.equal(unwrap(await member.getRoom()), null)
    unwrap(await member.joinRoom(room.code))
    unwrap(await host.closeRoom(room.roomId))
    await member.waitFor(() => member.pushes.some(p => p.method == CLOSED), 'room closed push')
    const closed = pushesOf(member, CLOSED)[0]
    assert.deepEqual(closed.payload, { roomId: room.roomId, reason: 'host_closed' })
    assert.equal(unwrap(await member.getRoom()), null)
    results.set('1 create/join/leave/close', 'pass')
  })

  it('2. delivers host play, seek and next with independent queue/playback versions', { timeout: 5000 }, async() => {
    const { host, member, room } = await pair()
    const items = [song('one'), song('two')]
    const queue = unwrap(await host.hostUpdateQueue({ roomId: room.roomId, baseVersion: 1, items, currentId: items[0].id }))
    await member.waitFor(() => member.pushes.some(p => p.method == STATE && p.payload.version == queue.version), 'initial queue')
    const play = unwrap(await host.hostUpdateState(stateRequest(room)))
    await member.waitFor(() => member.pushes.some(p => p.method == STATE && p.payload.version == play.version), 'play')
    fixture.advance(1000)
    const seek = unwrap(await host.hostUpdateState(stateRequest(room, { baseVersion: play.subVersion, positionMs: 45_000 })))
    await member.waitFor(() => member.pushes.some(p => p.method == STATE && p.payload.version == seek.version), 'seek')
    const nextQueue = unwrap(await host.hostUpdateQueue({ roomId: room.roomId, baseVersion: queue.subVersion, items, currentId: items[1].id }))
    await member.waitFor(() => member.pushes.some(p => p.method == STATE && p.payload.version == nextQueue.version), 'next queue')
    const next = unwrap(await host.hostUpdateState(stateRequest(room, { baseVersion: seek.subVersion, musicInfo: items[1] })))
    await member.waitFor(() => member.pushes.some(p => p.method == STATE && p.payload.version == next.version), 'next playback')

    const pushes = pushesOf(member, STATE).map(p => p.payload)
    assert.deepEqual(pushes.map(p => [p.version, p.queueVersion, p.playbackVersion]), [
      [3, 2, 1], [4, 2, 2], [5, 2, 3], [6, 3, 3], [7, 3, 4],
    ])
    assert.deepEqual(pushes[0].queue, { items, currentId: items[0].id })
    assert.equal(pushes[1].playback.isPlaying, true)
    assert.equal(pushes[2].playback.positionMs, 45_000)
    assert.equal(pushes[2].playback.updatedAt, fixture.now())
    assert.equal(pushes[3].queue!.currentId, items[1].id)
    assert.equal(pushes[4].playback.musicInfo!.id, items[1].id)
    assert.equal(pushes[4].playback.positionMs, 0)
    assert.equal(pushes[4].queue, undefined)
    assert.deepEqual([queue.subVersion, play.subVersion, seek.subVersion, nextQueue.subVersion, next.subVersion], [2, 2, 3, 3, 4])
    const snapshot = unwrap(await member.getRoom())!
    assert.equal(snapshot.version, next.version)
    assert.deepEqual(snapshot.playback, pushes[4].playback)
    results.set('2 play/seek/next + versions', 'pass')
  })

  it('3. transfers host only after its disconnect grace expires', { timeout: 5000 }, async() => {
    const { host, member, room } = await pair()
    await host.close()
    await waitOffline(member, room.hostId)
    fixture.advance(GRACE_MS - 1)
    const before = unwrap(await member.getRoom())!
    assert.equal(before.hostId, room.hostId)
    assert.equal(before.members.find(m => m.memberId == room.hostId)!.online, false)
    assert.equal(member.pushes.some(p => p.method == HOST), false)
    fixture.advance(1)
    await member.waitFor(() => member.pushes.some(p => p.method == MEMBERS && p.payload.change.type == 'leave'), 'expired host removal')
    const after = unwrap(await member.getRoom())!
    assert.equal(after.hostId, member.credentials.clientId)
    assert.deepEqual(after.members.map(m => m.memberId), [member.credentials.clientId])
    assert.deepEqual(member.pushes.map(p => p.method), [MEMBERS, HOST, MEMBERS])
    const transfer = pushesOf(member, HOST)[0]
    assert.deepEqual(transfer.payload, {
      roomId: room.roomId, version: 4, hostId: member.credentials.clientId,
      previousHostId: room.hostId, reason: 'host_timeout',
    })
    assert.equal(after.version, 5)
    unwrap(await member.hostUpdateState(stateRequest(after)))
    results.set('3 disconnect/grace/host transfer', 'pass')
  })

  it('4. restores membership and delivery after socket kill/reconnect within grace', { timeout: 5000 }, async() => {
    const { host, member, room } = await pair()
    await member.kill()
    await waitOffline(host, member.credentials.clientId)
    fixture.advance(GRACE_MS - 1)
    const reconnected = await fixture.connect('member')
    const restored = unwrap(await reconnected.getRoom())!
    assert.equal(restored.roomId, room.roomId)
    assert.equal(restored.members.length, 2)
    assert.equal(restored.members.find(m => m.memberId == member.credentials.clientId)!.online, true)
    await host.waitFor(() => host.pushes.some(p => p.method == MEMBERS && p.payload.change.type == 'online'), 'reconnected member')
    assert.deepEqual(pushesOf(host, MEMBERS).map(p => p.payload.change.type), ['join', 'offline', 'online'])
    assert.equal(fixture.pendingTimers(), 0)
    fixture.advance(GRACE_MS + 1)
    assert.equal(unwrap(await reconnected.getRoom())!.members.length, 2)
    const updated = unwrap(await host.hostUpdateState(stateRequest(restored)))
    await reconnected.waitFor(() => reconnected.pushes.some(p => p.method == STATE && p.payload.version == updated.version), 'push on replacement socket')
    results.set('4 kill/reconnect/getRoom', 'pass')
  })

  it('5. rejects before negotiation, enables before together_sync_finished acknowledgement', { timeout: 5000 }, async() => {
    const featuresGate = createGate()
    const togetherFinishedGate = createGate()
    const host = await fixture.connect('host', { featuresGate, togetherFinishedGate }, false)
    const member = await fixture.connect('member')
    await host.waitFor(() => host.handshake.some(h => h.method == 'getEnabledFeatures'), 'feature negotiation')
    assert.equal((host.handshake[0].args[1] as { together: number }).together, 1)
    await assert.rejects(host.createRoom(), /together is not enabled/)
    featuresGate.release()
    await host.waitFor(() => host.handshake.some(h => h.method == 'together_sync_finished'), 'together ready notification')
    // Observed contract: moduleReadys.together is set BEFORE the acknowledgement.
    const room = unwrap(await host.createRoom())
    assert.equal(host.handshake.some(h => h.method == 'finished'), false)
    unwrap(await member.joinRoom(room.code))
    togetherFinishedGate.release()
    await host.waitReady()
    assert.deepEqual(host.handshake.map(h => h.method), ['getEnabledFeatures', 'together_sync_finished', 'finished'])
    assert.equal(unwrap(await host.getRoom())!.roomId, room.roomId)
    results.set('5 ready handshake behavior', 'pass')
  })

  it('6. preserves wire order for a large queue followed by a small state push', { timeout: 5000 }, async t => {
    const { host, member, room } = await pair()
    // Open a wide real-compression window while the small acknowledgement makes
    // a round trip. Incompressible metadata avoids a tiny on-wire queue; repeat
    // three bounded trials to reduce sensitivity to process scheduling.
    // No delay/reordering proxy or codec replacement is used.
    const items = Array.from({ length: 200 }, (_, i) => ({ ...song(String(i)), name: randomBytes(8192).toString('base64') }))
    const trials: Array<{ versions: number[], expected: number[], queueFrame: number, stateFrame: number }> = []
    for (let trial = 0; trial < 3; trial++) {
      fixture.advance(1001) // Keep each trial outside the host update rate window.
      const queued = unwrap(await host.hostUpdateQueue({ roomId: room.roomId, baseVersion: trial + 1, items, currentId: items[0].id }))
      // The small acknowledgement proves the server processed the queue first.
      const updated = unwrap(await host.hostUpdateState(stateRequest(room, { baseVersion: trial + 1 })))
      await member.waitFor(() => pushesOf(member, STATE).length == (trial + 1) * 2, 'both state frames')
      const pushes = pushesOf(member, STATE).slice(trial * 2)
      const queuePush = pushes.find(p => p.payload.queue)!
      const statePush = pushes.find(p => !p.payload.queue)!
      assert.equal(queuePush.payload.version, queued.version)
      assert.equal(statePush.payload.version, updated.version)
      assert.equal(queuePush.payload.queue!.items.length, 200)
      assert.equal(member.frames[queuePush.frameIndex].compressed, true)
      assert.equal(member.frames[statePush.frameIndex].compressed, false)
      trials.push({
        versions: pushes.map(p => p.payload.version), expected: [queued.version, updated.version],
        queueFrame: queuePush.frameIndex, stateFrame: statePush.frameIndex,
      })
    }
    t.diagnostic(`wire version pairs: ${JSON.stringify(trials.map(trial => trial.versions))}`)
    for (const trial of trials) {
      assert.deepEqual(trial.versions, trial.expected, 'room versions must arrive in server update order')
      assert.ok(trial.queueFrame < trial.stateFrame, 'queue frame must arrive on the wire first')
    }
    results.set('6 async compression ordering', 'pass')
  })

  it('7. never rebinds a closed socket when an in-flight feature resync resumes', { timeout: 5000 }, async() => {
    const listDataGate = createGate()
    const host = await fixture.connect('host', { listDataGate })
    const member = await fixture.connect('member')
    const room = unwrap(await host.createRoom())
    unwrap(await member.joinRoom(room.code))
    // Closing rejects the suspended list sync; the continuation must not start
    // together sync or cancel the closed host's grace timer.
    const resync = host.onFeatureChanged({ list: { skipSnapshot: true }, together: true }).then(() => null, error => error)
    await host.waitFor(() => host.handshake.some(h => h.method == 'list_sync_get_list_data'), 'suspended list resync')
    await host.kill()
    await resync
    await waitOffline(member, room.hostId)
    const resumed = unwrap(await member.getRoom())!
    assert.equal(resumed.members.find(m => m.memberId == room.hostId)!.online, false)
    assert.equal(fixture.pendingTimers(), 1)
    fixture.advance(GRACE_MS + 1)
    const after = unwrap(await member.getRoom())!
    assert.equal(after.hostId, member.credentials.clientId, 'the live member must inherit host after grace')
    assert.equal(after.members.some(m => m.memberId == room.hostId), false, 'closed host must expire')
    results.set('7 stale socket rebind', 'pass')
  })

  it('8. releases host membership when together is disabled on an open socket', { timeout: 5000 }, async() => {
    const { host, member, room } = await pair()
    await host.onFeatureChanged({ together: false })
    await assert.rejects(host.getRoom(), /together is not enabled/)
    const after = unwrap(await member.getRoom())!
    assert.equal(after.hostId, member.credentials.clientId)
    assert.equal(after.members.some(m => m.memberId == room.hostId), false)
    assert.equal(fixture.pendingTimers(), 0, 'feature disable leaves immediately without a grace timer')
    const pushCount = host.pushes.length
    const update = unwrap(await member.hostUpdateState(stateRequest(after)))
    await host.onFeatureChanged({}) // Round-trip through the disabled socket's send queue.
    assert.equal(host.pushes.length, pushCount, 'disabled sockets must not receive room broadcasts')
    await host.onFeatureChanged({ together: true })
    assert.equal(unwrap(await host.getRoom()), null, 'enabling again must not restore a membership that was left')
    assert.equal(unwrap(await member.getRoom())!.version, update.version)
    results.set('8 feature disable', 'pass')
  })

  it('9. restores the same device membership when reconnecting with a credential alias', { timeout: 5000 }, async() => {
    const alias = fixture.seedHostAlias()
    const host = await fixture.connect('host', {}, true, alias)
    const member = await fixture.connect('member')
    const room = unwrap(await host.createRoom())
    unwrap(await member.joinRoom(room.code))
    await host.kill()
    await waitOffline(member, room.hostId)
    fixture.advance(GRACE_MS - 1)
    const reconnected = await fixture.connect('host')
    assert.notEqual(alias.clientId, reconnected.credentials.clientId)
    unwrap(await reconnected.ping(1)) // The canonical credential authenticated successfully.
    const restored = unwrap(await reconnected.getRoom())
    const peerView = unwrap(await member.getRoom())!
    assert.ok(restored, 'getRoom must restore the existing device membership')
    assert.equal(restored.roomId, room.roomId)
    assert.equal(restored.hostId, room.hostId, 'public member IDs must remain stable across credential changes')
    assert.equal(restored.members.length, 2)
    assert.equal(restored.members.find(m => m.memberId == restored.hostId)!.online, true)
    assert.deepEqual(peerView, restored)
    assert.equal(fixture.pendingTimers(), 0)
    fixture.advance(GRACE_MS + 1)
    const update = unwrap(await reconnected.hostUpdateState(stateRequest(restored)))
    await member.waitFor(() => member.pushes.some(p => p.method == STATE && p.payload.version == update.version), 'state from restored host')
    results.set('9 credential alias reconnect', 'pass')
  })
})
