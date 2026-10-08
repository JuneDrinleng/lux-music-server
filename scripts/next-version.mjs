// 用法：node scripts/next-version.mjs <dev|master>
// 结果写入 $GITHUB_OUTPUT（本地则只打印）。键：skip、version、tag、prerelease、prev_tag。
//
// master：版本 = package.json（必须是 X.Y.Z）。对应 tag 已存在 → skip（不覆盖）。
//         tag 不存在、且版本不大于最新稳定 tag → 失败。
// dev：  版本 = 最新稳定 tag 的下一个 minor + "-dev.N"（N 自动递增，最大 98）。
//         HEAD 已有 dev tag，或代码树与最新稳定 tag 相同 → skip。
// 只认 git tag：vX.Y.Z 与 vX.Y.Z-dev.N。package.json 在 dev 上保持最近的稳定版，不写回开发版号。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const branch = process.argv[2]
const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', ...opts })
const parse = raw => {
  const text = String(raw).trim()
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/.exec(text)
  if (!m) return null
  return {
    t: text.startsWith('v') ? text : `v${text}`,
    M: +m[1],
    m: +m[2],
    p: +m[3],
    n: m[4] ? +m[4] : null,
  }
}
const cmp = (a, b) => a.M - b.M || a.m - b.m || a.p - b.p || (a.n ?? 1e9) - (b.n ?? 1e9) // dev.N < 同号正式版
const sameTree = tag => {
  try {
    git(['diff', '--quiet', tag, 'HEAD'], { stdio: 'ignore' })
    return true
  } catch (err) {
    if (err && err.status === 1) return false
    throw err
  }
}

const tags = git(['tag', '-l', 'v*']).split('\n').map(s => s.trim()).filter(Boolean)
const all = tags.map(raw => {
  const parsed = parse(raw)
  if (!parsed) return null
  parsed.t = raw
  return parsed
}).filter(Boolean).sort(cmp)
const stables = all.filter(x => x.n === null)
const lastStable = stables.at(-1) ?? parse('v0.0.0')
const out = { skip: 'false', version: '', tag: '', prerelease: 'false', prev_tag: all.at(-1)?.t ?? '' }

if (branch === 'master') {
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`master 的版本必须是 X.Y.Z：${version}`)
  Object.assign(out, { version, tag: `v${version}`, prerelease: 'false', prev_tag: stables.at(-1)?.t ?? '' })
  if (tags.includes(out.tag)) out.skip = 'true'
  else if (cmp(parse(version), lastStable) <= 0) throw new Error(`${version} 不大于已发布稳定版 ${lastStable.t}`)
} else if (branch === 'dev') {
  const headTags = git(['tag', '--points-at', 'HEAD']).split('\n').map(s => s.trim()).filter(Boolean)
  const sameAsStable = stables.length > 0 && sameTree(lastStable.t)
  if (sameAsStable || headTags.some(t => /-dev\.\d+$/.test(t))) {
    out.skip = 'true'
    out.prerelease = 'true'
  } else {
    let target = parse(`${lastStable.M}.${lastStable.m + 1}.0`)
    if (fs.existsSync('.github/dev-target')) {
      const raw = fs.readFileSync('.github/dev-target', 'utf8').trim()
      const picked = raw ? parse(raw) : null
      if (!raw) {
        // 空文件视为没指定
      } else if (!picked || picked.n !== null) {
        console.error(`忽略 .github/dev-target（需要 X.Y.Z）：${raw}`)
      } else if (cmp(picked, target) > 0) {
        target = picked
      } else {
        console.error(`忽略 .github/dev-target（不高于下一个 minor ${target.M}.${target.m}.${target.p}）：${raw}`)
      }
    }
    const base = `${target.M}.${target.m}.${target.p}`
    const n = Math.max(0, ...all.filter(x => x.n !== null && `${x.M}.${x.m}.${x.p}` === base).map(x => x.n)) + 1
    if (n > 98) throw new Error(`${base}-dev.N 已到上限 98，请先转正`)
    Object.assign(out, { version: `${base}-dev.${n}`, tag: `v${base}-dev.${n}`, prerelease: 'true' })
  }
} else {
  throw new Error(`未知分支：${branch}（只接受 dev 或 master）`)
}

const text = Object.entries(out).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, text)
process.stdout.write(text)
