import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { type Readable } from 'node:stream'
import zlib from 'node:zlib'

export class BlockedAddressError extends Error {
  constructor(address: string) {
    super(`address not allowed: ${address}`)
    this.name = 'BlockedAddressError'
  }
}

let allowLoopback = false
/** Tests talk to a local HTTP server; production never enables this. */
export const setAllowLoopbackForTests = (allow: boolean) => {
  allowLoopback = allow
}

const ipv4ToInt = (ip: string) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0
const inV4Range = (ip: string, base: string, bits: number) => {
  const mask = bits == 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipv4ToInt(ip) & mask) == (ipv4ToInt(base) & mask)
}

/** Loopback, link-local and the unspecified address (which Linux routes to localhost). Private ranges stay allowed. */
export const isBlockedIp = (address: string): boolean => {
  let ip = address.replace(/^\[|\]$/g, '').toLowerCase()
  const zone = ip.indexOf('%')
  if (zone >= 0) ip = ip.slice(0, zone)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (mapped) ip = mapped[1]
  if (net.isIPv4(ip)) {
    if (allowLoopback && inV4Range(ip, '127.0.0.0', 8)) return false
    return inV4Range(ip, '127.0.0.0', 8) || inV4Range(ip, '169.254.0.0', 16) || inV4Range(ip, '0.0.0.0', 8)
  }
  if (net.isIPv6(ip)) {
    if (ip == '::1') return !allowLoopback
    if (ip == '::') return true
    const first = parseInt(ip.split(':')[0] || '0', 16)
    return (first & 0xffc0) == 0xfe80
  }
  return false
}

const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 4)
      return
    }
    const list = addresses as dns.LookupAddress[]
    const blocked = list.find(item => isBlockedIp(item.address))
    if (blocked || !list.length) {
      callback(new BlockedAddressError(blocked ? blocked.address : hostname), '', 4)
      return
    }
    if ((options as dns.LookupOptions).all) {
      (callback as unknown as (err: null, addresses: dns.LookupAddress[]) => void)(null, list)
    } else {
      callback(null, list[0].address, list[0].family)
    }
  })
}

export interface SafeRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer
  timeoutMs: number
  signal?: AbortSignal
  maxRedirects?: number
  /** Only bound the wait for response headers (long-lived streams). */
  headersTimeoutOnly?: boolean
}

export interface SafeResponse {
  url: string
  statusCode: number
  statusMessage: string
  headers: http.IncomingHttpHeaders
  stream: http.IncomingMessage
  /** Aborts the underlying request and clears the timeout. */
  close: () => void
}

const assertAllowedUrl = (rawUrl: string) => {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('invalid url')
  }
  if (url.protocol != 'http:' && url.protocol != 'https:') throw new Error(`protocol not allowed: ${url.protocol}`)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host) && isBlockedIp(host)) throw new BlockedAddressError(host)
  return url
}

/**
 * Opens an http(s) request whose resolved IPs are checked after DNS (no rebinding window).
 * Redirects are followed manually so each hop is checked too.
 */
export const openSafeRequest = async(rawUrl: string, options: SafeRequestOptions): Promise<SafeResponse> => {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) throw new Error('aborted')
    options.signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  const close = () => {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    controller.abort()
  }

  let currentUrl = rawUrl
  let method = (options.method ?? 'GET').toUpperCase()
  let body = options.body
  const headers = { ...options.headers }
  const maxRedirects = options.maxRedirects ?? 5

  try {
    for (let hop = 0; ; hop++) {
      const url = assertAllowedUrl(currentUrl)
      const transport = url.protocol == 'https:' ? https : http
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = transport.request(url, {
          method,
          headers: body != null ? { ...headers, 'Content-Length': String(Buffer.byteLength(body)) } : headers,
          lookup: safeLookup,
          signal: controller.signal,
        }, resolve)
        req.on('error', err => {
          reject(controller.signal.aborted && !(err instanceof BlockedAddressError) ? new Error(options.signal?.aborted ? 'aborted' : 'timeout') : err)
        })
        if (body != null) req.write(body)
        req.end()
      })
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && status != 304 && location) {
        res.resume()
        if (hop >= maxRedirects) throw new Error('too many redirects')
        currentUrl = new URL(location, url).toString()
        if (status == 303 || ((status == 301 || status == 302) && method != 'GET' && method != 'HEAD')) {
          method = 'GET'
          body = undefined
          for (const key of Object.keys(headers)) {
            if (key.toLowerCase() == 'content-type') delete headers[key]
          }
        }
        continue
      }
      if (options.headersTimeoutOnly) clearTimeout(timer)
      else res.on('close', () => clearTimeout(timer))
      return {
        url: currentUrl,
        statusCode: status,
        statusMessage: res.statusMessage ?? '',
        headers: res.headers,
        stream: res,
        close,
      }
    }
  } catch (err) {
    close()
    throw err
  }
}

const decode = (res: http.IncomingMessage): Readable => {
  const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase()
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return res.pipe(zlib.createGunzip())
    case 'deflate':
      return res.pipe(zlib.createInflate())
    case 'br':
      return res.pipe(zlib.createBrotliDecompress())
    default:
      return res
  }
}

export interface BufferedResponse {
  url: string
  statusCode: number
  statusMessage: string
  headers: Record<string, string>
  body: Buffer
}

/** Reads the full (decoded) body; aborts once it exceeds maxBytes. */
export const safeRequest = async(rawUrl: string, options: SafeRequestOptions & { maxBytes: number }): Promise<BufferedResponse> => {
  const res = await openSafeRequest(rawUrl, options)
  try {
    const stream = decode(res.stream)
    const chunks: Buffer[] = []
    let size = 0
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > options.maxBytes) {
          reject(new Error(`response body exceeds ${options.maxBytes} bytes`))
          res.close()
          return
        }
        chunks.push(chunk)
      })
      stream.on('end', resolve)
      stream.on('error', reject)
      res.stream.on('error', reject)
      res.stream.on('aborted', () => reject(new Error('aborted')))
    })
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(res.headers)) {
      if (value == null) continue
      headers[key] = Array.isArray(value) ? value.join(', ') : value
    }
    return { url: res.url, statusCode: res.statusCode, statusMessage: res.statusMessage, headers, body: Buffer.concat(chunks) }
  } finally {
    res.close()
  }
}
