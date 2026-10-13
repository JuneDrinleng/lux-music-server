import { bindSocketAbort } from '../resolver'

/** Marks the feature ready; cancels in-flight resolves when the socket closes. */
export const sync = async(socket: LX.Socket) => {
  socket.moduleReadys.source = true
  const unbind = bindSocketAbort(socket)
  socket.onClose(() => {
    unbind()
  })
}
