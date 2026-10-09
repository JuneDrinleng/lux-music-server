import type { FastifyInstance } from 'fastify'
import { getUserSpace } from '@/user'
import { getRequiredAuthUser, requireAuth, type AuthRequest } from './authGuard'
import { getString, isRecord } from './utils'

export const registerSyncApi = async(app: FastifyInstance) => {
  app.post('/api/sync/key', { preHandler: requireAuth }, async(request: AuthRequest, reply) => {
    if (!isRecord(request.body)) return reply.code(400).send({ message: 'Invalid body' })
    const user = getRequiredAuthUser(request)
    // Never truncate identifiers: that could collapse two distinct installations.
    for (const field of ['deviceId', 'clientId'] as const) {
      const value = request.body[field]
      if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 256)) {
        return reply.code(400).send({ message: `Invalid ${field}` })
      }
    }
    const deviceName = getString(request.body.deviceName) || undefined
    const platform = getString(request.body.platform)
    let keyInfo: LX.Sync.KeyInfo
    try {
      keyInfo = getUserSpace(user.username).dataManage.upsertClientKeyInfo({
        deviceId: getString(request.body.deviceId) || undefined,
        clientId: getString(request.body.clientId) || undefined,
        deviceName,
        isMobile: platform ? platform.toLowerCase().includes('mobile') : undefined,
      })
    } catch (err) {
      if (err instanceof Error && err.message == 'Conflicting device identity') {
        return reply.code(409).send({ message: err.message })
      }
      throw err
    }
    reply.header('Cache-Control', 'no-store')
    return {
      clientId: keyInfo.clientId,
      key: keyInfo.key,
      serverName: global.lx.config.serverName,
      deviceName: keyInfo.deviceName,
    }
  })
}
