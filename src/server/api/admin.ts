import type { FastifyInstance } from 'fastify'
import { getAccountStore } from '@/account/store'
import { getUserSpace } from '@/user'
import { getServerStatus } from '../status'
import { getRequiredAuthUser, requireAdmin, type AuthRequest } from './authGuard'
import { getNumber, getOptionalString, getString, isRecord } from './utils'

const getRole = (value: unknown): 'admin' | 'user' | undefined => {
  if (typeof value != 'string') return undefined
  return value == 'admin' || value == 'user' ? value : undefined
}
const getStatusValue = (value: unknown): 'active' | 'disabled' | undefined => {
  if (typeof value != 'string') return undefined
  return value == 'active' || value == 'disabled' ? value : undefined
}
const getAddMusicLocationType = (value: unknown): LX.AddMusicLocationType | undefined => {
  if (typeof value != 'string') return undefined
  return value == 'top' || value == 'bottom' ? value : undefined
}
const getGender = (value: unknown): 'male' | 'female' | 'unknown' | undefined => {
  if (typeof value != 'string') return undefined
  return value == 'male' || value == 'female' || value == 'unknown' ? value : undefined
}

export const registerAdminApi = async(app: FastifyInstance) => {
  app.get('/api/admin/status', { preHandler: requireAdmin }, async() => ({
    status: getServerStatus(),
    users: getAccountStore().getUserViews().length,
    managedUsers: getAccountStore().getManagedUsers().length,
    invites: getAccountStore().getInvites().length,
  }))

  app.get('/api/admin/users', { preHandler: requireAdmin }, async() => ({
    users: getAccountStore().getUserViews(),
  }))

  app.post('/api/admin/users', { preHandler: requireAdmin }, async(request, reply) => {
    if (!isRecord(request.body)) return reply.code(400).send({ message: 'Invalid body' })
    const username = getString(request.body.username)
    const password = getString(request.body.password)
    const displayName = getOptionalString(request.body.displayName)
    const role = request.body.role == 'admin' ? 'admin' : 'user'
    if (!username || !password) return reply.code(400).send({ message: 'Missing required fields' })
    try {
      const user = await getAccountStore().createUser({ username, password, displayName, role })
      return { user }
    } catch (err: any) {
      return reply.code(400).send({ message: err.message })
    }
  })

  app.patch('/api/admin/users/:id', { preHandler: requireAdmin }, async(request, reply) => {
    if (!isRecord(request.body)) return reply.code(400).send({ message: 'Invalid body' })
    const id = (request.params as { id?: string }).id
    if (!id) return reply.code(400).send({ message: 'Missing user id' })
    try {
      const user = getAccountStore().updateUser(id, {
        displayName: getOptionalString(request.body.displayName),
        avatar: getOptionalString(request.body.avatar),
        gender: getGender(request.body.gender),
        signature: getOptionalString(request.body.signature),
        role: getRole(request.body.role),
        status: getStatusValue(request.body.status),
        maxSnapshotNum: getNumber(request.body.maxSnapshotNum),
        'list.addMusicLocationType': getAddMusicLocationType(request.body['list.addMusicLocationType']),
      })
      return { user }
    } catch (err: any) {
      return reply.code(404).send({ message: err.message })
    }
  })

  app.post('/api/admin/users/:id/password/reset', { preHandler: requireAdmin }, async(request, reply) => {
    if (!isRecord(request.body)) return reply.code(400).send({ message: 'Invalid body' })
    const id = (request.params as { id?: string }).id
    const password = getString(request.body.password)
    if (!id || !password) return reply.code(400).send({ message: 'Missing required fields' })
    try {
      const user = await getAccountStore().changePassword(id, password)
      return { user }
    } catch (err: any) {
      return reply.code(404).send({ message: err.message })
    }
  })

  app.get('/api/admin/users/:id/sync-code', { preHandler: requireAdmin }, async(request, reply) => {
    const id = (request.params as { id?: string }).id
    if (!id) return reply.code(400).send({ message: 'Missing user id' })
    try {
      const syncCode = getAccountStore().getSyncCode(id)
      reply.header('Cache-Control', 'no-store')
      return { syncCode }
    } catch (err: any) {
      return reply.code(404).send({ message: err.message })
    }
  })

  app.post('/api/admin/users/:id/sync-code/reset', { preHandler: requireAdmin }, async(request, reply) => {
    const id = (request.params as { id?: string }).id
    if (!id) return reply.code(400).send({ message: 'Missing user id' })
    try {
      const syncCode = getAccountStore().resetSyncCode(id)
      return { syncCode }
    } catch (err: any) {
      return reply.code(404).send({ message: err.message })
    }
  })

  app.get('/api/admin/users/:id/devices', { preHandler: requireAdmin }, async(request, reply) => {
    const id = (request.params as { id?: string }).id
    const user = id ? getAccountStore().findManagedUserById(id) : null
    if (!user) return reply.code(404).send({ message: 'User not found' })
    return { devices: await getUserSpace(user.username).getDecices() }
  })

  app.delete('/api/admin/users/:id/devices/:clientId', { preHandler: requireAdmin }, async(request, reply) => {
    const { id, clientId } = request.params as { id?: string, clientId?: string }
    const user = id ? getAccountStore().findManagedUserById(id) : null
    if (!user || !clientId) return reply.code(404).send({ message: 'User or device not found' })
    await getUserSpace(user.username).removeDevice(clientId)
    return { ok: true }
  })

  app.get('/api/admin/invites', { preHandler: requireAdmin }, async() => ({
    invites: getAccountStore().getInvites(),
  }))

  app.post('/api/admin/invites', { preHandler: requireAdmin }, async(request: AuthRequest, reply) => {
    if (!isRecord(request.body)) return reply.code(400).send({ message: 'Invalid body' })
    const user = getRequiredAuthUser(request)
    const maxUses = getNumber(request.body.maxUses) ?? 1
    const expiresAt = getNumber(request.body.expiresAt)
    const role = request.body.role == 'admin' ? 'admin' : 'user'
    const code = getOptionalString(request.body.code)
    const result = getAccountStore().createInvite({ code, role, maxUses, expiresAt, createdBy: user.id })
    return result
  })

  app.patch('/api/admin/invites/:id', { preHandler: requireAdmin }, async(request, reply) => {
    if (!isRecord(request.body)) return reply.code(400).send({ message: 'Invalid body' })
    const id = (request.params as { id?: string }).id
    if (!id) return reply.code(400).send({ message: 'Missing invite id' })
    try {
      const invite = getAccountStore().updateInvite(id, {
        disabled: typeof request.body.disabled == 'boolean' ? request.body.disabled : undefined,
        expiresAt: getNumber(request.body.expiresAt),
        maxUses: getNumber(request.body.maxUses),
        role: getRole(request.body.role),
      })
      return { invite }
    } catch (err: any) {
      return reply.code(404).send({ message: err.message })
    }
  })

  app.delete('/api/admin/invites/:id', { preHandler: requireAdmin }, async(request) => {
    const id = (request.params as { id?: string }).id
    return { ok: !!id && getAccountStore().deleteInvite(id) }
  })
}
