import log4js from 'log4js'
import { clearUrlSourceCache } from './cache'
import { getSourceSettings } from './config'
import {
  deleteScript,
  entryToBaseView,
  findScriptEntry,
  listScriptEntries,
  persistScriptLastError,
  readScriptContent,
  reorderScripts,
  setScriptEnabled,
  upsertScript,
  type SourceScriptView,
} from './scriptManage'
import { ScriptSandboxHost } from './sandbox'
import { SOURCE_ON_INFO_CHANGED } from './protocol'
import { resetScriptPriorityCache } from './priority'

const logger = log4js.getLogger('source')

let wss: LX.SocketServer | null = null
const hosts = new Map<string, ScriptSandboxHost>()

const notifyChanged = () => {
  void broadcastSourceInfo(getSourceInfo())
}

export const registerSourceWss = (server: LX.SocketServer) => {
  wss = server
}

export const getScriptViews = (): SourceScriptView[] => {
  return listScriptEntries().map(entry => {
    const host = hosts.get(entry.id)
    return host ? host.view : entryToBaseView(entry)
  })
}

export const mergeSourceCapabilities = (): Partial<Record<LX.OnlineSource, LX.Sync.Source.Capability>> => {
  const merged: Partial<Record<LX.OnlineSource, { actions: Set<LX.Sync.Source.Action>, qualitys: Set<LX.Quality> }>> = {}
  for (const host of hosts.values()) {
    if (host.view.status != 'ready') continue
    for (const [source, cap] of Object.entries(host.view.sources) as Array<[LX.OnlineSource, LX.Sync.Source.Capability]>) {
      if (!cap) continue
      const bucket = merged[source] ?? { actions: new Set(), qualitys: new Set() }
      for (const action of cap.actions) bucket.actions.add(action)
      for (const q of cap.qualitys) bucket.qualitys.add(q)
      merged[source] = bucket
    }
  }
  const out: Partial<Record<LX.OnlineSource, LX.Sync.Source.Capability>> = {}
  for (const [source, bucket] of Object.entries(merged) as Array<[LX.OnlineSource, { actions: Set<LX.Sync.Source.Action>, qualitys: Set<LX.Quality> }]>) {
    out[source] = { actions: [...bucket.actions], qualitys: [...bucket.qualitys] }
  }
  return out
}

export const getSourceInfo = (): LX.Sync.Source.Info => {
  const settings = getSourceSettings()
  const sources = mergeSourceCapabilities()
  const available = Object.keys(sources).length > 0
  return {
    available,
    sources,
    proxyStream: settings.proxyStream,
    updatedAt: Date.now(),
  }
}

export const broadcastSourceInfo = (info: LX.Sync.Source.Info) => {
  if (!wss) return
  for (const client of wss.clients) {
    if (!client.moduleReadys?.source || !client.isReady) continue
    void (client.remote as unknown as LX.Sync.ClientSyncSourceActions)[SOURCE_ON_INFO_CHANGED](info).catch(() => {})
  }
}

export const initSourceRegistry = async() => {
  for (const entry of listScriptEntries()) {
    if (!entry.enabled) continue
    try {
      await enableScript(entry.id)
    } catch (err) {
      logger.warn(`failed to start enabled script ${entry.id}:`, err)
    }
  }
  notifyChanged()
}

export const uploadScript = async(script: string) => {
  const entry = upsertScript(script)
  resetScriptPriorityCache()
  clearUrlSourceCache()
  notifyChanged()
  return getScriptViews().find(s => s.id == entry.id)!
}

export const enableScript = async(id: string) => {
  const entry = findScriptEntry(id)
  if (!entry) throw new Error('script not found')
  const script = readScriptContent(id)
  if (!script) throw new Error('script file missing')
  await disableScript(id, false)
  setScriptEnabled(id, true)
  const base = entryToBaseView({ ...entry, enabled: true })
  const host = new ScriptSandboxHost(id, script, base, () => {
    persistScriptLastError(id, host.view.status, host.view.error)
    notifyChanged()
  })
  hosts.set(id, host)
  try {
    await host.start()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    host.view.status = 'error'
    host.view.error = message
    notifyChanged()
    return host.view
  }
  clearUrlSourceCache()
  notifyChanged()
  return host.view
}

export const disableScript = async(id: string, persist = true) => {
  const host = hosts.get(id)
  if (host) {
    await host.stop(persist)
    hosts.delete(id)
  }
  if (persist) {
    if (!findScriptEntry(id)) throw new Error('script not found')
    setScriptEnabled(id, false)
    clearUrlSourceCache()
    notifyChanged()
  }
  return getScriptViews().find(s => s.id == id) ?? entryToBaseView(findScriptEntry(id)!)
}

export const removeScript = async(id: string) => {
  await disableScript(id, false)
  if (!deleteScript(id)) throw new Error('script not found')
  clearUrlSourceCache()
  notifyChanged()
}

export const orderScripts = (ids: string[]) => {
  reorderScripts(ids)
  resetScriptPriorityCache()
  clearUrlSourceCache()
  notifyChanged()
  return getScriptViews()
}

export const getReadyHosts = () => [...hosts.values()].filter(h => h.view.status == 'ready')

export const getHost = (id: string) => hosts.get(id) ?? null

export const onSocketClose = (socket: LX.Socket) => {
  // resolver registers per-socket abort; registry has nothing to do here yet
  void socket
}

export const resetSourceRegistryForTests = async() => {
  for (const id of [...hosts.keys()]) await disableScript(id, false)
  hosts.clear()
  wss = null
}
