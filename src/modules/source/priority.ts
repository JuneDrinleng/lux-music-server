import { listScriptEntries } from './scriptManage'

let cachedPriority: Map<string, number> | null = null

export const scriptPriority = (id: string) => {
  if (!cachedPriority) cachedPriority = new Map(listScriptEntries().map(e => [e.id, e.priority]))
  return cachedPriority.get(id) ?? 999
}

export const resetScriptPriorityCache = () => {
  cachedPriority = null
}
