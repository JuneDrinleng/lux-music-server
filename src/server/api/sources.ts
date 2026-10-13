import type { FastifyInstance } from 'fastify'
import { safeRequest } from '@/modules/source/httpClient'
import { SOURCE_LIMITS } from '@/modules/source/protocol'
import { getSourceSettings } from '@/modules/source/config'
import {
  enableScript,
  disableScript,
  getScriptViews,
  getSourceInfo,
  orderScripts,
  removeScript,
  uploadScript,
} from '@/modules/source'
import { testScriptAction } from '@/modules/source/resolver'
import { parseMusicInfoOnline, parseQuality } from '@/modules/source/validate'
import { requireAdmin } from './authGuard'
import { decodeScriptBase64, getOptionalString, getRawString, getString, isRecord } from './utils'

const SCRIPT_BODY_LIMIT = SOURCE_LIMITS.scriptChars * 2 + 65536

const readScriptPayload = (body: Record<string, unknown>) => {
  const fromBase64 = decodeScriptBase64(body.scriptBase64)
  if (fromBase64 != null) {
    if (getRawString(body.script)) throw new Error('provide either script or scriptBase64, not both')
    return fromBase64
  }
  return getRawString(body.script)
}

export const registerSourcesAdminApi = async(app: FastifyInstance) => {
  app.get('/api/admin/sources', { preHandler: requireAdmin }, async() => {
    const settings = getSourceSettings()
    return {
      scripts: getScriptViews(),
      info: getSourceInfo(),
      settings: {
        timeoutMs: settings.timeoutMs,
        memoryMb: settings.memoryMb,
        proxyStream: settings.proxyStream,
      },
    }
  })

  app.post('/api/admin/sources', { preHandler: requireAdmin, bodyLimit: SCRIPT_BODY_LIMIT }, async(request, reply) => {
    if (!isRecord(request.body)) return reply.code(400).send({ message: 'Invalid body' })
    let script: string
    try {
      script = readScriptPayload(request.body)
    } catch (err) {
      return reply.code(400).send({ message: err instanceof Error ? err.message : 'Invalid script payload' })
    }
    const url = getOptionalString(request.body.url)
    if (!script && url) {
      try {
        const fetched = await safeRequest(url, { timeoutMs: 10_000, maxBytes: SOURCE_LIMITS.scriptChars })
        if (fetched.statusCode >= 400) return reply.code(422).send({ message: `download failed: ${fetched.statusCode}` })
        script = fetched.body.toString('utf8')
      } catch (err) {
        return reply.code(422).send({ message: err instanceof Error ? err.message : 'download failed' })
      }
    }
    if (!script && !url) return reply.code(400).send({ message: 'script, scriptBase64, or url is required' })
    if (!script) return reply.code(400).send({ message: 'script or url is required' })
    try {
      const entry = await uploadScript(script)
      return { script: entry }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid script'
      return reply.code(422).send({ message, code: 'INVALID_SCRIPT' })
    }
  })

  app.post('/api/admin/sources/:id/enable', { preHandler: requireAdmin }, async(request, reply) => {
    const id = (request.params as { id?: string }).id
    if (!id) return reply.code(400).send({ message: 'Missing script id' })
    try {
      const script = await enableScript(id)
      return { script }
    } catch (err) {
      return reply.code(404).send({ message: err instanceof Error ? err.message : 'script not found' })
    }
  })

  app.post('/api/admin/sources/:id/disable', { preHandler: requireAdmin }, async(request, reply) => {
    const id = (request.params as { id?: string }).id
    if (!id) return reply.code(400).send({ message: 'Missing script id' })
    try {
      const script = await disableScript(id)
      return { script }
    } catch (err) {
      return reply.code(404).send({ message: err instanceof Error ? err.message : 'script not found' })
    }
  })

  app.put('/api/admin/sources/order', { preHandler: requireAdmin }, async(request, reply) => {
    if (!isRecord(request.body) || !Array.isArray(request.body.ids)) return reply.code(400).send({ message: 'Invalid body' })
    const ids = request.body.ids.map(v => (typeof v == 'string' ? v.trim() : '')).filter(Boolean)
    try {
      return { scripts: orderScripts(ids) }
    } catch (err) {
      return reply.code(400).send({ message: err instanceof Error ? err.message : 'invalid order' })
    }
  })

  app.delete('/api/admin/sources/:id', { preHandler: requireAdmin }, async(request, reply) => {
    const id = (request.params as { id?: string }).id
    if (!id) return reply.code(400).send({ message: 'Missing script id' })
    try {
      await removeScript(id)
      return { ok: true }
    } catch (err) {
      return reply.code(404).send({ message: err instanceof Error ? err.message : 'script not found' })
    }
  })

  app.post('/api/admin/sources/:id/test', { preHandler: requireAdmin }, async(request, reply) => {
    if (!isRecord(request.body)) return reply.code(400).send({ message: 'Invalid body' })
    const id = (request.params as { id?: string }).id
    const action = getString(request.body.action) as LX.Sync.Source.Action
    if (!id) return reply.code(400).send({ message: 'Missing script id' })
    if (action != 'musicUrl' && action != 'lyric' && action != 'pic') return reply.code(400).send({ message: 'Invalid action' })
    try {
      const musicInfo = parseMusicInfoOnline(request.body.musicInfo)
      const quality = request.body.quality != null ? parseQuality(request.body.quality) : undefined
      const result = await testScriptAction(id, action, musicInfo, quality)
      return result
    } catch (err) {
      return reply.code(400).send({ message: err instanceof Error ? err.message : 'invalid test payload' })
    }
  })
}
