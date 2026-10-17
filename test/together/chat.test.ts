import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { ChatStore } from '../../src/modules/together/chatStore'
import { RoomManager } from '../../src/modules/together/roomManage'
import { accounts, codeOf, createFakeClock, createFakeSocket, unwrap } from './fakes'

const directories: string[] = []
const storage = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'together-chat-'))
  directories.push(directory)
  return { directory, store: new ChatStore(directory) }
}
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })
const input = (clientMsgId: string, roomId = '../room') => ({
  roomId, senderId: 'device', displayName: 'Alice', text: 'hello\n世界', at: 123, clientMsgId,
})

describe('together JSONL chat store', () => {
  it('orders concurrent appends, paginates and recovers ids and deduplication after restart', async() => {
    const { directory, store } = storage()
    const results = await Promise.all(Array.from({ length: 105 }, (_, i) => store.append(input(String(i)))))
    assert.deepEqual(results.map(result => result!.message.id), Array.from({ length: 105 }, (_, i) => i + 1))
    const restarted = new ChatStore(directory)
    const page = restarted.history('../room')
    assert.equal(page.messages.length, 50)
    assert.equal(page.messages[0].id, 105)
    assert.equal(page.hasMore, true)
    assert.deepEqual(restarted.history('../room', 6, 5).messages.map(message => message.id), [5, 4, 3, 2, 1])
    assert.equal(restarted.history('../room', 6, 5).hasMore, false)
    assert.deepEqual(restarted.history('../room', 1), { messages: [], hasMore: false })
    assert.deepEqual((await restarted.append(input('0')))!.message, results[0]!.message)
    assert.equal((await restarted.append(input('new')))!.message.id, 106)
    assert.equal(fs.readdirSync(directory).length, 1)
    const lines = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8').trim().split('\n')
    assert.equal(lines.length, 106)
    assert.equal(JSON.parse(lines[0]).text, 'hello\n世界')
  })

  it('ignores a torn final record, including valid JSON without newline, and isolates it on append', async() => {
    const { directory, store } = storage()
    await store.append(input('first'))
    const filename = path.join(directory, fs.readdirSync(directory)[0])
    for (const torn of ['{"id":999', JSON.stringify({ ...input('torn'), id: 999 })]) {
      const committed = fs.readFileSync(filename)
      fs.appendFileSync(filename, torn)
      const restarted = new ChatStore(directory)
      assert.deepEqual(restarted.history('../room').messages.map(message => message.id), [1])
      assert.equal((await restarted.append(input('second')))!.message.id, 2)
      assert.deepEqual(new ChatStore(directory).history('../room').messages.map(message => message.id), [2, 1])
      fs.writeFileSync(filename, committed)
    }
  })
})

const setup = () => {
  const { store, directory } = storage()
  const fake = createFakeClock()
  const manager = new RoomManager({ chatStore: store, clock: fake.clock, getAccount: socket => accounts[socket.userInfo.name], getDeviceClientId: socket => socket.keyInfo.clientId })
  const host = createFakeSocket('host', 'alice')
  const bob = createFakeSocket('bob', 'bob')
  host.feature['together.chat'] = bob.feature['together.chat'] = true
  const room = unwrap(manager.createRoom(host))
  unwrap(manager.joinRoom(bob, { code: room.code }))
  return { manager, host, bob, room, directory, store, ...fake }
}

