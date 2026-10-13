import { modules } from '@/modules'
import { registerSourceWss } from '@/modules/source'

export const registerLocalSyncEvent = async(wss: LX.SocketServer) => {
  unregisterLocalSyncEvent()
  registerSourceWss(wss)
  for (const module of Object.values(modules)) {
    module.registerEvent(wss)
  }
}

export const unregisterLocalSyncEvent = () => {
  for (const module of Object.values(modules)) {
    module.unregisterEvent()
  }
}
