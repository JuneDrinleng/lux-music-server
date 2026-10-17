import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import * as server from '../src/server/server'
import * as logger from '../src/utils/log4js'

describe('startup logging', () => {
  for (const source of ['env', 'json env', 'config env', 'config users']) {
    it(`loads ${source} users without logging passwords with DEBUG=1`, t => {
      const originalEnv = process.env
      const originalLx = global.lx
      const root = fs.mkdtempSync(path.join(originalLx.dataPath, 'startup-'))
      const configPath = path.join(root, 'config.json')
      const password = 'secret'
      const config = source == 'config env'
        ? { 'env.LX_USER_a': password }
        : { users: source == 'config users' ? [{ name: 'a', password }] : [] }
      fs.writeFileSync(configPath, JSON.stringify(config))
      process.env = {
        ...Object.fromEntries(Object.entries(originalEnv).filter(([key]) => !key.startsWith('LX_USER_') && !key.startsWith('LUX_ADMIN_'))),
        DEBUG: '1',
        LUX_LOG_SYNC_CODES: '1',
        LUX_TOKEN_SECRET: 'token-value',
        CONFIG_PATH: configPath,
        DATA_PATH: path.join(root, 'data'),
        LOG_PATH: path.join(root, 'logs'),
      }
      if (source == 'env') process.env.LX_USER_a = password
      if (source == 'json env') process.env.LX_USER_a = JSON.stringify({ password })

      t.after(() => {
        process.env = originalEnv
        global.lx = originalLx
        delete require.cache[require.resolve('../src/index')]
        fs.rmSync(root, { recursive: true, force: true })
      })
      const logs: string[] = []
      t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(args.join(' ')) })
      t.mock.method(logger, 'initLogger', () => {})
      const start = t.mock.method(server, 'startServer', () => {})

      // Run the real startup path, stopping only the network listener and file logger.
      require('../src/index')

      const output = logs.join('\n')
      assert.equal(output.includes(password), false, output)
      assert.equal(output.includes('token-value'), false, output)
      assert.match(output, /Users:\n  .*: \*\*\*/)
      if (source == 'env' || source == 'json env') assert.match(output, /Load env:[\s\S]*LX_USER_a: \*\*\*/)
      if (source == 'config env') assert.match(output, /Load config file env:\n  LX_USER_a: \*\*\*/)
      assert.equal(global.lx.config.users.length, 1)
      assert.equal(global.lx.config.users[0].password, password)
      assert.equal(start.mock.callCount(), 1)
    })
  }
})
