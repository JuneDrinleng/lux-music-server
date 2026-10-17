import { isIP } from 'node:net'

export const parseTrustProxy = (value?: string): boolean | number | string[] => {
  const input = value?.trim() || ''
  if (!input || /^(0|false)$/i.test(input)) return false
  if (/^(1|true)$/i.test(input)) return true
  if (/^\d+$/.test(input) && Number.isSafeInteger(Number(input))) return Number(input)
  const addresses = input.split(',').map(address => address.trim())
  if (addresses.every(address => {
    const [ip, prefix, extra] = address.split('/')
    const family = isIP(ip)
    return family && extra === undefined && (prefix === undefined || (
      /^\d+$/.test(prefix) && Number(prefix) <= (family == 4 ? 32 : 128)
    ))
  })) return addresses
  console.warn('[lux-music-server] Invalid LUX_TRUST_PROXY; ignoring (proxy trust disabled).')
  return false
}

export const parsePublicUrl = (value?: string): string | null => {
  if (!value) return null
  try {
    const url = new URL(value)
    if (value == value.trim() && /^https?:\/\//i.test(value) && url.hostname &&
      !url.username && !url.password && !url.search && !url.hash && !value.endsWith('/')) return value
  } catch {}
  console.warn('[lux-music-server] Invalid LUX_PUBLIC_URL; expected an HTTP(S) base URL without a trailing slash; ignoring.')
  return null
}
