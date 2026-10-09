import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMsg2call } from 'message2call'
import { SYNC_CODE } from '../src/constants'
import { featureVersion } from '../src/modules'
import { callObj } from '../src/server/sync'
import { PlayHistoryStore } from '../src/modules/playHistory/store'
import { PlayHistoryValidationError } from '../src/modules/playHistory/validate'
import { PLAY_HISTORY_LIMITS, PLAY_HISTORY_PULL, PLAY_HISTORY_PUSH } from '../src/modules/playHistory/protocol'
import handler from '../src/modules/playHistory/sync/handler'
import { sync } from '../src/server/sync/sync'
import featureHandler from '../src/server/sync/handler'
import { getUserDirname, releaseUserSpace } from '../src/user'

const record = (
  deviceId: string,
  startedAt: number,
  patch: Partial<LX.Sync.PlayHistory.Record> & { song?: Partial<LX.Sync.PlayHistory.Song> } = {},
): LX.Sync.PlayHistory.Record => {
  const song = {
    source: 'kw',
    songmid: `mid-${startedAt}`,
    name: 'song',
    singer: 'singer',
    ...patch.song,
  }
  return {
    id: `${deviceId}:${startedAt}`,
    deviceId,
    startedAt,
    endedAt: startedAt + 30_000,
    listenedMs: 30_000,
    ...patch,
    song,
  }
}

