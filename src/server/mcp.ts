import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { recordTokenActivity } from '@/account/tokenActivity'
import type { PatScope } from '@/account/pats'
import { authenticatePat } from './api/pats'
import { changePlaylistSongs, createPlaylist, getPlaylist, listPlaylists, readHistory } from './api/data'

const IDLE_MS = 30 * 60 * 1000
const range = { from: z.string().optional(), to: z.string().optional(), limit: z.number().int().positive().optional() }
const song = z.object({
  id: z.string().min(1), name: z.string(), singer: z.string(), source: z.enum(['kw', 'kg', 'tx', 'wy', 'mg']),
  interval: z.string().nullish(), meta: z.record(z.string(), z.unknown()),
}).passthrough()
const songs = z.array(song).max(500)
const songHelp = '歌曲必填 / Songs require id, name, singer, source (kw/kg/tx/wy/mg), meta object; optional interval string. '
const query = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))

const createMcpServer = (version: string, auth: ReturnType<typeof authenticatePat>) => {
  const server = new McpServer({ name: 'lux-music', version })
  const tool = <T extends z.ZodRawShape>(name: string, description: string, scope: PatScope, inputSchema: T,
    run: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>) => {
    server.registerTool<z.ZodRawShape, z.ZodObject<T>>(name, { description, inputSchema: z.object(inputSchema) }, async(args) => {
      try {
        if (!auth.token.scopes.includes(scope)) throw new Error(`Missing required scope: ${scope}`)
        return { content: [{ type: 'text' as const, text: JSON.stringify(await run(args as z.infer<z.ZodObject<T>>)) }] }
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: error instanceof Error ? error.message : 'Tool failed' }) }] }
      }
    })
  }
  const username = auth.user.username
  tool('get_listening_history', '收听历史 / Listening history; from/to: ISO timestamp or milliseconds string.', 'history:read',
    { ...range, cursor: z.string().optional() }, args => readHistory(username, query(args)))
  tool('get_top_tracks', '最常播放 / Top tracks; from/to: ISO timestamp or milliseconds string.', 'history:read', range,
    args => readHistory(username, query(args), true))
  tool('list_playlists', '列出歌单 / List playlists.', 'playlist:read', {}, async() => listPlaylists(username))
  tool('get_playlist', '读取歌单歌曲 / Get playlist songs.', 'playlist:read',
    { playlistId: z.string().min(1), offset: z.number().int().nonnegative().optional(), limit: range.limit },
    args => getPlaylist(username, args.playlistId, query(args)))
  tool('create_playlist', '创建歌单并同步设备 / Create playlist and sync devices. ' + songHelp, 'playlist:write',
    { name: z.string().trim().min(1).max(60), songs: songs.optional() }, args => createPlaylist(username, args))
  tool('add_songs_to_playlist', '添加歌曲并同步设备 / Add songs and sync devices. ' + songHelp, 'playlist:write',
    { playlistId: z.string().min(1), songs }, args => changePlaylistSongs(username, args.playlistId, args))
  return server
}

export const registerMcp = (app: FastifyInstance, version: string, publicUrl: string | null) => {
  type Session = { transport: StreamableHTTPServerTransport, server: McpServer, tokenId: string, userId: string, lastActive: number }
  const sessions = new Map<string, Session>()
  const close = async(id: string, session: Session) => {
    sessions.delete(id)
    await session.server.close()
  }
  const reap = async() => {
    await Promise.all([...sessions].filter(([, s]) => Date.now() - s.lastActive >= IDLE_MS).map(async([id, s]) => close(id, s)))
  }
  const timer = setInterval(() => { void reap().catch(error => app.log.error(error)) }, 60000)
  timer.unref()
  app.addHook('preClose', async() => {
    clearInterval(timer)
    await Promise.all([...sessions].map(async([id, s]) => close(id, s)))
  })
  app.route({ method: ['POST', 'GET', 'DELETE'], url: '/mcp', handler: async(request, reply) => {
    const origin = request.headers.origin
    if (origin) {
      let allowed = false
      try {
        const url = new URL(origin)
        allowed = origin == url.origin && ['http:', 'https:'].includes(url.protocol) &&
          (url.origin == (publicUrl ? new URL(publicUrl).origin : null) || ['localhost', '127.0.0.1'].includes(url.hostname))
      } catch {}
      if (!allowed) return reply.code(403).send({ error: 'Forbidden Origin' })
    }
    const auth = authenticatePat(request) // Also authenticated/rate limited by the shared PAT hook.
    await reap()
    const id = request.headers['mcp-session-id']
    let session = typeof id == 'string' ? sessions.get(id) : undefined
    if (id && !session) return reply.code(404).send({ error: 'Session not found' })
    if (session && (session.tokenId != auth.token.id || session.userId != auth.user.id)) {
      return reply.code(403).send({ error: 'Session belongs to a different token' })
    }
    if (!session) {
      if (request.method != 'POST' || !isInitializeRequest(request.body)) return reply.code(400).send({ error: 'Initialize a session first' })
      const server = createMcpServer(version, auth)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: sid => { sessions.set(sid, session!) },
        onsessionclosed: sid => { sessions.delete(sid) },
      })
      session = { server, transport, tokenId: auth.token.id, userId: auth.user.id, lastActive: Date.now() }
      await server.connect(transport)
      const onclose = transport.onclose
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); onclose?.() }
      // Observe SDK results so schema failures and unknown tools are audited too.
      const calls = new Map<string | number, string>()
      const onmessage = transport.onmessage
      transport.onmessage = (message, extra) => {
        if ('method' in message && message.method == 'tools/call' && 'id' in message) calls.set(message.id, String(message.params?.name ?? 'unknown'))
        onmessage?.(message, extra)
      }
      const send = transport.send.bind(transport)
      transport.send = async(message, options) => {
        if ('id' in message && message.id != null && calls.has(message.id)) {
          const name = calls.get(message.id)!
          const ok = 'result' in message && !message.result.isError
          recordTokenActivity(auth.token.id, `mcp.${name}`, ok ? 'Tool succeeded' : 'Tool failed', ok)
          calls.delete(message.id)
        }
        await send(message, options)
      }
    }
    session.lastActive = Date.now()
    reply.raw.setHeader('X-Accel-Buffering', 'no')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.hijack()
    try { await session.transport.handleRequest(request.raw, reply.raw, request.body) } finally {
      if (!session.transport.sessionId) await session.server.close()
    }
  } })
}
