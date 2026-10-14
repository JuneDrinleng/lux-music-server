import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  enableScript,
  getScriptViews,
  resetSourceRegistryForTests,
  uploadScript,
} from '../../src/modules/source'

const HEADER = `/**
 * @name inited-then-fatal
 * @version 1
 */`

/** Sends inited, then rejects an unhandled promise (野花-style) after initWait has resolved. */
const initedThenFatal = `${HEADER}
;(function(){
  void lx.on('request', async () => 'https://example.com/a.mp3')
  void lx.send('inited', { sources: { kw: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } })
  Promise.reject(new AggregateError([new Error('mirror FAILED'), new Error('npm FAILED')], 'registry fetch failed'))
})()
`

describe('fatal worker errors after init', () => {
  beforeEach(async() => {
    process.env.LUX_SOURCE_TIMEOUT_MS = '8000'
    await resetSourceRegistryForTests()
  })

  afterEach(async() => {
    delete process.env.LUX_SOURCE_TIMEOUT_MS
    await resetSourceRegistryForTests()
  })

  it('does not auto-restart or heartbeat-loop after post-init unhandledRejection', async() => {
    const uploaded = await uploadScript(initedThenFatal)
    const view = await enableScript(uploaded.id)
    assert.equal(view.status, 'ready')
    await new Promise(resolve => setTimeout(resolve, 1200))
    const stable = getScriptViews().find(s => s.id == uploaded.id)
    assert.ok(stable)
    assert.equal(stable!.status, 'error')
    assert.match(stable!.error ?? '', /unhandledRejection|registry fetch failed|mirror FAILED/)
    assert.doesNotMatch(stable!.error ?? '', /restarting in/)
    await new Promise(resolve => setTimeout(resolve, 1500))
    const later = getScriptViews().find(s => s.id == uploaded.id)
    assert.equal(later!.status, 'error')
    assert.doesNotMatch(later!.error ?? '', /restarting in/)
  })
})
