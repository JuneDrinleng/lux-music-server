import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./image-tags.mjs', import.meta.url))
const image = 'ghcr.io/junedrinleng/lux-music-server'

function tags(version, pre) {
  const result = spawnSync(process.execPath, [script, image, version, pre], { encoding: 'utf8' })
  return result
}

test('稳定版 tag 是 X.Y.Z、latest、X.Y', () => {
  const result = tags('0.1.0', 'false')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), [
    `${image}:0.1.0`,
    `${image}:latest`,
    `${image}:0.1`,
  ])
})

test('两位 minor 的浮动 tag 是 X.Y 而不是只剩 major', () => {
  const result = tags('0.10.2', 'false')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), [
    `${image}:0.10.2`,
    `${image}:latest`,
    `${image}:0.10`,
  ])
})

test('开发版只有版本 tag 和 dev，不带 latest 或 X.Y', () => {
  const result = tags('0.1.0-dev.3', 'true')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), [
    `${image}:0.1.0-dev.3`,
    `${image}:dev`,
  ])
  assert.equal(result.stdout.includes('latest'), false)
})

test('稳定版不能用预发布号，开发版标记也不能配正式号', () => {
  assert.notEqual(tags('0.1.0-dev.1', 'false').status, 0)
  assert.notEqual(tags('0.1.0', 'true').status, 0)
  assert.notEqual(tags('0.1', 'false').status, 0)
})
