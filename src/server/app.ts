import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { type FastifyInstance, type FastifyReply, type FastifyRequest, fastify } from 'fastify'
import { SYNC_CODE } from '@/constants'
import { getServerId } from '@/user'
import { authCode } from './auth'
import { getAccountStore } from '@/account/store'
import { registerSyncKeyRevocation } from './server'
import { registerAdminApi } from './api/admin'
import { registerAuthApi } from './api/auth'
import { registerMeApi } from './api/me'
import { registerPatApi } from './api/pats'
import { registerSyncApi } from './api/sync'
import { registerTogetherApi } from './api/together'
import { sendError } from './api/errors'
import { parsePublicUrl, parseTrustProxy } from './proxyConfig'

const readServerPackageVersion = () => {
  try {
    const pkgPath = path.join(__dirname, '../../package.json')
    const pkg = JSON.parse(fsSync.readFileSync(pkgPath, 'utf8')) as { version?: unknown }
    return typeof pkg.version == 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

const SERVER_PACKAGE_VERSION = readServerPackageVersion()

const builtAdminDir = path.resolve(__dirname, '../../admin-ui/dist')
const webDir = process.env.NODE_ENV == 'production' || !fsSync.existsSync(builtAdminDir)
  ? path.join(__dirname, 'web')
  : builtAdminDir

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

const getAdminAssetPath = (requestPath = '') => {
  const cleanPath = requestPath.replace(/^\/+/, '') || 'index.html'
  const filePath = path.normalize(path.join(webDir, cleanPath))
  const relativePath = path.relative(webDir, filePath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null
  return filePath
}

const sendAdminIndex = async(reply: FastifyReply) => {
  const html = await fs.readFile(path.join(webDir, 'index.html'))
  void reply.header('Cache-Control', 'no-cache').type(mimeTypes['.html']).send(html)
}

const sendAdminAsset = async(reply: FastifyReply, requestPath: string) => {
  const filePath = getAdminAssetPath(requestPath)
  if (!filePath) return reply.code(404).send('Not Found')
  try {
    const data = await fs.readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    if (requestPath.startsWith('assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    else reply.header('Cache-Control', 'no-cache')
    void reply.type(mimeTypes[ext] || 'application/octet-stream').send(data)
  } catch {
    return reply.code(404).send('Not Found')
  }
}

const sendText = (reply: FastifyReply, code: number, text: string) => {
  void reply.code(code).type('text/plain; charset=utf-8').send(text)
}

/** Match profile avatar cap (200KB) plus room for other JSON fields. */
export const API_BODY_LIMIT = 256 * 1024

export const createApp = (): FastifyInstance => {
  registerSyncKeyRevocation(getAccountStore())
  const publicUrl = parsePublicUrl(process.env.LUX_PUBLIC_URL)
  const app = fastify({
    logger: false,
    bodyLimit: API_BODY_LIMIT,
    trustProxy: parseTrustProxy(process.env.LUX_TRUST_PROXY),
  })

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? 500
    const message = error.message || 'Internal Server Error'
    if (request.url.startsWith('/api/')) {
      void sendError(reply, statusCode, error.code || (statusCode >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST'), message)
      return
    }
    void reply.code(statusCode).type('text/plain; charset=utf-8').send(message)
  })

  app.get('/hello', async(_request, reply) => {
    sendText(reply, 200, SYNC_CODE.helloMsg)
  })

  app.get('/id', async(_request, reply) => {
    sendText(reply, 200, SYNC_CODE.idPrefix + getServerId())
  })

  app.get('/ah', async(request: FastifyRequest, reply: FastifyReply) => {
    reply.hijack()
    await authCode(request.raw, reply.raw, lx.config.users)
  })

  app.get('/api/server-info', async(_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return {
      name: lx.config.serverName,
      version: process.env.LUX_VERSION?.trim() || SERVER_PACKAGE_VERSION,
      packageVersion: SERVER_PACKAGE_VERSION,
      minClientVersion: process.env.LUX_MIN_CLIENT_VERSION?.trim() || null,
      publicUrl,
      mcp: { tokens: true },
      ...(publicUrl ? { mcpUrl: `${publicUrl}/mcp` } : {}),
      registration: { inviteOnly: true, enabled: true },
      features: ['sessions', 'refresh', 'me-sessions', 'invite-check'],
    }
  })

  app.get('/api/health', async() => ({
    ok: true,
    serverName: lx.config.serverName,
    version: SERVER_PACKAGE_VERSION,
    gitCommit: process.env.LUX_BUILD_GIT_COMMIT ?? process.env.GITHUB_SHA ?? null,
  }))

  app.get('/admin', async(_request, reply) => {
    await sendAdminIndex(reply)
  })

  app.get('/admin/', async(_request, reply) => {
    await sendAdminIndex(reply)
  })

  app.get('/admin/*', async(request, reply) => {
    const assetPath = (request.params as { '*': string })['*']
    await sendAdminAsset(reply, assetPath)
  })

  void app.register(registerAuthApi)
  void app.register(registerMeApi)
  void app.register(registerPatApi)
  void app.register(registerAdminApi)
  void app.register(registerSyncApi)
  void app.register(registerTogetherApi)

  app.setNotFoundHandler(async(request, reply) => {
    if (request.url.startsWith('/api/')) {
      return sendError(reply, 404, 'NOT_FOUND', 'API route not found')
    }
    sendText(reply, 401, 'Forbidden')
  })

  return app
}
