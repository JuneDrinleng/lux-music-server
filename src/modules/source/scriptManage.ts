import fs from 'node:fs'
import path from 'node:path'
import { checkAndCreateDirSync } from '@/utils'
import { ONLINE_SOURCES, SCRIPT_ACTIONS, SCRIPT_QUALITYS, SOURCE_LIMITS } from './protocol'
import { parseScriptMeta, scriptIdFromContent, sha256Hex, type ScriptMetaFields } from './scriptMeta'

export interface SourceScriptIndexEntry {
  id: string
  name: string
  description: string
  version: string
  author: string
  homepage: string
  enabled: boolean
  priority: number
  sha256: string
  size: number
  createdAt: number
  updatedAt: number
}

export interface SourceScriptView extends Omit<SourceScriptIndexEntry, 'sha256'> {
  status: 'disabled' | 'initializing' | 'ready' | 'error'
  error: string | null
  sources: Partial<Record<LX.OnlineSource, LX.Sync.Source.Capability>>
  updateAlert: { log: string, updateUrl?: string } | null
}

interface IndexFile {
  version: 1
  scripts: SourceScriptIndexEntry[]
}

const sourcesRoot = () => path.join(global.lx.dataPath, 'lux', 'sources')
const indexPath = () => path.join(sourcesRoot(), 'index.json')
const scriptPath = (id: string) => path.join(sourcesRoot(), `${id}.js`)

const writeAtomic = (filePath: string, data: unknown) => {
  const dir = path.dirname(filePath)
  checkAndCreateDirSync(dir)
  const tmp = `${filePath}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, JSON.stringify(data))
    fs.fsyncSync(fd)
  } catch (err) {
    fs.closeSync(fd)
    fs.rmSync(tmp, { force: true })
    throw err
  }
  fs.closeSync(fd)
  fs.renameSync(tmp, filePath)
  try {
    const dirFd = fs.openSync(dir, 'r')
    fs.fsyncSync(dirFd)
    fs.closeSync(dirFd)
  } catch {
    // best effort
  }
}

const readIndex = (): IndexFile => {
  const file = indexPath()
  if (!fs.existsSync(file)) return { version: 1, scripts: [] }
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as IndexFile
  if (data.version != 1 || !Array.isArray(data.scripts)) throw new Error('invalid sources index')
  return data
}

const saveIndex = (scripts: SourceScriptIndexEntry[]) => {
  writeAtomic(indexPath(), { version: 1, scripts })
}

export const getSourcesDir = () => sourcesRoot()

export const readScriptContent = (id: string) => {
  const p = scriptPath(id)
  if (!fs.existsSync(p)) return null
  return fs.readFileSync(p, 'utf8')
}

export const listScriptEntries = (): SourceScriptIndexEntry[] => {
  const index = readIndex()
  return [...index.scripts].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
}

export const findScriptEntry = (id: string) => listScriptEntries().find(s => s.id == id) ?? null

export const upsertScript = (script: string): SourceScriptIndexEntry => {
  if (script.length > SOURCE_LIMITS.scriptChars) throw new Error('script exceeds size limit')
  const meta = parseScriptMeta(script)
  const id = scriptIdFromContent(script)
  const hash = sha256Hex(script)
  const now = Date.now()
  const index = readIndex()
  const existing = index.scripts.find(s => s.id == id)
  checkAndCreateDirSync(sourcesRoot())
  fs.writeFileSync(scriptPath(id), script, 'utf8')

  const entry: SourceScriptIndexEntry = existing
    ? {
        ...existing,
        ...meta,
        sha256: hash,
        size: script.length,
        updatedAt: now,
      }
    : {
        id,
        ...meta,
        enabled: false,
        priority: index.scripts.length,
        sha256: hash,
        size: script.length,
        createdAt: now,
        updatedAt: now,
      }

  const scripts = existing
    ? index.scripts.map(s => s.id == id ? entry : s)
    : [...index.scripts, entry]
  saveIndex(scripts)
  return entry
}

export const setScriptEnabled = (id: string, enabled: boolean) => {
  const index = readIndex()
  const scripts = index.scripts.map(s => s.id == id ? { ...s, enabled, updatedAt: Date.now() } : s)
  if (!scripts.some(s => s.id == id)) throw new Error('script not found')
  saveIndex(scripts)
  return scripts.find(s => s.id == id)!
}

export const reorderScripts = (ids: string[]) => {
  const index = readIndex()
  const byId = new Map(index.scripts.map(s => [s.id, s]))
  if (ids.length != byId.size || ids.some(id => !byId.has(id))) throw new Error('ids must list every script exactly once')
  const now = Date.now()
  const scripts = ids.map((id, priority) => ({ ...byId.get(id)!, priority, updatedAt: now }))
  saveIndex(scripts)
  return scripts
}

export const deleteScript = (id: string) => {
  const index = readIndex()
  if (!index.scripts.some(s => s.id == id)) return false
  saveIndex(index.scripts.filter(s => s.id != id))
  fs.rmSync(scriptPath(id), { force: true })
  return true
}

export const normalizeInitedSources = (raw: unknown): Partial<Record<LX.OnlineSource, LX.Sync.Source.Capability>> => {
  if (!raw || typeof raw != 'object' || Array.isArray(raw)) throw new Error('invalid inited payload')
  const sourcesRootObj = (raw as { sources?: unknown }).sources
  if (!sourcesRootObj || typeof sourcesRootObj != 'object' || Array.isArray(sourcesRootObj)) {
    throw new Error('invalid inited sources')
  }
  const out: Partial<Record<LX.OnlineSource, LX.Sync.Source.Capability>> = {}
  for (const source of ONLINE_SOURCES) {
    const userSource = (sourcesRootObj as Record<string, unknown>)[source]
    if (!userSource || typeof userSource != 'object' || Array.isArray(userSource)) continue
    if ((userSource as { type?: unknown }).type != 'music') continue
    const actionsRaw = (userSource as { actions?: unknown }).actions
    const qualitysRaw = (userSource as { qualitys?: unknown }).qualitys
    if (!Array.isArray(actionsRaw) || !Array.isArray(qualitysRaw)) continue
    const actions = SCRIPT_ACTIONS.filter(a => actionsRaw.includes(a))
    const qualitys = SCRIPT_QUALITYS.filter(q => qualitysRaw.includes(q))
    if (!actions.length || !qualitys.length) continue
    out[source] = { actions, qualitys }
  }
  if (!Object.keys(out).length) throw new Error('no supported sources declared')
  return out
}

export const entryToBaseView = (entry: SourceScriptIndexEntry): SourceScriptView => ({
  ...entry,
  status: entry.enabled ? 'initializing' : 'disabled',
  error: null,
  sources: {},
  updateAlert: null,
})

export type { ScriptMetaFields }
