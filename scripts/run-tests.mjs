// npm test 入口。始终跑版本脚本测试；PR #1 的服务端测试在 test/register.cjs 落地后自动加入。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)
}

run(['--test', 'scripts/next-version.test.mjs', 'scripts/image-tags.test.mjs'])
if (fs.existsSync(path.join(root, 'test/register.cjs'))) {
  run(['--test', '--require', './test/register.cjs', 'test/**/*.test.ts'])
}
