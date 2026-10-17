import { WebSocket } from 'ws'

/** CLOSING sockets must not resume feature sync or replace a live room connection. */
export const isSocketOpen = (socket: LX.Socket) => socket.readyState === WebSocket.OPEN
