import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { type FastifyInstance, type FastifyReply, type FastifyRequest, fastify } from 'fastify'
import { SYNC_CODE } from '@/constants'
import { getServerId } from '@/user'
import { authCode } from './auth'
import { registerAdminApi } from './api/admin'
import { registerAuthApi } from './api/auth'
import { registerMeApi } from './api/me'
import { registerSyncApi } from './api/sync'

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

export const createApp = (): FastifyInstance => {
  const app = fastify({
    logger: false,
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

  app.get('/api/health', async() => ({
    ok: true,
    serverName: lx.config.serverName,
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
  void app.register(registerAdminApi)
  void app.register(registerSyncApi)

  app.setNotFoundHandler(async(_request, reply) => {
    sendText(reply, 401, 'Forbidden')
  })

  return app
}
