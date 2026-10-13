import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearAllSourceCacheForTests,
  enableScript,
  resetSourceRegistryForTests,
  uploadScript,
} from '../../src/modules/source'
import { getSourceCache, setSourceCache } from '../../src/modules/source/cache'
import { resolveMusicUrl } from '../../src/modules/source/resolver'
import { setAllowLoopbackForTests } from '../../src/modules/source/httpClient'

const HEADER = `/**
 * @name test-src
 * @description sandbox test
 * @version 1.0.0
 * @author test
 * @homepage https://example.com
 */`

const kwMusic = (): LX.Music.MusicInfoOnline => ({
  id: 'kw-test-1',
  name: 'Test Song',
  singer: 'Singer',
  source: 'kw',
  interval: '03:00',
  meta: {
    songId: 'kw-test-1',
    albumName: 'Album',
    qualitys: [{ type: '128k', size: '1M' }],
    _qualitys: { '128k': { size: '1M' } },
  },
})

const okScript = `${HEADER}
lx.on('request', async ({ action }) => {
  if (action === 'musicUrl') return 'https://example.com/track.mp3'
  if (action === 'lyric') return { lyric: 'line' }
  return 'https://example.com/cover.jpg'
})
void lx.send('inited', { sources: { kw: { type: 'music', actions: ['musicUrl', 'lyric', 'pic'], qualitys: ['128k', '320k'] } } })
`

const slowScript = `${HEADER}
lx.on('request', () => new Promise(() => {}))
void lx.send('inited', { sources: { kw: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } })
`

const brokenScript = `${HEADER}
throw new Error('script boot failed')
`

describe('source module', () => {
  beforeEach(async() => {
    process.env.LUX_SOURCE_TIMEOUT_MS = '5000'
    setAllowLoopbackForTests(true)
    await resetSourceRegistryForTests()
    clearAllSourceCacheForTests()
  })

  afterEach(async() => {
    delete process.env.LUX_SOURCE_TIMEOUT_MS
    setAllowLoopbackForTests(false)
    await resetSourceRegistryForTests()
    clearAllSourceCacheForTests()
  })

  it('caches music url results', () => {
    const key = 'url:kw:1:128k'
    const payload = { url: 'https://example.com/a.mp3', proxied: false, quality: '128k' as const, musicInfo: kwMusic(), toggled: false, fromCache: false, expiresAt: 0 }
    const expiresAt = setSourceCache('url', key, payload, 1000)
    const hit = getSourceCache<typeof payload>('url', key, 1001)
    assert.ok(hit)
    assert.equal(hit!.expiresAt, expiresAt)
    assert.equal(hit!.value.url, payload.url)
  })

  it('resolves music url via enabled script', async() => {
    const uploaded = await uploadScript(okScript)
    await enableScript(uploaded.id)
    const socket = { moduleReadys: { source: true } } as LX.Socket
    const result = await resolveMusicUrl(socket, { musicInfo: kwMusic(), quality: '128k' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.match(result.data.url, /^https:\/\/example\.com\//)
    assert.equal(result.data.fromCache, false)
    const cached = await resolveMusicUrl(socket, { musicInfo: kwMusic(), quality: '128k' })
    assert.equal(cached.ok, true)
    if (!cached.ok) return
    assert.equal(cached.data.fromCache, true)
  })

  it('marks script error when boot throws', async() => {
    const uploaded = await uploadScript(brokenScript)
    const view = await enableScript(uploaded.id)
    assert.equal(view.status, 'error')
    assert.match(view.error ?? '', /boot failed|script init timeout/)
  })

  it('returns TIMEOUT when script action exceeds per-call timeout', async() => {
    process.env.LUX_SOURCE_TIMEOUT_MS = '1000'
    const uploaded = await uploadScript(slowScript)
    await enableScript(uploaded.id)
    const socket = { moduleReadys: { source: true } } as LX.Socket
    const result = await resolveMusicUrl(socket, { musicInfo: kwMusic(), quality: '128k' })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'TIMEOUT')
  })
})
