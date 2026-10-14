import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeScriptMusicInfo } from '../../src/modules/source/normalizeScriptMusicInfo'

describe('normalizeScriptMusicInfo', () => {
  it('sets songmid from meta.songId for kw', () => {
    const info = normalizeScriptMusicInfo({
      id: 'kw_123',
      name: 'n',
      singer: 's',
      source: 'kw',
      interval: '03:00',
      meta: { songId: '228908', albumName: 'a', qualitys: [], _qualitys: {} },
    })
    assert.equal((info as unknown as { songmid: string }).songmid, '228908')
  })

  it('sets hash for kg', () => {
    const info = normalizeScriptMusicInfo({
      id: 'kg_1',
      name: 'n',
      singer: 's',
      source: 'kg',
      interval: '03:00',
      meta: { songId: 'abc', hash: 'deadbeef', albumName: 'a', qualitys: [], _qualitys: {} },
    })
    assert.equal((info as unknown as { hash: string }).hash, 'deadbeef')
  })

  it('sets tx fields', () => {
    const info = normalizeScriptMusicInfo({
      id: 'tx_1',
      name: 'n',
      singer: 's',
      source: 'tx',
      interval: '03:00',
      meta: {
        songId: '0039MnYb0qxYhV',
        strMediaMid: '0039MnYb0qxYhV',
        albumName: 'a',
        qualitys: [],
        _qualitys: {},
      },
    })
    assert.equal((info as unknown as { songmid: string }).songmid, '0039MnYb0qxYhV')
  })
})
