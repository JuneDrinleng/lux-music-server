'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

require('ts-node').register({
  transpileOnly: true,
  compilerOptions: {
    module: 'commonjs',
    moduleResolution: 'node',
    esModuleInterop: true,
  },
})
require('tsconfig-paths').register({
  baseUrl: path.join(__dirname, '../src'),
  paths: { '@/*': ['./*'] },
})

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lux-server-test-'))
const dataPath = path.join(root, 'data')
const userPath = path.join(dataPath, 'users')
const logPath = path.join(root, 'logs')
fs.mkdirSync(userPath, { recursive: true })
fs.mkdirSync(logPath, { recursive: true })

// Must exist before any module that reads global.lx at import time (user/data.ts).
global.lx = {
  logPath,
  dataPath,
  userPath,
  config: {
    serverName: 'Test Sync Server',
    'proxy.enabled': false,
    'proxy.header': 'x-real-ip',
    maxSnapshotNum: 10,
    'list.addMusicLocationType': 'top',
    users: [],
  },
}

global.__LUX_TEST_ROOT__ = root
