// 这个文件导出的方法将暴露给客户端调用，第一个参数固定为当前 socket 对象
// import { getUserSpace } from '@/user'
import { FeaturesList } from '@/constants'
import { modules, playHistoryModule, togetherModule } from '@/modules'
import { getRoomManager } from '@/modules/together/roomManage'
import { isSocketOpen } from '../socketState'

type FeatureName = keyof LX.Socket['moduleReadys']
const featureChanges = new WeakMap<LX.Socket, Partial<Record<FeatureName, object>>>()

const handler: LX.Sync.ServerSyncHandlerActions<LX.Socket> = {
  async onFeatureChanged(socket, feature) {
    if (!isSocketOpen(socket)) throw new Error('disconnected')
    const changes = featureChanges.get(socket) ?? {}
    featureChanges.set(socket, changes)
    const pending: Array<() => Promise<void>> = []
    const schedule = (name: FeatureName, enabled: boolean, sync: (socket: LX.Socket) => Promise<void>) => {
      const change = {}
      changes[name] = change
      socket.moduleReadys[name] = false
      if (!enabled) return
      pending.push(async() => {
        if (!isSocketOpen(socket)) throw new Error('disconnected')
        // A newer feature change supersedes work suspended behind another module's sync.
        if (changes[name] !== change) return
        await sync(socket).catch(_ => _)
        if (!isSocketOpen(socket)) {
          socket.moduleReadys[name] = false
          throw new Error('disconnected')
        }
        if (!socket.feature[name]) socket.moduleReadys[name] = false
      })
    }

    // Apply disables immediately, even when another module's resync is still awaiting its client.
    for (const name of FeaturesList) {
      const newStatus = feature[name]
      if (newStatus == null) continue
      socket.feature[name] = newStatus
      schedule(name, !!newStatus, modules[name].sync)
    }
    if (feature.playHistory != null) {
      socket.feature.playHistory = !!feature.playHistory
      schedule('playHistory', !!feature.playHistory, playHistoryModule.sync)
    }
    if (feature.together != null) {
      socket.feature.together = !!feature.together
      schedule('together', !!feature.together, togetherModule.sync)
      if (!feature.together) getRoomManager().handleSocketDisabled(socket)
    }
    if (feature['together.reaction'] != null) socket.feature['together.reaction'] = !!feature['together.reaction']
    for (const run of pending) await run()
  },
}

export default handler
