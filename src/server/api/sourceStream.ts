import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { openSafeRequest } from '@/modules/source/httpClient'
import { verifyStreamToken } from '@/modules/source/streamToken'
import { getSourceSettings } from '@/modules/source/config'

const forwardHeader = (req: FastifyRequest, name: string) => {
  const value = req.headers[name.toLowerCase()]
  if (value == null) return undefined
  return Array.isArray(value) ? value.join(', ') : value
}

export const registerSourceStreamApi = async(app: FastifyInstance) => {
  app.get('/api/source/stream/*', async(request, reply) => {
    if (!getSourceSettings().proxyStream) return reply.code(404).send({ message: 'stream proxy disabled' })
    const token = (request.params as { '*': string })['*']
    const verified = verifyStreamToken(token)
    if (!verified) {
      const dot = token.lastIndexOf('.')
      if (dot <= 0) return reply.code(403).send({ message: 'invalid token' })
      try {
        const payload = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8')) as { e?: number }
        if (typeof payload.e == 'number' && payload.e <= Date.now()) return reply.code(410).send({ message: 'token expired' })
      } catch {
        // fall through
      }
      return reply.code(403).send({ message: 'invalid token' })
    }
    const range = forwardHeader(request, 'range')
    const headers: Record<string, string> = {}
    if (range) headers.Range = range
    let upstream
    try {
      upstream = await openSafeRequest(verified.url, {
        method: 'GET',
        headers,
        timeoutMs: 60_000,
        headersTimeoutOnly: true,
      })
    } catch (err) {
      return reply.code(502).send({ message: err instanceof Error ? err.message : 'upstream failed' })
    }
    return pipeStream(reply, upstream)
  })
}

const pipeStream = (reply: FastifyReply, upstream: Awaited<ReturnType<typeof openSafeRequest>>) => {
  const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges'] as const
  for (const name of pass) {
    const value = upstream.headers[name]
    if (value != null) reply.header(name, value)
  }
  void reply.code(upstream.statusCode).send(upstream.stream)
  upstream.stream.on('close', () => upstream.close())
  upstream.stream.on('error', () => upstream.close())
}
