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

const webDir = path.join(__dirname, 'web')

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
    const html = await fs.readFile(path.join(webDir, 'index.html'), 'utf-8')
    void reply.type('text/html; charset=utf-8').send(html)
  })

  app.get('/admin/:file', async(request, reply) => {
    const file = (request.params as { file?: string }).file
    if (file != 'app.js' && file != 'style.css') return reply.code(404).send('Not Found')
    const data = await fs.readFile(path.join(webDir, file), 'utf-8')
    void reply.type(file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8').send(data)
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
