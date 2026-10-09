/** Client pulls and pushes history itself. This only marks the feature ready. */
export const sync = async(socket: LX.Socket) => {
  socket.moduleReadys.playHistory = true
}
