import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  enableScript,
  resetSourceRegistryForTests,
  uploadScript,
} from '../../src/modules/source'

const HEADER = `/**
 * @name slow-sync-boot
 * @version 1
 */`

const slowSyncBoot = `${HEADER}
const end = Date.now() + 2000
while (Date.now() < end) { /* block worker loop during init */ }
void lx.send('inited', { sources: { kw: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } })
`

describe('heartbeat during init', () => {
  beforeEach(async() => {
    process.env.LUX_SOURCE_TIMEOUT_MS = '10000'
    await resetSourceRegistryForTests()
  })

  afterEach(async() => {
    delete process.env.LUX_SOURCE_TIMEOUT_MS
    await resetSourceRegistryForTests()
  })

  it('allows sync boot longer than 500ms before first pong', async() => {
    const uploaded = await uploadScript(slowSyncBoot)
    const view = await enableScript(uploaded.id)
    assert.equal(view.status, 'ready', view.error ?? '')
  })
})
