import { randomUUID } from 'node:crypto'
import { getUserSpace } from '@/user'
import { recordTokenActivity } from '@/account/tokenActivity'
import { isRecord, sanitizeMusicInfo } from '@/modules/together/validate'
import { broadcastListClients } from './server'
import { isSocketOpen } from './socketState'

type CommandInput = { type: 'play_song', payload: { song: LX.Music.MusicInfoOnline, mode: 'now' | 'next' } }
  | { type: 'playback', payload: { action: 'pause' | 'resume' | 'next' | 'previous' } }
export type DeviceCommand = CommandInput & { id: string, issuedAt: number, expiresAt: number }
export type DeviceResult = { ok: true, state?: unknown } | { ok: false, code: string, message: string }
const fail = (statusCode: number, code: string, message: string): never => { throw Object.assign(new Error(message), { statusCode, code }) }
const invalid = (): never => fail(400, 'INVALID_REQUEST', 'Invalid device command')
export const validateCommand = (body: unknown): CommandInput => {
  if (!isRecord(body) || !isRecord(body.payload)) return invalid()
  if (body.type == 'play_song') {
    const song = sanitizeMusicInfo(body.payload.song)
    if (!song || !['now', 'next'].includes(body.payload.mode)) return invalid()
    return { type: 'play_song', payload: { song, mode: body.payload.mode } }
  }
  if (body.type == 'playback' && ['pause', 'resume', 'next', 'previous'].includes(body.payload.action)) {
    return { type: 'playback', payload: { action: body.payload.action } }
  }
  return invalid()
}

/** A separate deadline leaves existing list/together RPC timeout behavior intact. */
export const dispatchCommand = async(socket: LX.Socket, input: CommandInput, timeoutMs = 8000,
  now = Date.now, issuedAt = now()): Promise<DeviceResult> => {
  if (!socket.isReady || !isSocketOpen(socket)) return fail(503, 'DEVICE_OFFLINE', 'Device is offline')
  if (!socket.feature['device.command']) return fail(409, 'DEVICE_UNSUPPORTED', 'Device does not support commands')
  const command = { ...input, id: randomUUID(), issuedAt, expiresAt: issuedAt + 30000 }
  if (now() >= command.expiresAt) return fail(504, 'DEVICE_TIMEOUT', 'Command expired')
  return new Promise((resolve, reject) => {
    const error = (statusCode: number, code: string, message: string) => Object.assign(new Error(message), { statusCode, code })
    let settled = false; let closed = false
    const timer = setTimeout(() => finish(error(504, 'DEVICE_TIMEOUT', 'Device did not acknowledge in time')), Math.min(timeoutMs, command.expiresAt - now()))
    const off = socket.onClose(() => {
      closed = true
      finish(error(503, 'DEVICE_OFFLINE', 'Device disconnected'))
    })
    const finish = (error?: Error, result?: DeviceResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // The server clears close handlers after iterating; do not splice that iteration.
      if (!closed) off()
      if (error) reject(error)
      else resolve(result!)
    }
    void socket.remote['device:command'](command).then(result => {
      if (now() >= command.expiresAt) return finish(error(504, 'DEVICE_TIMEOUT', 'Command expired'))
      if (!isRecord(result) || (result.ok !== true && !(result.ok === false && typeof result.code == 'string' && typeof result.message == 'string'))) {
        return finish(error(502, 'DEVICE_INVALID_ACK', 'Invalid device acknowledgement'))
      }
      finish(undefined, result)
    }, () => { finish(error(503, 'DEVICE_OFFLINE', 'Device RPC failed')) })
  })
}

const connections = (username: string) => {
  const sockets: LX.Socket[] = []
  broadcastListClients(socket => {
    if (socket.isReady && socket.userInfo?.name == username) sockets.push(socket)
  })
  return sockets.sort((a, b) => b.lastActiveAt - a.lastActiveAt || b.connectedAt - a.connectedAt)
}
const deviceId = (username: string, socket: LX.Socket) => getUserSpace(username).dataManage.getDeviceClientId(socket.keyInfo.clientId)
export const listDevices = async(username: string) => ({ items: connections(username).map(socket => ({
  deviceId: deviceId(username, socket), name: socket.keyInfo.deviceName,
  connectedAt: socket.connectedAt, supportsCommands: !!socket.feature['device.command'],
})) })

export const createDeviceCommandService = (timeoutMs = 8000) => {
  const windows = new Map<string, { at: number, count: number }>()
  return async(username: string, tokenId: string, body: unknown, target?: string) => {
    const input = validateCommand(body)
    const summary = input.type == 'play_song' ? `play_song ${input.payload.mode} ${input.payload.song.name}` : `playback ${input.payload.action}`
    let ok = false
    try {
      const now = Date.now()
      for (const [id, window] of windows) if (now - window.at >= 60000) windows.delete(id)
      const window = windows.get(tokenId) ?? { at: now, count: 0 }
      windows.set(tokenId, window)
      if (++window.count > 10) return fail(429, 'RATE_LIMITED', 'At most 10 commands per minute per token')
      const sockets = connections(username)
      const socket = target === undefined ? sockets.find(s => s.feature['device.command']) : sockets.find(s => deviceId(username, s) == target)
      if (!socket) {
        if (target !== undefined && !getUserSpace(username).dataManage.getClientKeyInfo(target)) return fail(404, 'NOT_FOUND', 'Device not found')
        return fail(503, 'DEVICE_OFFLINE', 'No connected command target')
      }
      const result = await dispatchCommand(socket, input, timeoutMs)
      ok = result.ok
      return result
    } finally { recordTokenActivity(tokenId, 'device.command', summary, ok) }
  }
}
let sendCommand = createDeviceCommandService()
export const commandDevice = (...args: Parameters<typeof sendCommand>) => sendCommand(...args)
export const setDeviceCommandTimeoutForTests = (timeoutMs = 8000) => { sendCommand = createDeviceCommandService(timeoutMs) }
