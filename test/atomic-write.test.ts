import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWriteFileSync } from '../src/utils/atomicWrite'

describe('atomic file writes', () => {
  let root: string
  let target: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lux-atomic-test-'))
    target = path.join(root, 'accounts.json')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('creates and replaces content without leaving temp files', () => {
    for (const content of ['first', '{"text":"音乐 🎵"}']) {
      atomicWriteFileSync(target, content)
      assert.equal(fs.readFileSync(target, 'utf-8'), content)
      assert.deepEqual(fs.readdirSync(root), ['accounts.json'])
    }
  })

  it('flushes the temp file before replacing the target, then flushes the directory', t => {
    fs.writeFileSync(target, 'original')
    const sync = fs.fsyncSync
    const rename = fs.renameSync
    const events: string[] = []
    t.mock.method(fs, 'fsyncSync', (fd: number) => {
      events.push(fs.fstatSync(fd).isDirectory() ? 'directory sync' : 'file sync')
      sync(fd)
    })
    t.mock.method(fs, 'renameSync', (source: string, destination: string) => {
      events.push('rename')
      assert.equal(path.dirname(source), root)
      assert.match(path.basename(source), /^accounts\.json\.tmp-\d+-[a-f0-9]+$/)
      assert.equal(fs.readFileSync(target, 'utf-8'), 'original')
      assert.equal(fs.readFileSync(source, 'utf-8'), 'replacement')
      rename(source, destination)
    })
    atomicWriteFileSync(target, 'replacement')
    assert.deepEqual(events, ['file sync', 'rename', 'directory sync'])
  })

  for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync'] as const) {
    it(`preserves the target and cleans up when ${operation} fails`, t => {
      fs.writeFileSync(target, 'original')
      t.mock.method(fs, operation, () => { throw new Error('simulated failure') })
      assert.throws(() => atomicWriteFileSync(target, 'replacement'), /simulated failure/)
      assert.equal(fs.readFileSync(target, 'utf-8'), 'original')
      assert.deepEqual(fs.readdirSync(root), ['accounts.json'])
    })
  }

  for (const code of ['EINVAL', 'EPERM']) {
    it(`ignores ${code} for directory fsync`, t => {
      const sync = fs.fsyncSync
      t.mock.method(fs, 'fsyncSync', (fd: number) => {
        if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error(code), { code })
        sync(fd)
      })
      atomicWriteFileSync(target, 'saved')
      assert.equal(fs.readFileSync(target, 'utf-8'), 'saved')
      assert.deepEqual(fs.readdirSync(root), ['accounts.json'])
    })
  }
})
