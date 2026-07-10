import type { FastifyInstance, FastifyReply } from 'fastify'
import { getAccountStore } from '@/account/store'
import { getUserSpace } from '@/user'
import { getRequiredAuthUser, requireAuth, type AuthRequest } from './authGuard'
import { getString, isRecord } from './utils'

const getOptionalProfileString = (value: unknown, maxLength: number) => {
  if (typeof value !== 'string') return undefined
  const text = value.trim().substring(0, maxLength)
  return text || ''
}
const getGender = (value: unknown): 'male' | 'female' | 'unknown' | undefined => {
  if (typeof value != 'string') return undefined
  return value == 'male' || value == 'female' || value == 'unknown' ? value : undefined
}
const toProfile = (user: ReturnType<ReturnType<typeof getAccountStore>['findManagedUserById']>) => ({
  displayName: user?.displayName ?? '',
  avatar: user?.avatar ?? '',
  gender: user?.gender ?? 'unknown',
  signature: user?.signature ?? '',
})
const updateProfile = async(request: AuthRequest, reply: FastifyReply) => {
  if (!isRecord(request.body)) return reply.code(400).send({ message: 'Invalid body' })
  const user = getRequiredAuthUser(request)
  const updatedUser = getAccountStore().updateUser(user.id, {
    displayName: getOptionalProfileString(request.body.displayName, 100),
    avatar: getOptionalProfileString(request.body.avatar, 2 * 1024 * 1024),
    gender: getGender(request.body.gender),
    signature: getOptionalProfileString(request.body.signature, 140),
  })
  return { profile: toProfile(getAccountStore().findManagedUserById(updatedUser.id)) }
}

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
  app.get('/api/me/profile', { preHandler: requireAuth }, async(request: AuthRequest) => {
    const user = getRequiredAuthUser(request)
    return { profile: toProfile(user) }
  })

  app.post('/api/me/profile', { preHandler: requireAuth }, updateProfile)
  app.patch('/api/me/profile', { preHandler: requireAuth }, updateProfile)

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
