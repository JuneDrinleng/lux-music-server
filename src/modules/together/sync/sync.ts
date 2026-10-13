import { getRoomManager } from '../roomManage'

const closeRegistered = new WeakSet<LX.Socket>()

/** Marks the feature ready and, inside the grace period, rebinds this socket to its room membership. */
export const sync = async(socket: LX.Socket) => {
  socket.moduleReadys.together = true
  if (!closeRegistered.has(socket)) {
    closeRegistered.add(socket)
    socket.onClose(() => {
      getRoomManager().handleSocketClosed(socket)
    })
  }
  getRoomManager().handleSocketReady(socket)
}
