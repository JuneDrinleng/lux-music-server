import { featureVersion } from '@/modules'
import { isSocketOpen } from '../socketState'
import handler from './handler'


export const sync = async(socket: LX.Socket) => {
  if (!isSocketOpen(socket)) throw new Error('disconnected')
  const enabledFeatures = await socket.remote.getEnabledFeatures('server', featureVersion)
  await handler.onFeatureChanged(socket, enabledFeatures)
  if (!isSocketOpen(socket)) throw new Error('disconnected')
  await socket.remote.finished()
}
