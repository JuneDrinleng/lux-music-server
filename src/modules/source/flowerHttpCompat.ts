/**
 * 野花 / flower-source-info scripts expect the legacy 97.x JSON envelope `{ code, data: { vinfo } }`.
 * npm registry returns `{ vinfo }` at the top level; datacenter IPs often get HTTP 403 from 97.x.
 */

const FLOWER_INFO_PATH = /\/flower-source-info\/latest\/?$/i

const NPM_FLOWER_INFO = 'https://registry.npmjs.org/flower-source-info/latest'
const NPM_MIRROR_FLOWER_INFO = 'https://registry.npmmirror.com/flower-source-info/latest'

export const isFlowerSourceInfoRequest = (rawUrl: string): boolean => {
  try {
    return FLOWER_INFO_PATH.test(new URL(rawUrl).pathname)
  } catch {
    return rawUrl.includes('flower-source-info/latest')
  }
}

/** Prefer npm mirror first (often faster in CN); fall back to registry.npmjs.org. */
export const flowerSourceInfoFetchUrls = (): [string, string] => [NPM_MIRROR_FLOWER_INFO, NPM_FLOWER_INFO]

export const rewriteFlowerSourceInfoRequest = (rawUrl: string): string | null => {
  if (!isFlowerSourceInfoRequest(rawUrl)) return null
  return NPM_MIRROR_FLOWER_INFO
}

export const wrapFlowerRegistryBody = (npmJson: Buffer): Buffer => {
  const parsed = JSON.parse(npmJson.toString('utf8')) as { vinfo?: Record<string, unknown> }
  if (!parsed.vinfo || typeof parsed.vinfo != 'object') throw new Error('flower-source-info: missing vinfo')
  const vinfo = parsed.vinfo as Record<string, unknown>
  const envelope = {
    code: 200,
    data: {
      vinfo,
      lv: typeof vinfo.lv == 'string' ? vinfo.lv : undefined,
      lu: typeof vinfo.lu == 'string' ? vinfo.lu : '',
      lh: typeof vinfo.lh == 'string' ? vinfo.lh : '',
    },
  }
  return Buffer.from(JSON.stringify(envelope))
}

export const formatHttpFailure = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err)
  const extra = err as Error & { code?: string, errno?: number, syscall?: string, hostname?: string }
  const parts = [err.message]
  if (extra.code) parts.push(`code=${extra.code}`)
  if (extra.errno != null) parts.push(`errno=${extra.errno}`)
  if (extra.syscall) parts.push(`syscall=${extra.syscall}`)
  if (extra.hostname) parts.push(`host=${extra.hostname}`)
  return parts.join(' ')
}
