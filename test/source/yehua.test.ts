import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  enableScript,
  resetSourceRegistryForTests,
  uploadScript,
} from '../../src/modules/source'
import { setAllowLoopbackForTests } from '../../src/modules/source/httpClient'

const yehuaScript = fs.readFileSync(
  '/cursor/stores/bc-d7c47bf3-18f3-40be-b125-396b40fc4fbb/internal/source-scripts/yehua-v1.js',
  'utf8',
)

describe('yehua script sandbox', () => {
  beforeEach(async() => {
    process.env.LUX_SOURCE_TIMEOUT_MS = '30000'
    setAllowLoopbackForTests(false)
    await resetSourceRegistryForTests()
  })

  afterEach(async() => {
    delete process.env.LUX_SOURCE_TIMEOUT_MS
    await resetSourceRegistryForTests()
  })

  it('initializes 野花 fixture (real registry fetch)', async() => {
    const uploaded = await uploadScript(yehuaScript)
    const view = await enableScript(uploaded.id)
    assert.equal(view.status, 'ready', view.error ?? 'no error text')
    assert.ok(view.sources.kw || view.sources.kg || view.sources.tx)
  })
})