describe('play history store', () => {
  let dir: string
  let now: number
  let store: PlayHistoryStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-history-'))
    now = 1_000
    store = new PlayHistoryStore(dir, { now: () => now })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const filePath = () => path.join(dir, 'records.json')

  it('upserts by id and ignores duplicates, including inside one batch', async() => {
    const first = record('phone', 10, { listenedMs: 1000 })
    const again = record('phone', 10, { listenedMs: 9999, song: { name: 'changed' } })
    const other = record('pad', 10)

    const inserted = await store.push({ records: [first, first] })
    assert.deepEqual(inserted, { accepted: 1, ignored: 1, cursor: 1000 })

    now = 1000
    const retry = await store.push({ records: [again, other] })
    assert.deepEqual(retry, { accepted: 1, ignored: 1, cursor: 1001 })

    const pulled = await store.pull({ since: 0 })
    assert.equal(pulled.hasMore, false)
    assert.equal(pulled.records.length, 2)
    assert.equal(pulled.records[0].listenedMs, 1000)
    assert.equal(pulled.records[0].song.name, 'song')
    assert.equal(pulled.records[1].deviceId, 'pad')
    assert.equal('receivedAt' in pulled.records[0], false)
  })

  it('keeps a monotonic cursor across a frozen clock and a restart', async() => {
    await store.push({ records: [record('phone', 1), record('phone', 2)] })
    const reloaded = new PlayHistoryStore(dir, { now: () => 1000 })
    const result = await reloaded.push({ records: [record('phone', 3), record('phone', 1)] })
    assert.deepEqual(result, { accepted: 1, ignored: 1, cursor: 1002 })

    const file = JSON.parse(fs.readFileSync(filePath(), 'utf8')) as { cursor: number, records: Array<{ id: string, receivedAt: number }> }
    assert.deepEqual(file.records.map(item => item.receivedAt), [1000, 1001, 1002])
    assert.equal(file.cursor, 1002)
    assert.equal(fs.existsSync(filePath() + '.tmp'), false)
  })

  it('pages by receivedAt with hasMore and does not move the cursor backwards', async() => {
    const batchSize = PLAY_HISTORY_LIMITS.maxBatch
    const total = PLAY_HISTORY_LIMITS.maxPage + 1
    for (let offset = 0; offset < total; offset += batchSize) {
      const records = []
      for (let index = offset; index < Math.min(total, offset + batchSize); index++) {
        records.push(record('phone', index))
      }
      await store.push({ records })
    }

    const first = await store.pull({})
    assert.equal(first.records.length, PLAY_HISTORY_LIMITS.maxPage)
    assert.equal(first.hasMore, true)
    assert.equal(first.records[0].id, 'phone:0')
    assert.equal(first.records[first.records.length - 1].id, `phone:${PLAY_HISTORY_LIMITS.maxPage - 1}`)

    const second = await store.pull({ since: first.cursor })
    assert.equal(second.hasMore, false)
    assert.deepEqual(second.records.map(item => item.id), [`phone:${PLAY_HISTORY_LIMITS.maxPage}`])

    const done = await store.pull({ since: second.cursor })
    assert.deepEqual(done, { records: [], cursor: second.cursor, hasMore: false })

    const ahead = await store.pull({ since: second.cursor + 50 })
    assert.deepEqual(ahead, { records: [], cursor: second.cursor + 50, hasMore: false })
  })

  it('merges every device of the user in receivedAt order', async() => {
    await store.push({ records: [record('pad', 50)] })
    now = 2000
    await store.push({ records: [record('phone', 1)] })
    const pulled = await store.pull({ since: 0 })
    assert.deepEqual(pulled.records.map(item => item.deviceId), ['pad', 'phone'])
  })

  it('rejects invalid batches without writing or keeping a partial batch', async() => {
    await assert.rejects(store.push({ records: [record('phone', 1), { ...record('phone', 2), id: 'nope' }] }), PlayHistoryValidationError)
    assert.equal(fs.existsSync(filePath()), false)
    assert.deepEqual(await store.pull(undefined), { records: [], cursor: 0, hasMore: false })

    await store.push({ records: [record('phone', 1)] })
    const before = fs.readFileSync(filePath(), 'utf8')
    const tooLong = record('phone', 2)
    tooLong.song.name = 'n'.repeat(PLAY_HISTORY_LIMITS.name + 1)
    await assert.rejects(store.push({ records: [record('phone', 3), tooLong] }), /song\.name exceeds limit/)
    assert.equal(fs.readFileSync(filePath(), 'utf8'), before)

    const oversized = Array.from({ length: PLAY_HISTORY_LIMITS.maxBatch + 1 }, (_, index) => record('phone', 100 + index))
    await assert.rejects(store.push({ records: oversized }), /records exceeds limit of 500/)

    const exact = Array.from({ length: PLAY_HISTORY_LIMITS.maxBatch }, (_, index) => record('desk', index + 1))
    const accepted = await store.push({ records: exact })
    assert.equal(accepted.accepted, PLAY_HISTORY_LIMITS.maxBatch)

    await assert.rejects(store.push({ records: 'nope' }), /records must be an array/)
    await assert.rejects(store.pull({ since: -1 }), /since must be a non-negative integer/)
    await assert.rejects(store.pull({ since: 1.5 }), /since must be a non-negative integer/)
    await assert.rejects(store.push({ records: [record('phone', 1.5 as unknown as number)] }), /startedAt must be a non-negative integer/)

    const colon = await store.push({
      records: [{
        ...record('a:b', 7),
        song: { source: 'tx', songmid: 'm', name: '', singer: 's', albumName: 'album', interval: '03:00', img: 'https://img' },
        extra: true,
        receivedAt: 1,
      }],
    })
    assert.equal(colon.accepted, 1)
    const pulled = await store.pull({ since: colon.cursor - 1 })
    assert.equal(pulled.records.length, 1)
    assert.equal(pulled.records[0].id, 'a:b:7')
    assert.equal(pulled.records[0].song.name, '')
    assert.equal(pulled.records[0].song.albumName, 'album')
    assert.equal(pulled.records[0].song.interval, '03:00')
    assert.equal('extra' in pulled.records[0], false)
    assert.equal('receivedAt' in pulled.records[0], false)
  })
})

