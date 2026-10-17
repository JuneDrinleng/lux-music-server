import { isSocketOpen } from '@/server/socketState'
import { syncLog } from '@/utils/log4js'
import { getRoomManager } from '../roomManage'

const closeRegistered = new WeakSet<LX.Socket>()
const syncAttempts = new WeakMap<LX.Socket, object>()

/** Marks the feature ready and, inside the grace period, rebinds this socket to its room membership. */
export const sync = async(socket: LX.Socket) => {
  if (!isSocketOpen(socket)) throw new Error('disconnected')
  if (!socket.feature.together) return
  const attempt = {}
  syncAttempts.set(socket, attempt)
  if (!closeRegistered.has(socket)) {
    closeRegistered.add(socket)
    socket.onClose(() => {
      syncAttempts.delete(socket)
      socket.moduleReadys.together = false
      getRoomManager().handleSocketClosed(socket)
    })
  }
  // Clients may use room RPCs before acknowledging this notification.
  socket.moduleReadys.together = true
  getRoomManager().handleSocketReady(socket)
  try {
    await socket.remote.together_sync_finished()
  } catch (error) {
    syncLog.warn(`together sync acknowledgement failed; user=${socket.userInfo.name} clientId=${socket.keyInfo.clientId}`, error)
    // A delayed failure from an older sync must not undo a newer successful sync.
    if (syncAttempts.get(socket) === attempt) {
      socket.moduleReadys.together = false
      getRoomManager().handleSocketDisabled(socket)
    }
    throw error
  }
}
