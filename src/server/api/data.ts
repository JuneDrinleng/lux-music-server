import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { getUserSpace, getUserConfig } from '@/user'
import { sanitizeMusicInfo } from '@/modules/together/validate'
import { applyListAction } from '@/modules/list/sync/handler'
import { broadcastListClients } from '../server'
import { commandDevice, listDevices } from '../deviceCommands'
import { authenticatePat } from './pats'
import { isRecord } from './utils'

const invalid = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400, code: 'INVALID_REQUEST' }) }
export const pageLimit = (value: unknown, fallback: number, max: number) => {
  if (value === undefined) return fallback
  if (typeof value != 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) return invalid('Invalid limit')
  return Math.min(Number(value), max)
}
const time = (value: unknown, fallback: number) => {
  if (value === undefined) return fallback
  if (typeof value != 'string' || !value) return invalid('Invalid time')
  const parsed = /^\d+$/.test(value) ? Number(value) : /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : invalid('Invalid time')
}
const songs = (value: unknown): LX.Music.MusicInfoOnline[] => {
  if (!Array.isArray(value) || value.length > 500) return invalid('Expected at most 500 songs')
  return value.map(item => sanitizeMusicInfo(item) ?? invalid('Invalid song'))
}
const lists = async(username: string) => {
  const data = await getUserSpace(username).listManage.getListData()
  return [{ id: 'default', name: '试听列表', list: data.defaultList }, { id: 'love', name: '我的收藏', list: data.loveList }, ...data.userList]
}
const missing = (): never => { throw Object.assign(new Error('Playlist not found'), { statusCode: 404, code: 'NOT_FOUND' }) }
const tails = new WeakMap<object, Promise<unknown>>()
const mutate = async<T>(username: string, task: () => Promise<T>) => {
  const manage = getUserSpace(username).listManage
  const run = (tails.get(manage) ?? Promise.resolve()).catch(() => {}).then(task)
  tails.set(manage, run)
  return run
}

