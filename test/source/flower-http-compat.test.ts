import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isFlowerSourceInfoRequest,
  rewriteFlowerSourceInfoRequest,
  wrapFlowerRegistryBody,
} from '../../src/modules/source/flowerHttpCompat'

describe('flower HTTP compat', () => {
  it('detects flower-source-info latest URLs', () => {
    assert.equal(isFlowerSourceInfoRequest('http://97.64.37.235/flower-source-info/latest'), true)
    assert.equal(isFlowerSourceInfoRequest('https://registry.npmjs.org/flower-source-info/latest'), true)
    assert.equal(isFlowerSourceInfoRequest('http://97.64.37.235/kw/url/1/128k'), false)
  })

  it('rewrites legacy 97.x info URL to npm mirror', () => {
    assert.match(
      rewriteFlowerSourceInfoRequest('http://97.64.37.235/flower-source-info/latest')!,
      /registry\.npmmirror\.com/,
    )
  })

  it('wraps npm vinfo JSON into legacy data envelope', () => {
    const npm = Buffer.from(JSON.stringify({
      name: 'flower-source-info',
      version: '1.0.1',
      vinfo: { '1': { s: 'kw|128k', m: 'abc' }, lv: '1' },
    }))
    const wrapped = JSON.parse(wrapFlowerRegistryBody(npm).toString('utf8')) as { code: number, data: { vinfo: unknown } }
    assert.equal(wrapped.code, 200)
    assert.ok(wrapped.data.vinfo)
  })
})
