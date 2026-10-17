import { EventEmitter } from 'node:events'
import http from 'node:http'
import WebSocket from 'ws'
import { createMsg2call } from 'message2call'
import { SYNC_CODE } from '../../../src/constants'
import { aesDecrypt, aesEncrypt, decryptMsg, encryptMsg } from '../../../src/utils/tools'

const TIMEOUT_MS = 2000
// Keep fixture deadlines on wall time when a regression test mocks server timers.
const wallTimeout = setTimeout
const wallClearTimeout = clearTimeout

export interface SyncCredentials {
  clientId: string
  key: string
  deviceName?: string
}

export type Credentials = SyncCredentials

export interface Gate {
  wait: Promise<void>
  release: () => void
}

export const createGate = (): Gate => {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

export interface ClientOptions {
  list?: boolean
  chat?: boolean
  reaction?: boolean
  request?: boolean
  featuresGate?: Gate
  togetherFinishedGate?: Gate
  listDataGate?: Gate
}

type TogetherActions = LX.Sync.ServerSyncTogetherActions & LX.Sync.ServerSyncActions
type PushMethod = keyof LX.Sync.ClientSyncTogetherActions
export type TogetherPush = {
  [K in PushMethod]: {
    method: K
    payload: Parameters<LX.Sync.ClientSyncTogetherActions[K]>[0]
    frameIndex: number
  }
}[PushMethod]

export interface ReceivedFrame {
  /** Index at the WebSocket message event, before any asynchronous decompression. */
  index: number
  compressed: boolean
  wire: string
  path?: string
  message?: Record<string, any>
}

export interface HandshakeCall {
  method: string
  args: unknown[]
  frameIndex: number
}

const httpRequest = async(baseUrl: string, route: string, options: {
  body?: unknown
  headers?: Record<string, string>
} = {}) => await new Promise<{ status: number, body: string }>((resolve, reject) => {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body)
  const request = http.request(new URL(route, baseUrl), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      connection: 'close',
      ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
      ...options.headers,
    },
  }, response => {
    const chunks: Buffer[] = []
    response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
    response.once('error', reject)
    response.once('end', () => {
      resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() })
    })
  })
  request.setTimeout(TIMEOUT_MS, () => { request.destroy(new Error(`HTTP timeout: ${route}`)) })
  request.once('error', reject)
  request.end(body)
})

/** Obtain credentials through the actual bearer-authenticated sync-key endpoint. */
export const loginAndGetKey = async(baseUrl: string, username: string, password: string, device: {
  deviceId?: string
  clientId?: string
  deviceName?: string
} = {}): Promise<SyncCredentials & { token: string }> => {
  const login = await httpRequest(baseUrl, '/api/auth/login', { body: { username, password } })
  if (login.status != 200) throw new Error(`Login failed (${login.status}): ${login.body}`)
  const { token } = JSON.parse(login.body) as { token: string }
  const credentials = await httpRequest(baseUrl, '/api/sync/key', {
    body: { ...device, platform: 'node-e2e' },
    headers: { authorization: `Bearer ${token}` },
  })
  if (credentials.status != 200) throw new Error(`Sync key failed (${credentials.status}): ${credentials.body}`)
  return { ...JSON.parse(credentials.body), token }
}

/** Real LX key challenge, in addition to the independently authenticated WS upgrade. */
export const verifyAuth = async(baseUrl: string, credentials: SyncCredentials) => {
  const response = await httpRequest(baseUrl, '/ah', {
    headers: {
      i: credentials.clientId,
      m: aesEncrypt(SYNC_CODE.authMsg + (credentials.deviceName ?? 'node-e2e'), credentials.key),
    },
  })
  if (response.status != 200 || aesDecrypt(response.body, credentials.key) != SYNC_CODE.helloMsg) {
    throw new Error(`Sync authentication failed (${response.status})`)
  }
}

/**
 * A headless protocol peer, using production codecs and message2call. Both client
 * transport queues preserve WS order: a server compression race must remain
 * visible in frames/pushes, rather than being introduced or hidden by this peer.
 */
export class TogetherClient {
  readonly pushes: TogetherPush[] = []
  readonly frames: ReceivedFrame[] = []
  readonly handshake: HandshakeCall[] = []
  readonly fatalErrors: Error[] = []
  readonly rpcErrors: Error[] = []
  readonly ws: WebSocket
  private readonly changes = new EventEmitter()
  private readonly rpc: ReturnType<typeof createMsg2call<TogetherActions>>
  private outbound: Promise<void> = Promise.resolve()
  private inbound: Promise<void> = Promise.resolve()
  private frameIndex = -1
  private ready = false
  private opened = false
  private closed = false

