import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  enableScript,
  getScriptViews,
  resetSourceRegistryForTests,
  uploadScript,
} from '../../src/modules/source'

const HEADER = `/**
 * @name unhandled-init-fail
 * @version 1
 */`

/** Mirrors 野花: async init ends with throw in Promise.finally → unhandledRejection + exit 1 */
const unhandledFinallyThrow = `${HEADER}
;(function(){
  void lx.on('request', async () => 'https://example.com/a.mp3')
  Promise.resolve().finally(() => {
    throw new Error('registry bootstrap failed (test)')
  })
})()
`

describe('worker exit error surfacing', () => {
  beforeEach(async() => {
    process.env.LUX_SOURCE_TIMEOUT_MS = '8000'
    await resetSourceRegistryForTests()
  })

  afterEach(async() => {
    delete process.env.LUX_SOURCE_TIMEOUT_MS
    await resetSourceRegistryForTests()
  })

  it('keeps unhandledRejection message instead of generic exit code 1', async() => {
    const uploaded = await uploadScript(unhandledFinallyThrow)
    const view = await enableScript(uploaded.id)
    assert.equal(view.status, 'error')
    assert.match(view.error ?? '', /registry bootstrap failed/)
    assert.doesNotMatch(view.error ?? '', /^worker exited with code 1/)
    assert.doesNotMatch(view.error ?? '', /restarting in/)
    await new Promise(resolve => setTimeout(resolve, 1500))
    const stable = getScriptViews().find(s => s.id == uploaded.id)
    assert.ok(stable)
    assert.equal(stable!.status, 'error')
    assert.match(stable!.error ?? '', /registry bootstrap failed/)
    assert.doesNotMatch(stable!.error ?? '', /restarting in/)
  })
})
