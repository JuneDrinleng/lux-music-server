// 用法：node scripts/image-tags.mjs <image> <version> <true|false>
// 每行一个完整镜像 tag。稳定版：:X.Y.Z、:latest、:X.Y。开发版：:X.Y.Z-dev.N、:dev。
// 开发版不会带 latest 或浮动 minor，避免覆盖稳定通道。
const [image, version, pre] = process.argv.slice(2)

if (!image || !/^[\w./-]+$/.test(image) || image !== image.toLowerCase()) {
  throw new Error(`镜像名必须是小写、且不含标签：${image}`)
}
if (pre !== 'true' && pre !== 'false') throw new Error('第三个参数必须是 true 或 false')
if (!/^\d+\.\d+\.\d+(-dev\.\d+)?$/.test(version ?? '')) throw new Error(`版本号不合法：${version}`)

const dev = /-dev\.\d+$/.test(version)
if (pre === 'true' && !dev) throw new Error(`开发版标记与版本号不一致：${version}`)
if (pre === 'false' && dev) throw new Error(`稳定版不能使用预发布版本号：${version}`)

const tags = [`${image}:${version}`]
if (pre === 'true') tags.push(`${image}:dev`)
else tags.push(`${image}:latest`, `${image}:${version.slice(0, version.lastIndexOf('.'))}`)

process.stdout.write(tags.join('\n') + '\n')
