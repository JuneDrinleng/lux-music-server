import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initAccountStore } from '../src/account/store'

describe('account store persistence', () => {
  let root: string
  let filePath: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lux-accounts-test-'))
    fs.mkdirSync(path.join(root, 'lux'))
    filePath = path.join(root, 'lux', 'accounts.json')
    global.lx.config.users = []
    delete process.env.LUX_ADMIN_USER
    delete process.env.LUX_ADMIN_PASSWORD
    delete process.env.LUX_TOKEN_SECRET
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const assertRefuses = (bytes: Buffer) => {
    fs.writeFileSync(filePath, bytes)
    assert.throws(() => initAccountStore(root), /Refusing to start/)
    assert.deepEqual(fs.readFileSync(filePath), bytes)
    const backups = fs.readdirSync(path.dirname(filePath)).filter(name => name.startsWith('accounts.json.corrupt-'))
    assert.equal(backups.length, 1)
    assert.ok(!backups[0].includes(':'))
    assert.deepEqual(fs.readFileSync(path.join(root, 'lux', backups[0])), bytes)
    return path.join(root, 'lux', backups[0])
  }

  it('refuses corrupt JSON, preserves bytes, and logs the backup path and recovery instructions', t => {
    const log = t.mock.method(console, 'error', () => {})
    const backupPath = assertRefuses(Buffer.from([0x7b, 0x22, 0xff, 0x00, 0x0a]))
    assert.equal(log.mock.callCount(), 1)
    const message = log.mock.calls[0].arguments[0] as string
    assert.ok(message.includes(backupPath))
    assert.match(message, /corrupt or unreadable/)
    assert.match(message, /Restore a known-good backup or move the file away to start fresh/)
  })

  for (const shape of [null, [], {}, { version: 1, users: {}, invites: [] },
    { version: 1, users: [null], invites: [] },
    { version: 1, users: [], invites: [{}] },
    { version: 1, users: [], invites: [], suppressedConfigUsernames: [1] },
    { version: 1, users: [], invites: [], tokenSecret: 123 }]) {
    it(`refuses invalid shape ${JSON.stringify(shape)}`, t => {
      t.mock.method(console, 'error', () => {})
      assertRefuses(Buffer.from(JSON.stringify(shape)))
    })
  }

  it('loads an older valid store that lacks newer optional fields', t => {
    t.mock.method(console, 'error', () => {})
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, users: [{ id: 'u1', username: 'old' }] }))
    assert.doesNotThrow(() => initAccountStore(root))
  })

  it('backs up and refuses an existing file when reading fails', t => {
    const bytes = Buffer.from('{"version":1,"users":[],"invites":[]}')
    fs.writeFileSync(filePath, bytes)
    t.mock.method(console, 'error', () => {})
    const read = t.mock.method(fs, 'readFileSync', () => {
      throw Object.assign(new Error('read denied'), { code: 'EACCES' })
    })
    assert.throws(() => initAccountStore(root), /Refusing to start/)
    read.mock.restore()
    assert.deepEqual(fs.readFileSync(filePath), bytes)
    const backup = fs.readdirSync(path.dirname(filePath)).find(name => name.startsWith('accounts.json.corrupt-'))
    assert.ok(backup)
    assert.deepEqual(fs.readFileSync(path.join(root, 'lux', backup)), bytes)
  })

  it('refuses even if a backup cannot be created', t => {
    const bytes = Buffer.from('{broken')
    fs.writeFileSync(filePath, bytes)
    t.mock.method(console, 'error', () => {})
    t.mock.method(fs, 'copyFileSync', () => { throw new Error('backup denied') })
    assert.throws(() => initAccountStore(root), /Could not create backup.*Refusing to start/)
    assert.deepEqual(fs.readFileSync(filePath), bytes)
  })

  it('creates a missing file normally', () => {
    const store = initAccountStore(root)
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    assert.equal(data.version, 1)
    assert.equal(data.tokenSecret, store.getTokenSecret())
    assert.deepEqual(data.users, [])
    assert.deepEqual(data.invites, [])
    assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['accounts.json'])
  })

  it('ignores a stale temp file and loads the original accounts and secret', async() => {
    const store = initAccountStore(root)
    const user = await store.createUser({ username: 'survivor', password: 'test-password' })
    const original = fs.readFileSync(filePath)
    const stalePath = `${filePath}.tmp-123-crashed`
    fs.writeFileSync(stalePath, '{"users":[')

    const reloaded = initAccountStore(root)
    assert.equal(reloaded.findManagedUserById(user.id)?.username, 'survivor')
    assert.equal(reloaded.getTokenSecret(), store.getTokenSecret())
    assert.deepEqual(fs.readFileSync(filePath), original)
    assert.equal(fs.readFileSync(stalePath, 'utf-8'), '{"users":[')
  })
})
