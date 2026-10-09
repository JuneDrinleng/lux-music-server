// 这个文件导出的方法将暴露给客户端调用，第一个参数固定为当前 socket 对象
import { getUserSpace } from '@/user'
import { PLAY_HISTORY_PULL, PLAY_HISTORY_PUSH } from '../protocol'

const requireEnabled = (socket: LX.Socket) => {
  if (!socket.moduleReadys?.playHistory) throw new Error('playHistory is not enabled')
}

const handler: LX.Sync.ServerSyncHandlerPlayHistoryActions<LX.Socket> = {
  async [PLAY_HISTORY_PUSH](socket, payload) {
    requireEnabled(socket)
    return await getUserSpace(socket.userInfo.name).playHistoryManage.push(payload)
  },
  async [PLAY_HISTORY_PULL](socket, payload) {
    requireEnabled(socket)
    return await getUserSpace(socket.userInfo.name).playHistoryManage.pull(payload)
  },
}

export default handler
