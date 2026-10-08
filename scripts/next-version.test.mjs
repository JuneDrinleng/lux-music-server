import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./next-version.mjs', import.meta.url))

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lux-ver-'))
  git(dir, ['init', '-b', 'master'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  return dir
}

function writeVersion(dir, version) {
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 't', version })}\n`)
}

function commitAll(dir, message = 'c') {
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', message])
}

function run(dir, branch, env = {}) {
  return spawnSync(process.execPath, [script, branch], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
}

function parseOut(stdout) {
  return Object.fromEntries(stdout.trim().split('\n').filter(Boolean).map(line => {
    const i = line.indexOf('=')
    return [line.slice(0, i), line.slice(i + 1)]
  }))
}

function expectOk(dir, branch, env) {
  const before = git(dir, ['tag', '-l']).trim()
  const statusBefore = git(dir, ['status', '--porcelain'])
  const result = run(dir, branch, env)
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.equal(git(dir, ['tag', '-l']).trim(), before, '脚本不能创建或删除 tag')
  assert.equal(git(dir, ['status', '--porcelain']), statusBefore, '脚本不能改工作区')
  return parseOut(result.stdout)
}

function expectFail(dir, branch) {
  const result = run(dir, branch)
  assert.notEqual(result.status, 0, result.stdout)
  return `${result.stdout}\n${result.stderr}`
}

test('合并引导改动进 master：v0.0.1 已存在则跳过，dev 分配 0.1.0-dev.1', () => {
  const dir = initRepo()
  writeVersion(dir, '0.0.1')
  commitAll(dir, 'init')
  git(dir, ['tag', 'v0.0.1'])
  fs.writeFileSync(path.join(dir, 'README.md'), 'pipeline\n')
  commitAll(dir, 'bootstrap')

  const master = expectOk(dir, 'master')
  assert.deepEqual(master, {
    skip: 'true',
    version: '0.0.1',
    tag: 'v0.0.1',
    prerelease: 'false',
    prev_tag: 'v0.0.1',
  })

  const dev = expectOk(dir, 'dev')
  assert.equal(dev.skip, 'false')
  assert.equal(dev.version, '0.1.0-dev.1')
  assert.equal(dev.tag, 'v0.1.0-dev.1')
  assert.equal(dev.prerelease, 'true')
  assert.equal(dev.prev_tag, 'v0.0.1')
})

test('dev 递增，且 0.10 不会被字符串排序成比 0.9 小', () => {
  const dir = initRepo()
  writeVersion(dir, '0.0.1')
  commitAll(dir, 'a')
  git(dir, ['tag', 'v0.0.1'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  commitAll(dir, 'b')
  git(dir, ['tag', 'v0.1.0-dev.2'])
  git(dir, ['tag', 'v0.1.0-dev.9'])
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n')
  commitAll(dir, 'c')

  const dev = expectOk(dir, 'dev')
  assert.equal(dev.version, '0.1.0-dev.10')
  assert.equal(dev.prev_tag, 'v0.1.0-dev.9')
})

test('同一 HEAD 已有 dev tag 时重跑跳过', () => {
  const dir = initRepo()
  writeVersion(dir, '0.0.1')
  commitAll(dir, 'a')
  git(dir, ['tag', 'v0.0.1'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  commitAll(dir, 'b')
  git(dir, ['tag', 'v0.1.0-dev.1'])

  const dev = expectOk(dir, 'dev')
  assert.equal(dev.skip, 'true')
  assert.equal(dev.prerelease, 'true')
})

test('代码树与最新稳定 tag 相同（空提交 / 回并后无改动）时跳过 dev', () => {
  const dir = initRepo()
  writeVersion(dir, '0.4.0')
  commitAll(dir, 'stable')
  git(dir, ['tag', 'v0.4.0'])
  git(dir, ['commit', '--allow-empty', '-m', 'empty'])

  const dev = expectOk(dir, 'dev')
  assert.equal(dev.skip, 'true')
})

test('master 未改版本且 tag 已在则跳过', () => {
  const dir = initRepo()
  writeVersion(dir, '0.4.0')
  commitAll(dir, 'stable')
  git(dir, ['tag', 'v0.4.0'])
  fs.writeFileSync(path.join(dir, 'docs.txt'), 'note\n')
  commitAll(dir, 'docs')

  const master = expectOk(dir, 'master')
  assert.equal(master.skip, 'true')
  assert.equal(master.tag, 'v0.4.0')
})

test('hotfix 只看 package.json：0.4.1，prev 是稳定版而不是更高的 dev tag', () => {
  const dir = initRepo()
  writeVersion(dir, '0.4.0')
  commitAll(dir, 'stable')
  git(dir, ['tag', 'v0.4.0'])
  git(dir, ['tag', 'v0.5.0-dev.3'])
  writeVersion(dir, '0.4.1')
  commitAll(dir, 'hotfix')

  const master = expectOk(dir, 'master')
  assert.equal(master.skip, 'false')
  assert.equal(master.version, '0.4.1')
  assert.equal(master.tag, 'v0.4.1')
  assert.equal(master.prerelease, 'false')
  assert.equal(master.prev_tag, 'v0.4.0')
})

test('hotfix 之后 dev 仍是下一个 minor，N 继续递增', () => {
  const dir = initRepo()
  writeVersion(dir, '0.4.1')
  commitAll(dir, 'a')
  git(dir, ['tag', 'v0.4.0'])
  git(dir, ['tag', 'v0.4.1'])
  git(dir, ['tag', 'v0.5.0-dev.1'])
  git(dir, ['tag', 'v0.5.0-dev.2'])
  fs.writeFileSync(path.join(dir, 'fix.txt'), 'x\n')
  commitAll(dir, 'more')

  const dev = expectOk(dir, 'dev')
  assert.equal(dev.version, '0.5.0-dev.3')
  assert.equal(dev.tag, 'v0.5.0-dev.3')
  assert.equal(dev.prev_tag, 'v0.5.0-dev.2')
})

test('转正后下一个 dev 切到 0.5.0-dev.1，prev 取正式版而不是旧 dev', () => {
  const dir = initRepo()
  writeVersion(dir, '0.4.0')
  commitAll(dir, 'a')
  git(dir, ['tag', 'v0.3.1'])
  git(dir, ['tag', 'v0.4.0-dev.9'])
  git(dir, ['tag', 'v0.4.0'])
  fs.writeFileSync(path.join(dir, 'next.txt'), 'x\n')
  commitAll(dir, 'after')

  const dev = expectOk(dir, 'dev')
  assert.equal(dev.version, '0.5.0-dev.1')
  assert.equal(dev.prev_tag, 'v0.4.0')
})

test('版本不大于已发布稳定版、且目标 tag 不存在时失败', () => {
  const dir = initRepo()
  writeVersion(dir, '0.4.0')
  commitAll(dir, 'a')
  git(dir, ['tag', 'v0.4.1'])

  const text = expectFail(dir, 'master')
  assert.match(text, /0\.4\.0 不大于已发布稳定版 v0\.4\.1/)
})

test('更旧的稳定版 tag 还在时跳过，不覆盖那个 tag', () => {
  const dir = initRepo()
  writeVersion(dir, '0.4.0')
  commitAll(dir, 'a')
  git(dir, ['tag', 'v0.4.0'])
  git(dir, ['tag', 'v0.4.1'])

  const master = expectOk(dir, 'master')
  assert.equal(master.skip, 'true')
  assert.equal(master.tag, 'v0.4.0')
})

test('master 的 package.json 带预发布号时失败', () => {
  const dir = initRepo()
  writeVersion(dir, '0.1.0-dev.1')
  commitAll(dir, 'a')
  const text = expectFail(dir, 'master')
  assert.match(text, /必须是 X\.Y\.Z/)
})

test('没有稳定 tag 时，master 发 0.0.1，dev 从 0.1.0-dev.1 起', () => {
  const dir = initRepo()
  writeVersion(dir, '0.0.1')
  commitAll(dir, 'a')

  const master = expectOk(dir, 'master')
  assert.equal(master.skip, 'false')
  assert.equal(master.version, '0.0.1')
  assert.equal(master.prev_tag, '')

  const dev = expectOk(dir, 'dev')
  assert.equal(dev.version, '0.1.0-dev.1')
  assert.equal(dev.prev_tag, '')
})

test('beta / archive tag 忽略；真正的 v2.1.2 tag 才会抬高稳定版', () => {
  const dir = initRepo()
  writeVersion(dir, '0.0.1')
  commitAll(dir, 'a')
  git(dir, ['tag', 'v0.0.1'])
  git(dir, ['tag', 'v0.2.9-beta'])
  git(dir, ['tag', 'archive/dev-before-dual-channel'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  commitAll(dir, 'b')
  assert.equal(expectOk(dir, 'dev').version, '0.1.0-dev.1')

  git(dir, ['tag', 'v2.1.2'])
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n')
  commitAll(dir, 'c')
  assert.equal(expectOk(dir, 'dev').version, '2.2.0-dev.1')
})

test('最新稳定版按数字比较，不按提交先后', () => {
  const dir = initRepo()
  writeVersion(dir, '0.2.0')
  commitAll(dir, 'a')
  git(dir, ['tag', 'v0.2.0'])
  writeVersion(dir, '0.10.0')
  commitAll(dir, 'b')
  git(dir, ['tag', 'v0.10.0'])
  writeVersion(dir, '0.9.0')
  commitAll(dir, 'c')
  git(dir, ['tag', 'v0.9.0'])
  fs.writeFileSync(path.join(dir, 'd.txt'), 'd\n')
  commitAll(dir, 'd')

  assert.equal(expectOk(dir, 'dev').version, '0.11.0-dev.1')
})

test('.github/dev-target 可以抬高目标，低于下一个 minor 或格式不对则忽略', () => {
  const dir = initRepo()
  writeVersion(dir, '0.0.1')
  commitAll(dir, 'a')
  git(dir, ['tag', 'v0.0.1'])
  fs.mkdirSync(path.join(dir, '.github'))
  fs.writeFileSync(path.join(dir, '.github/dev-target'), 'v1.0.0\n')
  commitAll(dir, 'target')
  assert.equal(expectOk(dir, 'dev').version, '1.0.0-dev.1')

  fs.writeFileSync(path.join(dir, '.github/dev-target'), '0.0.2\n')
  commitAll(dir, 'lower')
  const lower = run(dir, 'dev')
  assert.equal(lower.status, 0, lower.stderr)
  assert.match(lower.stderr, /忽略 \.github\/dev-target/)
  assert.equal(parseOut(lower.stdout).version, '0.1.0-dev.1')

  fs.writeFileSync(path.join(dir, '.github/dev-target'), 'nope\n')
  commitAll(dir, 'bad')
  assert.equal(expectOk(dir, 'dev').version, '0.1.0-dev.1')
})

test('dev.N 超过 98 失败', () => {
  const dir = initRepo()
  writeVersion(dir, '0.0.1')
  commitAll(dir, 'a')
  git(dir, ['tag', 'v0.0.1'])
  for (let n = 1; n <= 98; n++) git(dir, ['tag', `v0.1.0-dev.${n}`])
  fs.writeFileSync(path.join(dir, 'overflow.txt'), 'x\n')
  commitAll(dir, 'b')

  const text = expectFail(dir, 'dev')
  assert.match(text, /0\.1\.0-dev\.N 已到上限 98/)
})

test('不同目标版本的 dev.N 互不影响', () => {
  const dir = initRepo()
  writeVersion(dir, '0.4.0')
  commitAll(dir, 'a')
  git(dir, ['tag', 'v0.4.0'])
  git(dir, ['tag', 'v0.4.0-dev.7'])
  git(dir, ['tag', 'v0.5.0-dev.4'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  commitAll(dir, 'b')
  assert.equal(expectOk(dir, 'dev').version, '0.5.0-dev.5')
})

test('1.2.3 的下一个 dev 是 1.3.0-dev.1', () => {
  const dir = initRepo()
  writeVersion(dir, '1.2.3')
  commitAll(dir, 'a')
  git(dir, ['tag', 'v1.2.3'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  commitAll(dir, 'b')
  assert.equal(expectOk(dir, 'dev').version, '1.3.0-dev.1')
})

test('未知分支失败', () => {
  const dir = initRepo()
  writeVersion(dir, '0.0.1')
  commitAll(dir, 'a')
  const text = expectFail(dir, 'feature')
  assert.match(text, /未知分支/)
})

test('结果同时写入 GITHUB_OUTPUT', () => {
  const dir = initRepo()
  writeVersion(dir, '0.0.1')
  commitAll(dir, 'a')
  git(dir, ['tag', 'v0.0.1'])
  const outFile = path.join(os.tmpdir(), `lux-github-output-${process.pid}.txt`)
  const master = expectOk(dir, 'master', { GITHUB_OUTPUT: outFile })
  assert.equal(fs.readFileSync(outFile, 'utf8'), Object.entries(master).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
})
