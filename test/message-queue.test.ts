import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMessageQueue } from '../src/server/messageQueue'
import { decryptMsg, encryptMsg } from '../src/utils/tools'

const gate = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

describe('per-socket message queues', () => {
  for (const direction of ['send', 'receive'] as const) {
    it(`preserves ${direction} order across compressed and plain frames`, async() => {
      const first = JSON.stringify({ name: 'first', data: 'large payload'.repeat(1000) })
      const second = JSON.stringify({ name: 'second' })
      const inputs = direction == 'send'
        ? [first, second]
        : await Promise.all([encryptMsg(null, first), encryptMsg(null, second)])
      const codec = direction == 'send' ? encryptMsg : decryptMsg
      const started: string[] = []
      const output: string[] = []
      const firstStarted = gate()
      const finishFirst = gate()
      const enqueue = createMessageQueue({
        isOpen: () => true,
        async transform(data) {
          started.push(data)
          if (data == inputs[0]) {
            firstStarted.release()
            await finishFirst.promise
          }
          return codec(null, data)
        },
        handle: data => { output.push(data) },
        onError: error => { throw error },
      })
      const firstDone = enqueue(inputs[0])
      const secondDone = enqueue(inputs[1])
      await firstStarted.promise
      assert.deepEqual(started, [inputs[0]], 'the next codec must wait for the previous frame')
      assert.deepEqual(output, [])
      finishFirst.release()
      await Promise.all([firstDone, secondDone])
      assert.deepEqual(direction == 'send' ? await Promise.all(output.map(data => decryptMsg(null, data))) : output, [first, second])
      if (direction == 'send') {
        assert.ok(output[0].startsWith('cg_'))
        assert.equal(output[1], second)
      }
    })
  }

  it('drops in-flight and queued frames when the socket closes during the codec', async() => {
    let open = true
    const started = gate()
    const finish = gate()
    const transformed: string[] = []
    const handled: string[] = []
    const enqueue = createMessageQueue({
      isOpen: () => open,
      async transform(data) {
        transformed.push(data)
        started.release()
        await finish.promise
        return data
      },
      handle: data => { handled.push(data) },
      onError: error => { throw error },
    })
    const pending = [enqueue('first'), enqueue('second')]
    await started.promise
    open = false
    finish.release()
    await Promise.all(pending)
    assert.deepEqual(transformed, ['first'])
    assert.deepEqual(handled, [])
  })

  it('reports codec failures and stops queued work after the error closes the socket', async() => {
    let open = true
    const failure = new Error('invalid compressed frame')
    const errors: unknown[] = []
    let codecCalls = 0
    const enqueue = createMessageQueue({
      isOpen: () => open,
      async transform() {
        codecCalls++
        throw failure
      },
      handle: () => { assert.fail('failed frames must never be dispatched') },
      onError(error) {
        errors.push(error)
        open = false
      },
    })
    await Promise.all([enqueue('bad frame'), enqueue('next frame')])
    assert.deepEqual(errors, [failure])
    assert.equal(codecCalls, 1)
  })
})
