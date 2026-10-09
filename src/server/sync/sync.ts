import { FeaturesList } from '@/constants'
import { featureVersion, modules, playHistoryModule } from '@/modules'


export const sync = async(socket: LX.Socket) => {
  let disconnected = false
  socket.onClose(() => {
    disconnected = true
  })
  const enabledFeatures = await socket.remote.getEnabledFeatures('server', featureVersion)

  if (disconnected) throw new Error('disconnected')
  for (const moduleName of FeaturesList) {
    if (enabledFeatures[moduleName]) {
      socket.feature[moduleName] = enabledFeatures[moduleName]
      await modules[moduleName].sync(socket).catch(_ => _)
    }
    if (disconnected) throw new Error('disconnected')
  }
  // Optional Lux feature. Omitted by legacy LX clients, so their sync path stops above.
  if (enabledFeatures.playHistory) {
    socket.feature.playHistory = true
    await playHistoryModule.sync(socket).catch(_ => _)
  }
  if (disconnected) throw new Error('disconnected')
  await socket.remote.finished()
}
