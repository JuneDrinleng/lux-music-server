import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  enableScript,
  resetSourceRegistryForTests,
  uploadScript,
} from '../../src/modules/source'
import { setAllowLoopbackForTests } from '../../src/modules/source/httpClient'

/** Same init pattern as 野花: remote registry then send inited or throw in finally */
const obfuscatedStyleInit = `/**
 * @name obfuscated-style
 * @version 1
 */
;(function(){
  const { request, on, send, EVENT_NAMES, currentScriptInfo } = globalThis.lx
  on(EVENT_NAMES.request, async () => 'https://example.com/a.mp3')
  const load = url => new Promise((resolve, reject) => {
    request(url, { method: 'GET' }, (err, resp) => {
      if (err || !resp?.body) return reject(err || new Error('failed'))
      resolve(resp.body)
    })
  })
  Promise.all([
    load('http://127.0.0.1:1/nope-a'),
    load('http://127.0.0.1:1/nope-b'),
  ]).then(() => {}).finally(() => {
    throw new Error('registry bootstrap failed')
  })
})()
`

describe('yehua failure modes', () => {
  beforeEach(async() => {
    process.env.LUX_SOURCE_TIMEOUT_MS = '5000'
    setAllowLoopbackForTests(true)
    await resetSourceRegistryForTests()
  })

  afterEach(async() => {
    delete process.env.LUX_SOURCE_TIMEOUT_MS
    setAllowLoopbackForTests(false)
    await resetSourceRegistryForTests()
  })

  it('surfaces init throw in promise finally (not exit code 1 only)', async() => {
    const uploaded = await uploadScript(obfuscatedStyleInit)
    const view = await enableScript(uploaded.id)
    assert.equal(view.status, 'error')
    assert.match(view.error ?? '', /registry bootstrap failed|script init timeout/)
    assert.doesNotMatch(view.error ?? '', /^worker exited with code 1/)
  })
})