export const readHistory = async(username: string, query: Record<string, unknown>, top = false) => {
  const from = time(query.from, 0); const to = time(query.to, Number.MAX_SAFE_INTEGER)
  if (from > to) return invalid('from must not exceed to')
  const limit = pageLimit(query.limit, top ? 20 : 50, top ? 100 : 200)
  const records = (await getUserSpace(username).playHistoryManage.read())
    .filter(r => r.startedAt >= from && r.startedAt <= to)
    .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
  if (top) {
    const counts = new Map<string, { song: LX.Sync.PlayHistory.Song, playCount: number }>()
    for (const record of records) {
      const key = JSON.stringify([record.song.source, record.song.songmid])
      const item = counts.get(key) ?? { song: record.song, playCount: 0 }
      item.playCount++; counts.set(key, item)
    }
    return { items: [...counts.values()].sort((a, b) => b.playCount - a.playCount).slice(0, limit) }
  }
  let before: [number, string] | undefined
  if (query.cursor !== undefined) {
    try {
      const decoded = JSON.parse(Buffer.from(query.cursor as string, 'base64url').toString())
      if (!Array.isArray(decoded) || decoded.length != 2 || !Number.isSafeInteger(decoded[0]) || typeof decoded[1] != 'string') throw new Error()
      before = decoded as [number, string]
    } catch { return invalid('Invalid cursor') }
  }
  const matched = before ? records.filter(r => r.startedAt < before![0] || (r.startedAt == before![0] && r.id.localeCompare(before![1]) < 0)) : records
  const items = matched.slice(0, limit); const last = items[items.length - 1]
  return { items, nextCursor: matched.length > limit ? Buffer.from(JSON.stringify([last.startedAt, last.id])).toString('base64url') : null }
}
export const listPlaylists = async(username: string) => {
  return { items: (await lists(username)).map(info => ({ id: info.id, name: info.name, songCount: info.list.length,
    ...('source' in info && info.source ? { source: info.source } : {}),
    ...('locationUpdateTime' in info && info.locationUpdateTime != null ? { updatedAt: info.locationUpdateTime } : {}) })) }
}
export const getPlaylist = async(username: string, id: string, query: { offset?: string, limit?: string }) => {
  const list = (await lists(username)).find(l => l.id == id) ?? missing()
  if (query.offset !== undefined && (!/^\d+$/.test(query.offset) || !Number.isSafeInteger(Number(query.offset)))) return invalid('Invalid offset')
  const offset = Number(query.offset ?? 0); const limit = pageLimit(query.limit, 50, 200)
  return { items: list.list.slice(offset, offset + limit), total: list.list.length, offset, limit }
}
export const createPlaylist = async(username: string, body: unknown) => {
  if (!isRecord(body) || typeof body.name != 'string' || !body.name.trim() || body.name.trim().length > 60) return invalid('Invalid playlist name')
  const name = body.name.trim()
  const incoming = songs(body.songs === undefined ? [] : body.songs); const id = randomUUID()
  return mutate(username, async() => {
    const info = { id, name, locationUpdateTime: Date.now() }
    await applyListAction(username, { action: 'list_create', data: { position: -1, listInfos: [info] } }, broadcastListClients)
    const seen = new Set<string>()
    const unique = incoming.filter(song => { if (seen.has(song.id)) return false; seen.add(song.id); return true })
    if (unique.length) await applyListAction(username, { action: 'list_music_add', data: { id, musicInfos: unique, addMusicLocationType: 'bottom' } }, broadcastListClients)
    return { ...info, added: unique.length, skipped: incoming.length - unique.length }
  })
}
export const changePlaylistSongs = async(username: string, id: string, body: unknown, remove = false) => {
  if (!isRecord(body)) return invalid('Invalid body')
  const incoming = remove ? [] : songs(body.songs)
  if (remove && (!Array.isArray(body.songIds) || body.songIds.length > 500 || body.songIds.some(id => typeof id != 'string' || !id))) return invalid('Invalid songIds')
  if (!remove && body.position !== undefined && body.position != 'top' && body.position != 'bottom') return invalid('Invalid position')
  const songIds = body.songIds as string[]
  const position = (body.position ?? getUserConfig(username)['list.addMusicLocationType']) as LX.AddMusicLocationType
  return mutate(username, async() => {
    const list = (await lists(username)).find(l => l.id == id) ?? missing()
    const existing = new Set(list.list.map(s => s.id))
    if (remove) {
      const ids = [...new Set(songIds)].filter(id => existing.has(id))
      await applyListAction(username, { action: 'list_music_remove', data: { listId: id, ids } }, broadcastListClients)
      return { removed: ids.length, skipped: songIds.length - ids.length }
    }
    const unique = incoming.filter(song => { if (existing.has(song.id)) return false; existing.add(song.id); return true })
    await applyListAction(username, { action: 'list_music_add', data: { id, musicInfos: unique, addMusicLocationType: position } }, broadcastListClients)
    return { added: unique.length, skipped: incoming.length - unique.length }
  })
}

export const registerDataApi = async(app: FastifyInstance) => {
  app.get('/api/v1/devices', async request => listDevices(authenticatePat(request, ['player:control']).user.username))
  for (const url of ['/api/v1/devices/commands', '/api/v1/devices/:deviceId/commands']) app.post(url, async request => {
    const { user, token } = authenticatePat(request, ['player:control'])
    return commandDevice(user.username, token.id, request.body, (request.params as { deviceId?: string }).deviceId)
  })
  for (const top of [false, true]) app.get(top ? '/api/v1/stats/top-tracks' : '/api/v1/history', async request =>
    readHistory(authenticatePat(request, ['history:read']).user.username, request.query as Record<string, unknown>, top))
  app.get('/api/v1/playlists', async request => listPlaylists(authenticatePat(request, ['playlist:read']).user.username))
  app.get('/api/v1/playlists/:id', async request => getPlaylist(authenticatePat(request, ['playlist:read']).user.username,
    (request.params as { id: string }).id, request.query as { offset?: string, limit?: string }))
  app.post('/api/v1/playlists', async(request, reply) => {
    const result = await createPlaylist(authenticatePat(request, ['playlist:write']).user.username, request.body)
    reply.code(201)
    return result
  })
  for (const remove of [false, true]) app.route({ method: remove ? 'DELETE' : 'POST', url: '/api/v1/playlists/:id/songs', handler: async request =>
    changePlaylistSongs(authenticatePat(request, ['playlist:write']).user.username, (request.params as { id: string }).id, request.body, remove) })
}
