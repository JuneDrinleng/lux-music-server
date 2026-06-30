import type { FastifyInstance } from 'fastify'
import { createClientKeyInfo, getUserSpace, setUserName } from '@/user'
import { getRequiredAuthUser, requireAuth, type AuthRequest } from './authGuard'
import { getString, isRecord } from './utils'

export const registerSyncApi = async(app: FastifyInstance) => {
  app.post('/api/sync/key', { preHandler: requireAuth }, async(request: AuthRequest, reply) => {
    if (!isRecord(request.body)) return reply.code(400).send({ message: 'Invalid body' })
    const user = getRequiredAuthUser(request)
    const deviceName = getString(request.body.deviceName) || 'Unknown'
    const platform = getString(request.body.platform)
    const keyInfo = createClientKeyInfo(deviceName, platform ? platform.toLowerCase().includes('mobile') : true)
    getUserSpace(user.username).dataManage.saveClientKeyInfo(keyInfo)
    setUserName(keyInfo.clientId, user.username)
    return {
      clientId: keyInfo.clientId,
      key: keyInfo.key,
      serverName: global.lx.config.serverName,
      deviceName: keyInfo.deviceName,
    }
  })
}
