import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const entrypoint = path.resolve(__dirname, '../docker-entrypoint.sh')

describe('Docker entrypoint', () => {
  const run = (uid: string, needsRepair = false, chownFails = false) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lux-entrypoint-test-'))
    const log = path.join(root, 'commands')
    const mock = (name: string, script: string) => {
      fs.writeFileSync(path.join(root, name), `#!/bin/sh\nset -eu\nprintf '%s\\n' "${name} $*" >> "$ENTRYPOINT_TEST_LOG"\n${script}\n`, { mode: 0o755 })
    }
    try {
      mock('command', "printf '<%s>\\n' \"$@\"")
      mock('id', 'echo "$ENTRYPOINT_TEST_UID"')
      mock('mkdir', ':')
      mock('find', '[ "$ENTRYPOINT_TEST_REPAIR" = false ] || echo /server/data/data/lux/accounts.json')
      mock('chown', '[ "$ENTRYPOINT_TEST_FAIL" = false ]')
      mock('su-exec', 'test "$1" = node\nshift\nexec "$@"')
      const result = spawnSync('sh', [entrypoint, path.join(root, 'command'), 'argument with spaces', '*'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH ?? ''}`,
          ENTRYPOINT_TEST_LOG: log,
          ENTRYPOINT_TEST_UID: uid,
          ENTRYPOINT_TEST_REPAIR: String(needsRepair),
          ENTRYPOINT_TEST_FAIL: String(chownFails),
          DATA_PATH: '/outside/data',
          LOG_PATH: '/outside/logs',
        },
      })
      return { ...result, commands: fs.readFileSync(log, 'utf8').trim().split('\n') }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  for (const needsRepair of [false, true]) {
    it(`drops root to node with ${needsRepair ? 'mixed/root-owned' : 'node-owned'} data`, () => {
      const result = run('0', needsRepair)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, '<argument with spaces>\n<*>\n')
      assert.deepEqual(result.commands.slice(0, 3), [
        'id -u',
        'mkdir -p /server/data',
        'find /server/data ( ! -user node -o ! -group node ) -print -quit',
      ])
      assert.deepEqual(result.commands.filter(line => line.startsWith('chown ')),
        needsRepair ? ['chown -Rh node:node /server/data'] : [])
      assert.match(result.commands.at(-2) ?? '', /^su-exec node /)
    })
  }

  it('honors --user by executing directly without ownership changes', () => {
    const result = run('1234', true)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.commands, ['id -u', 'command argument with spaces *'])
    assert.equal(result.stdout, '<argument with spaces>\n<*>\n')
  })

  it('does not start the server if ownership repair fails', () => {
    const result = run('0', true, true)
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    assert.equal(result.commands.some(line => line.startsWith('su-exec ')), false)
  })
})
