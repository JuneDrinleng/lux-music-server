// 这个文件导出的方法将暴露给客户端调用，第一个参数固定为当前 socket 对象
import { getRoomManager } from '../roomManage'

const requireEnabled = (socket: LX.Socket) => {
  if (!socket.moduleReadys?.together) throw new Error('together is not enabled')
}

type TogetherHandler = WarpSyncHandlerActions<LX.Socket, LX.Sync.ServerSyncTogetherActions>

const handler: TogetherHandler = {
  async 'together:createRoom'(socket) {
    requireEnabled(socket)
    return getRoomManager().createRoom(socket)
  },
  async 'together:joinRoom'(socket, req) {
    requireEnabled(socket)
    return getRoomManager().joinRoom(socket, req)
  },
  async 'together:getRoom'(socket) {
    requireEnabled(socket)
    return getRoomManager().getRoom(socket)
  },
  async 'together:leaveRoom'(socket, req) {
    requireEnabled(socket)
    return getRoomManager().leaveRoom(socket, req)
  },
  async 'together:closeRoom'(socket, req) {
    requireEnabled(socket)
    return getRoomManager().closeRoom(socket, req)
  },
  async 'together:hostUpdateState'(socket, req) {
    requireEnabled(socket)
    return getRoomManager().hostUpdateState(socket, req)
  },
  async 'together:hostUpdateQueue'(socket, req) {
    requireEnabled(socket)
    return getRoomManager().hostUpdateQueue(socket, req)
  },
  async 'together:transferHost'(socket, req) {
    requireEnabled(socket)
    return getRoomManager().transferHost(socket, req)
  },
  async 'together:ping'(socket, req) {
    requireEnabled(socket)
    return getRoomManager().ping(req)
  },
}

export default handler
