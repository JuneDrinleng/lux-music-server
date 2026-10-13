type TogetherRemote = LX.Sync.ClientSyncTogetherActions

export interface BroadcastTarget {
  members: Map<string, { socket: LX.Socket | null }>
}

export const getTogetherRemote = (socket: LX.Socket) => socket.remote as unknown as TogetherRemote

/** Fire-and-forget: a slow or dead member must never block the room. */
export const sendToSocket = (socket: LX.Socket | null, fn: (remote: TogetherRemote) => Promise<unknown>) => {
  if (!socket) return
  try {
    void fn(getTogetherRemote(socket)).catch(() => {})
  } catch {}
}

/**
 * Pushes to the sockets stored in the room's member table, not `wss.clients`:
 * rooms span users, while `socket.broadcast` callers filter by user.
 */
export const broadcastRoom = (
  room: BroadcastTarget,
  fn: (remote: TogetherRemote, memberId: string) => Promise<unknown>,
  exceptMemberId?: string,
) => {
  for (const [memberId, member] of room.members) {
    if (memberId == exceptMemberId) continue
    sendToSocket(member.socket, remote => fn(remote, memberId))
  }
}
