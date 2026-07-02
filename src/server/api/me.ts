import type { FastifyInstance } from 'fastify'
import { getAccountStore } from '@/account/store'
import { getUserSpace } from '@/user'
import { getRequiredAuthUser, requireAuth, type AuthRequest } from './authGuard'
import { getString, isRecord } from './utils'

const buildPlaylistSummary = async(username: string) => {
  const listData = await getUserSpace(username).listManage.getListData()
  return {
    defaultList: {
      id: 'default',
      name: '默认列表',
      musicCount: listData.defaultList.length,
    },
    loveList: {
      id: 'love',
      name: '我喜欢',
      musicCount: listData.loveList.length,
    },
    userList: listData.userList.map(list => ({
      id: list.id,
      name: list.name,
      source: list.source,
      sourceListId: list.sourceListId,
      locationUpdateTime: list.locationUpdateTime,
      musicCount: list.list.length,
    })),
  }
}

export const registerMeApi = async(app: FastifyInstance) => {
  app.get('/api/me/devices', { preHandler: requireAuth }, async(request: AuthRequest) => {
    const user = getRequiredAuthUser(request)
    return { devices: await getUserSpace(user.username).getDecices() }
  })

  app.delete('/api/me/devices/:clientId', { preHandler: requireAuth }, async(request: AuthRequest) => {
    const user = getRequiredAuthUser(request)
    const clientId = (request.params as { clientId?: string }).clientId
    if (!clientId) return { ok: false }
    await getUserSpace(user.username).removeDevice(clientId)
    return { ok: true }
  })

  app.get('/api/me/playlists', { preHandler: requireAuth }, async(request: AuthRequest) => {
    const user = getRequiredAuthUser(request)
    return { playlists: await buildPlaylistSummary(user.username) }
  })

  app.post('/api/me/password', { preHandler: requireAuth }, async(request: AuthRequest, reply) => {
    if (!isRecord(request.body)) return reply.code(400).send({ message: 'Invalid body' })
    const password = getString(request.body.password)
    if (!password) return reply.code(400).send({ message: 'Missing password' })
    const user = getRequiredAuthUser(request)
    await getAccountStore().changePassword(user.id, password)
    return { ok: true }
  })

  app.get('/api/me/sync-code', { preHandler: requireAuth }, async(request: AuthRequest, reply) => {
    const user = getRequiredAuthUser(request)
    const syncCode = getAccountStore().getSyncCode(user.id)
    reply.header('Cache-Control', 'no-store')
    return { syncCode }
  })

  app.post('/api/me/sync-code/reset', { preHandler: requireAuth }, async(request: AuthRequest) => {
    const user = getRequiredAuthUser(request)
    const syncCode = getAccountStore().resetSyncCode(user.id)
    return { syncCode }
  })
}
