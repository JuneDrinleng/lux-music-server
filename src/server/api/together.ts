import type { FastifyInstance } from 'fastify'
import { getRoomManager } from '@/modules/together'
import { requireAdmin } from './authGuard'

/** Read-only: no invite codes or member details leave the process, and rooms can only be created by the app. */
export const registerTogetherApi = async(app: FastifyInstance) => {
  app.get('/api/admin/together/rooms', { preHandler: requireAdmin }, async() => getRoomManager().getStats())
}