describe('together rooms: chat', () => {
  it('caps history at 100, snapshots at 50, and excludes old clients from chat pushes', async() => {
    const { manager, host, room, store } = setup()
    const old = createFakeSocket('old', 'carol')
    unwrap(manager.joinRoom(old, { code: room.code }))
    for (let i = 0; i < 105; i++) await store.append(input(String(i), room.roomId))
    assert.equal(unwrap(manager.getRoom(host))!.chat!.length, 50)
    const page = unwrap(manager.chatHistory(host, { roomId: room.roomId, limit: 999 }))
    assert.equal(page.messages.length, 100)
    assert.equal(page.hasMore, true)
    assert.deepEqual(unwrap(manager.chatHistory(host, { roomId: room.roomId, beforeId: 6 })).messages.map(m => m.id), [5, 4, 3, 2, 1])
    unwrap(await manager.chatSend(host, { text: 'new', clientMsgId: 'new' }))
    assert.equal(old.takePushes('together:onChat').length, 0)
    assert.equal('chat' in unwrap(manager.getRoom(old))!, false)
    manager.clear()
  })

  it('validates text, membership, capability and history parameters', async() => {
    const { manager, host, bob, room } = setup()
    for (const text of ['', '  ', 'x'.repeat(501), '\thello', 'hello\r', 'hello\u0000', 'hello\u0085', 123]) {
      assert.equal(codeOf(await manager.chatSend(host, { text, clientMsgId: 'bad' })), 'INVALID_PARAMS')
    }
    for (const clientMsgId of ['', ' ', 1, 'x'.repeat(201)]) {
      assert.equal(codeOf(await manager.chatSend(host, { text: 'hello', clientMsgId })), 'INVALID_PARAMS')
    }
    unwrap(await manager.chatSend(host, { text: ' x'.repeat(250), clientMsgId: 'max' }))
    const outsider = createFakeSocket('outsider', 'carol')
    outsider.feature['together.chat'] = true
    assert.equal(codeOf(await manager.chatSend(outsider, { text: 'hi', clientMsgId: '1' })), 'NOT_IN_ROOM')
    for (const req of [{ roomId: 'wrong' }, { roomId: room.roomId, beforeId: 0 }, { roomId: room.roomId, limit: 0 }, { roomId: room.roomId, limit: 1.5 }]) {
      assert.notEqual(codeOf(manager.chatHistory(bob, req)), 'OK')
    }
    assert.equal(codeOf(manager.chatHistory(outsider, { roomId: room.roomId })), 'NOT_IN_ROOM')
    bob.feature['together.chat'] = false
    assert.equal(codeOf(await manager.chatSend(bob, { text: 'hi', clientMsgId: '1' })), 'INVALID_PARAMS')
    assert.equal('chat' in unwrap(manager.getRoom(bob))!, false)
    manager.handleSocketClosed(host)
    assert.equal(codeOf(manager.chatHistory(host, { roomId: room.roomId })), 'NOT_IN_ROOM')
    manager.clear()
  })

  it('deduplicates concurrent retries per sender, keeps files on close and restores snapshots on rejoin', async() => {
    const { manager, host, bob, room, directory } = setup()
    const req = { text: ' hello\nworld ', clientMsgId: 'same' }
    const results = await Promise.all(Array.from({ length: 8 }, () => manager.chatSend(bob, req)))
    const message = unwrap(results[0])
    for (const result of results) assert.deepEqual(unwrap(result), message)
    assert.deepEqual(message, { ...message, senderId: 'bob', displayName: 'bob', text: 'hello\nworld', id: 1 })
    assert.equal(host.takePushes('together:onChat').length, 1)
    assert.equal(unwrap(await manager.chatSend(host, req)).id, 2)
    manager.handleSocketClosed(bob)
    const replacement = createFakeSocket('bob', 'bob')
    replacement.feature['together.chat'] = true
    assert.deepEqual(unwrap(manager.joinRoom(replacement, { code: room.code })).chat!.map(m => m.id), [2, 1])
    assert.equal(unwrap(manager.chatHistory(replacement, { roomId: room.roomId, limit: 999 })).messages.length, 2)
    unwrap(manager.closeRoom(host, { roomId: room.roomId }))
    assert.equal(codeOf(manager.chatHistory(host, { roomId: room.roomId })), 'NOT_IN_ROOM')
    assert.equal(new ChatStore(directory).history(room.roomId).messages.length, 2)
  })

  it('enforces both sliding windows per member while retries consume no quota', async() => {
    const { manager, host, bob, advance } = setup()
    let sequence = 0
    const send = () => manager.chatSend(host, { text: 'hello', clientMsgId: String(sequence++) })
    for (let batch = 0; batch < 12; batch++) {
      for (let i = 0; i < 5; i++) unwrap(await send())
      assert.equal(codeOf(await send()), 'RATE_LIMITED')
      unwrap(await manager.chatSend(host, { text: 'different', clientMsgId: '0' }))
      if (batch < 11) {
        advance(4999)
        assert.equal(codeOf(await send()), 'RATE_LIMITED')
        advance(1)
      }
    }
    advance(4999)
    assert.equal(codeOf(await send()), 'RATE_LIMITED')
    advance(1)
    unwrap(await send())
    unwrap(await manager.chatSend(bob, { text: 'independent', clientMsgId: '0' }))
    manager.clear()
  })
})