describe('play history protocol', () => {
  const users: string[] = []

  afterEach(() => {
    for (const name of users) releaseUserSpace(name, true)
    users.length = 0
  })

  const socketFor = (name: string, playHistory: boolean) => {
    users.push(name)
    return {
      userInfo: { name },
      moduleReadys: { list: false, dislike: false, playHistory },
      feature: { list: false, dislike: false, playHistory: false },
    } as unknown as LX.Socket
  }

  it('keeps the legacy handshake and only enables play history when negotiated', async() => {
    assert.equal(SYNC_CODE.helloMsg, 'Hello~::^-^::~v4~')
    assert.equal(featureVersion.list, 1)
    assert.equal(featureVersion.dislike, 1)
    assert.equal(featureVersion.playHistory, 1)
    assert.equal(typeof callObj[PLAY_HISTORY_PUSH], 'function')
    assert.equal(typeof callObj[PLAY_HISTORY_PULL], 'function')
    assert.equal(typeof callObj.onListSyncAction, 'function')
    assert.equal(typeof callObj.onDislikeSyncAction, 'function')
    assert.equal(typeof callObj.onFeatureChanged, 'function')

    const disabled = socketFor('legacy-user', false)
    await assert.rejects(handler[PLAY_HISTORY_PUSH](disabled, { records: [] }), /playHistory is not enabled/)
    const legacyFile = path.join(global.lx.userPath, getUserDirname('legacy-user'), 'playHistory', 'records.json')
    assert.equal(fs.existsSync(legacyFile), false)

    let advertised: { list: number, dislike: number, playHistory?: number } | null = null
    const negotiating = socketFor('lux-user', false)
    negotiating.onClose = () => () => {}
    negotiating.remote = {
      async getEnabledFeatures(_serverType: string, supported: { list: number, dislike: number, playHistory?: number }) {
        advertised = supported
        return {}
      },
      async finished() {},
    } as LX.Socket['remote']
    await sync(negotiating)
    assert.equal(advertised?.list, 1)
    assert.equal(advertised?.dislike, 1)
    assert.equal(advertised?.playHistory, 1)
    assert.equal(negotiating.moduleReadys.playHistory, false)

    negotiating.remote.getEnabledFeatures = async() => ({ playHistory: true })
    await sync(negotiating)
    assert.equal(negotiating.moduleReadys.playHistory, true)
    assert.equal(negotiating.feature.playHistory, true)

    await featureHandler.onFeatureChanged(negotiating, { playHistory: false })
    assert.equal(negotiating.moduleReadys.playHistory, false)
  })

  it('routes playHistory:push and playHistory:pull through message2call', async() => {
    const socket = socketFor('rpc-user', true)
    let client!: ReturnType<typeof createMsg2call>
    const server = createMsg2call({
      funcsObj: callObj,
      sendMessage(data: unknown) {
        client.message(data)
      },
      onCallBeforeParams(rawArgs: unknown[]) {
        return [socket, ...rawArgs]
      },
    })
    client = createMsg2call({
      funcsObj: {},
      sendMessage(data: unknown) {
        server.message(data)
      },
    })

    const remote = client.remote as Record<string, (payload?: unknown) => Promise<any>>
    const pushed = await remote[PLAY_HISTORY_PUSH]({ records: [record('phone', 8)] })
    assert.equal(pushed.accepted, 1)
    const pulled = await remote[PLAY_HISTORY_PULL]()
    assert.equal(pulled.records[0].id, 'phone:8')
    assert.equal(pulled.hasMore, false)
    const retry = await remote[PLAY_HISTORY_PUSH]({ records: [record('phone', 8, { listenedMs: 1 })] })
    assert.deepEqual(retry, { accepted: 0, ignored: 1, cursor: pushed.cursor })
    const again = await remote[PLAY_HISTORY_PULL]({ since: pulled.cursor })
    assert.deepEqual(again.records, [])

    socket.moduleReadys.playHistory = false
    await assert.rejects(remote[PLAY_HISTORY_PULL]({ since: 0 }), /playHistory is not enabled/)

    server.destroy()
    client.destroy()
  })

  it('persists through user-space reload and keeps users apart', async() => {
    const alice = socketFor('alice', true)
    const bob = socketFor('bob', true)
    await handler[PLAY_HISTORY_PUSH](alice, { records: [record('phone', 5, { song: { name: 'alice-song' } })] })
    releaseUserSpace('alice', true)
    const pulled = await handler[PLAY_HISTORY_PULL](alice, {})
    assert.equal(pulled.records.length, 1)
    assert.equal(pulled.records[0].song.name, 'alice-song')
    assert.equal(pulled.hasMore, false)

    const bobPull = await handler[PLAY_HISTORY_PULL](bob, { since: 0 })
    assert.deepEqual(bobPull.records, [])

    const file = path.join(global.lx.userPath, getUserDirname('alice'), 'playHistory', 'records.json')
    assert.equal(fs.existsSync(file), true)
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number, records: Array<{ receivedAt: number }> }
    assert.equal(stored.version, 1)
    assert.equal(typeof stored.records[0].receivedAt, 'number')
  })
})
