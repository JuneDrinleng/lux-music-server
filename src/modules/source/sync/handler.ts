import {
  SOURCE_GET_INFO,
  SOURCE_RESOLVE_LYRIC,
  SOURCE_RESOLVE_MUSIC_URL,
  SOURCE_RESOLVE_PIC,
} from '../protocol'
import { getSourceInfo } from '../registry'
import { resolveLyric, resolveMusicUrl, resolvePic } from '../resolver'

const requireEnabled = (socket: LX.Socket) => {
  if (!socket.moduleReadys?.source) throw new Error('source is not enabled')
}

const handler: LX.Sync.ServerSyncHandlerSourceActions<LX.Socket> = {
  async [SOURCE_GET_INFO](socket) {
    requireEnabled(socket)
    return { ok: true, data: getSourceInfo() }
  },
  async [SOURCE_RESOLVE_MUSIC_URL](socket, req) {
    requireEnabled(socket)
    return await resolveMusicUrl(socket, req)
  },
  async [SOURCE_RESOLVE_LYRIC](socket, req) {
    requireEnabled(socket)
    return await resolveLyric(socket, req)
  },
  async [SOURCE_RESOLVE_PIC](socket, req) {
    requireEnabled(socket)
    return await resolvePic(socket, req)
  },
}

export default handler
