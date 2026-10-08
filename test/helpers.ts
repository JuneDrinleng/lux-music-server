import fs from 'node:fs'
import path from 'node:path'
import { initAccountStore } from '../src/account/store'
import { createApp } from '../src/server/app'
import { resetAuthRateLimitForTests } from '../src/server/api/rateLimit'
import { initLogger } from '../src/utils/log4js'
import store from '../src/utils/cache'

let loggerReady = false

export const resetTestState = () => {
  const root = (global as typeof globalThis & { __LUX_TEST_ROOT__?: string }).__LUX_TEST_ROOT__
  if (!root) throw new Error('test register did not initialize __LUX_TEST_ROOT__')
  const luxDir = path.join(global.lx.dataPath, 'lux')
  fs.rmSync(luxDir, { recursive: true, force: true })
  global.lx.config.users = []
  resetAuthRateLimitForTests()
  store.clear()
  delete process.env.LUX_BOOTSTRAP_TOKEN
  delete process.env.LUX_TOKEN_SECRET
  delete process.env.LUX_ADMIN_USER
  delete process.env.LUX_ADMIN_PASSWORD
  delete process.env.LUX_LOG_SYNC_CODES
  if (!loggerReady) {
    initLogger()
    loggerReady = true
  }
  initAccountStore(global.lx.dataPath)
  return createApp()
}

export const parseJson = (payload: string) => JSON.parse(payload || '{}') as Record<string, any>
