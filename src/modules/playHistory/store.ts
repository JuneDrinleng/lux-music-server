import fs from 'node:fs'
import path from 'node:path'
import { checkAndCreateDirSync } from '@/utils'
import { File } from '@/constants'
import type { UserDataManage } from '@/user/data'
import { PLAY_HISTORY_LIMITS } from './protocol'
import { parsePullPayload, parsePushPayload, parseRecord } from './validate'

interface StoredRecord extends LX.Sync.PlayHistory.Record {
  receivedAt: number
}

interface PlayHistoryFile {
  version: 1
  cursor: number
  records: StoredRecord[]
}

const toPublic = (record: StoredRecord): LX.Sync.PlayHistory.Record => {
  const song: LX.Sync.PlayHistory.Song = {
    source: record.song.source,
    songmid: record.song.songmid,
    name: record.song.name,
    singer: record.song.singer,
  }
  if (record.song.albumName != null) song.albumName = record.song.albumName
  if (record.song.interval != null) song.interval = record.song.interval
  if (record.song.img != null) song.img = record.song.img
  return {
    id: record.id,
    deviceId: record.deviceId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    listenedMs: record.listenedMs,
    song,
  }
}

/**
 * Per-user listening history. Same id is stored once (first write wins).
 * receivedAt is a server-side monotonic cursor and is not part of the wire record.
 */
export class PlayHistoryStore {
  private readonly dir: string
  private readonly filePath: string
  private readonly now: () => number
  private records: StoredRecord[] = []
  private byId = new Map<string, StoredRecord>()
  private cursor = 0
  private loaded = false
  private tail: Promise<void> = Promise.resolve()

  constructor(dir: string, options?: { now?: () => number }) {
    this.dir = dir
    this.filePath = path.join(dir, File.playHistoryJSON)
    this.now = options?.now ?? Date.now
  }

  push = async(payload: unknown): Promise<LX.Sync.PlayHistory.PushResult> => {
    const incoming = parsePushPayload(payload)
    return await this.enqueue(() => {
      this.ensureLoaded()
      const nextRecords = this.records.slice()
      const nextById = new Map(this.byId)
      let cursor = this.cursor
      let accepted = 0
      let ignored = 0
      for (const record of incoming) {
        if (nextById.has(record.id)) {
          ignored++
          continue
        }
        cursor = Math.max(cursor + 1, this.now())
        const stored: StoredRecord = { ...record, song: { ...record.song }, receivedAt: cursor }
        nextRecords.push(stored)
        nextById.set(record.id, stored)
        accepted++
      }
      if (accepted > 0) {
        this.writeAtomic({ version: 1, cursor, records: nextRecords })
        this.records = nextRecords
        this.byId = nextById
        this.cursor = cursor
      }
      return { accepted, ignored, cursor: this.cursor }
    })
  }

  pull = async(payload: unknown): Promise<LX.Sync.PlayHistory.PullResult> => {
    const since = parsePullPayload(payload)
    return await this.enqueue(() => {
      this.ensureLoaded()
      const matched = this.records.filter(record => record.receivedAt > since)
      const page = matched.slice(0, PLAY_HISTORY_LIMITS.maxPage)
      const hasMore = matched.length > page.length
      const cursor = page.length > 0 ? page[page.length - 1].receivedAt : Math.max(since, this.cursor)
      return {
        records: page.map(toPublic),
        cursor,
        hasMore,
      }
    })
  }

  private async enqueue<T>(task: () => T): Promise<T> {
    const run = this.tail.then(task, task)
    this.tail = run.then(() => undefined, () => undefined)
    return await run
  }

  private ensureLoaded() {
    if (this.loaded) return
    this.load()
    this.loaded = true
  }

  private load() {
    if (!fs.existsSync(this.filePath)) {
      this.records = []
      this.byId = new Map()
      this.cursor = 0
      return
    }
    let data: unknown
    try {
      data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    } catch {
      throw new Error('invalid play history file')
    }
    if (!data || typeof data != 'object' || Array.isArray(data)) throw new Error('invalid play history file')
    const file = data as Partial<PlayHistoryFile>
    if (file.version !== 1 || !Array.isArray(file.records) || typeof file.cursor != 'number' || !Number.isSafeInteger(file.cursor) || file.cursor < 0) {
      throw new Error('invalid play history file')
    }
    const records: StoredRecord[] = []
    const byId = new Map<string, StoredRecord>()
    let cursor = file.cursor
    for (const item of file.records) {
      if (!item || typeof item != 'object' || Array.isArray(item)) throw new Error('invalid play history file')
      const receivedAt = (item as { receivedAt?: unknown }).receivedAt
      if (typeof receivedAt != 'number' || !Number.isSafeInteger(receivedAt) || receivedAt < 0) {
        throw new Error('invalid play history file')
      }
      const record = parseRecord(item)
      if (byId.has(record.id)) continue
      const stored: StoredRecord = { ...record, song: { ...record.song }, receivedAt }
      records.push(stored)
      byId.set(record.id, stored)
      if (receivedAt > cursor) cursor = receivedAt
    }
    records.sort((a, b) => a.receivedAt - b.receivedAt)
    this.records = records
    this.byId = byId
    this.cursor = cursor
  }

  private writeAtomic(data: PlayHistoryFile) {
    checkAndCreateDirSync(this.dir)
    const tmp = this.filePath + '.tmp'
    const json = JSON.stringify(data)
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, json)
      fs.fsyncSync(fd)
    } catch (err) {
      fs.closeSync(fd)
      fs.rmSync(tmp, { force: true })
      throw err
    }
    fs.closeSync(fd)
    fs.renameSync(tmp, this.filePath)
    this.fsyncDir()
  }

  private fsyncDir() {
    let dirFd: number | null = null
    try {
      dirFd = fs.openSync(this.dir, 'r')
      fs.fsyncSync(dirFd)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code != 'EINVAL' && code != 'ENOTSUP' && code != 'EPERM' && code != 'EROFS') throw err
    } finally {
      if (dirFd != null) fs.closeSync(dirFd)
    }
  }
}

export class PlayHistoryManage {
  private readonly store: PlayHistoryStore

  constructor(userDataManage: UserDataManage) {
    this.store = new PlayHistoryStore(path.join(userDataManage.userDir, File.playHistoryDir))
  }

  push = async(payload: unknown) => {
    return await this.store.push(payload)
  }

  pull = async(payload: unknown) => {
    return await this.store.pull(payload)
  }
}