  private constructor(baseUrl: string, readonly credentials: SyncCredentials, readonly options: ClientOptions) {
    const url = new URL(baseUrl)
    url.protocol = 'ws:'
    url.searchParams.set('i', credentials.clientId)
    url.searchParams.set('t', aesEncrypt(SYNC_CODE.msgConnect, credentials.key))
    this.ws = new WebSocket(url, { handshakeTimeout: TIMEOUT_MS })
    const recordHandshake = (method: string, args: unknown[] = []) => {
      this.handshake.push({ method, args, frameIndex: this.frameIndex })
      this.changes.emit('change')
    }
    const recordPush = (method: PushMethod, payload: TogetherPush['payload']) => {
      this.pushes.push({ method, payload, frameIndex: this.frameIndex } as TogetherPush)
      this.changes.emit('change')
    }
    this.rpc = createMsg2call<TogetherActions>({
      timeout: TIMEOUT_MS,
      funcsObj: {
        getEnabledFeatures: async(serverType: string, supportedFeatures: LX.Sync.SupportedFeatures) => {
          recordHandshake('getEnabledFeatures', [serverType, supportedFeatures])
          await options.featuresGate?.wait
          // Feature version 1 is truthy on the legacy EnabledFeatures wire format.
          return { list: options.list ?? false, dislike: false, playHistory: false, together: 1, ...(options.reaction ? { 'together.reaction': true } : {}), ...(options.request ? { 'together.request': true } : {}), ...(options.chat ? { 'together.chat': true } : {}) }
        },
        together_sync_finished: async() => {
          recordHandshake('together_sync_finished')
          await options.togetherFinishedGate?.wait
        },
        finished: () => { recordHandshake('finished') },
        // Legacy list resync is used only to suspend a real in-flight feature
        // change across socket close; it returns a valid empty client library.
        list_sync_get_list_data: async() => {
          recordHandshake('list_sync_get_list_data')
          await options.listDataGate?.wait
          return { defaultList: [], loveList: [], userList: [] }
        },
        list_sync_get_md5: () => { recordHandshake('list_sync_get_md5'); return '' },
        list_sync_get_sync_mode: () => { recordHandshake('list_sync_get_sync_mode'); return 'cancel' },
        list_sync_set_list_data: () => { recordHandshake('list_sync_set_list_data') },
        list_sync_finished: () => { recordHandshake('list_sync_finished') },
        onListSyncAction: (action: LX.Sync.List.ActionList) => { recordHandshake('onListSyncAction', [action]) },
        'together:onRoomState': (payload: LX.Sync.Together.RoomStatePush) => { recordPush('together:onRoomState', payload) },
        'together:onMemberChanged': (payload: LX.Sync.Together.MemberChangedPush) => { recordPush('together:onMemberChanged', payload) },
        'together:onHostChanged': (payload: LX.Sync.Together.HostChangedPush) => { recordPush('together:onHostChanged', payload) },
        ...(options.chat ? { 'together:onChat': (payload: LX.Sync.Together.ChatPush) => { recordPush('together:onChat', payload) } } : {}),
        ...(options.reaction ? { 'together:onReaction': (payload: LX.Sync.Together.ReactionPush) => { recordPush('together:onReaction', payload) } } : {}),
        ...(options.request ? { 'together:onRequests': (payload: LX.Sync.Together.RequestsPush) => { recordPush('together:onRequests', payload) } } : {}),
        'together:onRoomClosed': (payload: LX.Sync.Together.RoomClosedPush) => { recordPush('together:onRoomClosed', payload) },
      },
      sendMessage: data => {
        this.outbound = this.outbound.then(async() => {
          const wire = await encryptMsg(null, JSON.stringify(data))
          if (this.ws.readyState != WebSocket.OPEN) return
          await new Promise<void>((resolve, reject) => {
            this.ws.send(wire, error => { error ? reject(error) : resolve() })
          })
          // Ready means the finished callback response was actually sent.
          if (!data.path && String(data.name).startsWith('finished__')) this.ready = true
          this.changes.emit('change')
        }).catch(error => { this.fail(error) })
      },
      onError: error => { this.rpcErrors.push(error) },
    })
    this.ws.once('open', () => {
      this.opened = true
      this.changes.emit('change')
    })
    this.ws.on('error', error => { this.fail(error) })
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return this.fail(new Error('Unexpected binary sync message'))
      const wire = data.toString()
      if (wire == 'ping') return
      const frame: ReceivedFrame = { index: this.frames.length, compressed: wire.startsWith('cg_'), wire }
      this.frames.push(frame)
      this.inbound = this.inbound.then(async() => {
        const message = JSON.parse(await decryptMsg(null, wire)) as Record<string, any>
        frame.path = Array.isArray(message.path) ? message.path.join('.') : undefined
        // message2call pops the final path segment while dispatching.
        frame.message = { ...message, ...(message.path ? { path: [...message.path] } : {}) }
        this.frameIndex = frame.index
        this.rpc.message(message)
        this.changes.emit('change')
      }).catch(error => { this.fail(error) })
    })
    this.ws.once('close', () => {
      this.closed = true
      this.rpc.destroy()
      options.featuresGate?.release()
      options.togetherFinishedGate?.release()
      options.listDataGate?.release()
      this.changes.emit('change')
    })
  }

  static async connect(baseUrl: string, credentials: SyncCredentials, options: ClientOptions = {}) {
    await verifyAuth(baseUrl, credentials)
    const client = new TogetherClient(baseUrl, credentials, options)
    try {
      await client.waitFor(() => client.opened, 'WebSocket open')
      return client
    } catch (error) {
      await client.kill()
      throw error
    }
  }

  private fail(error: unknown) {
    this.fatalErrors.push(error instanceof Error ? error : new Error(String(error)))
    this.changes.emit('change')
    this.ws.terminate()
  }

  async waitFor(predicate: () => boolean, label = 'client condition', timeoutMs = TIMEOUT_MS, closing = false): Promise<void> {
    if (predicate()) return
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        wallClearTimeout(timer)
        this.changes.off('change', check)
      }
      const check = () => {
        try {
          if (predicate()) { cleanup(); resolve(); return }
          if (!closing && this.fatalErrors.length) { cleanup(); reject(this.fatalErrors[0]) }
        } catch (error) { cleanup(); reject(error) }
      }
      const timer = wallTimeout(() => {
        cleanup()
        reject(new Error(`Timed out waiting for ${label}`))
      }, timeoutMs)
      this.changes.on('change', check)
      check()
    })
  }

  async waitReady() { await this.waitFor(() => this.ready, 'finished handshake response') }

  createRoom() { return this.rpc.remote['together:createRoom']() }
  joinRoom(code: string) { return this.rpc.remote['together:joinRoom']({ code }) }
  getRoom() { return this.rpc.remote['together:getRoom']() }
  hostUpdateState(request: LX.Sync.Together.HostUpdateStateRequest) { return this.rpc.remote['together:hostUpdateState'](request) }
  hostUpdateQueue(request: LX.Sync.Together.HostUpdateQueueRequest) { return this.rpc.remote['together:hostUpdateQueue'](request) }
  requestAdd(song: LX.Music.MusicInfoOnline) { return this.rpc.remote['together:request:add']({ song }) }
  requestApprove(requestId: string, expectedQueueVersion?: number) { return this.rpc.remote['together:request:approve']({ requestId, expectedQueueVersion }) }
  chatSend(text: string, clientMsgId: string) { return this.rpc.remote['together:chat:send']({ text, clientMsgId }) }
  chatHistory(roomId: string) { return this.rpc.remote['together:chat:history']({ roomId }) }
  reaction(emoji: string) { return this.rpc.remote['together:reaction']({ emoji }) }
  ping(t0: number) { return this.rpc.remote['together:ping']({ t0 }) }
  leave(roomId: string) { return this.rpc.remote['together:leaveRoom']({ roomId }) }
  closeRoom(roomId: string) { return this.rpc.remote['together:closeRoom']({ roomId }) }
  onFeatureChanged(features: LX.Sync.EnabledFeatures) { return this.rpc.remote.onFeatureChanged(features) }

  async kill() {
    if (!this.closed) this.ws.terminate()
    // An upgrade/transport error is the reason to clean up, not a reason to
    // abandon cleanup before ws emits close and message2call destroys timers.
    await this.waitFor(() => this.closed, 'terminated WebSocket close', TIMEOUT_MS, true)
    await Promise.all([this.inbound, this.outbound])
  }

  async close() {
    if (!this.closed) {
      if (this.ws.readyState == WebSocket.OPEN) this.ws.close(1000)
      else this.ws.terminate()
    }
    try {
      await this.waitFor(() => this.closed, 'WebSocket close', TIMEOUT_MS, true)
    } catch (error) {
      await this.kill()
      throw error
    }
    await Promise.all([this.inbound, this.outbound])
  }
}
