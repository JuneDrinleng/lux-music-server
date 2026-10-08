import { SYNC_CLOSE_CODE } from '@/constants'
import { syncLog } from '@/utils/log4js'

/**
 * LX Music sync protocol (message2call) has no client-facing "sync status / error"
 * RPC that stock clients implement. Closing with SYNC_CLOSE_CODE.failed is the
 * compatible signal; clients treat it as a disconnect and may reconnect.
 *
 * Do not invent new remote methods here — unknown RPCs break older clients.
 */
export const handleSyncBroadcastFailure = (
  client: LX.Socket,
  module: 'list' | 'dislike',
  err: unknown,
) => {
  const message = err instanceof Error ? err.message : String(err)
  const userName = client.userInfo?.name ?? '(unknown)'
  const deviceName = client.keyInfo?.deviceName ?? '(unknown)'
  const clientId = client.keyInfo?.clientId ?? '(unknown)'
  syncLog.warn(
    `[sync] ${module} broadcast failed; closing client for reconnect. ` +
    `user=${userName} device=${deviceName} clientId=${clientId} error=${message}`,
  )
  try {
    client.moduleReadys[module] = false
  } catch {}
  client.close(SYNC_CLOSE_CODE.failed)
}
