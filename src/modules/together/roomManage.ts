import crypto from 'node:crypto'
import { getAccountStore } from '@/account/store'
import { broadcastRoom } from './broadcast'
import { type Clock, createPingResult, systemClock } from './clock'
import { TOGETHER_LIMITS, type TogetherConfig, readTogetherConfig } from './protocol'
import {
  isFiniteNumber,
  isNonNegativeNumber,
  isQuality,
  isRecord,
  normalizeInviteCode,
  sanitizeMusicInfo,
} from './validate'

type Result<T> = LX.Sync.LuxResult<T>
type Member = LX.Sync.Together.Member
type Snapshot = LX.Sync.Together.RoomSnapshot

export interface MemberAccount {
  userId: string
  username: string
  displayName: string
  avatar: string
}

interface MemberEntry {
  info: Member
  socket: LX.Socket | null
  graceTimer: unknown
}

interface Room {
  roomId: string
  code: string
  hostId: string
  members: Map<string, MemberEntry>
  maxMembers: number
  createdAt: number
  version: number
  playbackVersion: number
  queueVersion: number
  playback: LX.Sync.Together.Playback
  queue: LX.Sync.Together.Queue
  hostUpdates: number[]
}

export interface RoomManagerOptions {
  config?: Partial<TogetherConfig>
  clock?: Clock
  /** Only active managed Lux accounts may use rooms; legacy `config.users` cannot. */
  getAccount?: (socket: LX.Socket) => MemberAccount | null
}

export interface TogetherStats {
  activeRooms: number
  members: number
  onlineMembers: number
}

const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const fail = <T = never>(code: LX.Sync.LuxErrorCode, message: string, detail?: unknown): Result<T> => (
  detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail }
)

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const getManagedAccount = (socket: LX.Socket): MemberAccount | null => {
  const name = socket.userInfo?.name
  if (!name) return null
  const user = getAccountStore().findManagedUserByUsername(name)
  if (!user || user.status != 'active') return null
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    avatar: user.avatar || '',
  }
}

/** Sliding-window counter; returns true when `limit` hits already happened inside `windowMs`. */
const isLimited = (hits: number[], now: number, limit: number, windowMs: number) => {
  while (hits.length && hits[0] <= now - windowMs) hits.shift()
  return hits.length >= limit
}

export class RoomManager {
  readonly config: TogetherConfig
  private readonly clock: Clock
  private readonly getAccount: (socket: LX.Socket) => MemberAccount | null
  private readonly rooms = new Map<string, Room>()
  private readonly memberRooms = new Map<string, string>()
  private readonly joinFailures = new Map<string, number[]>()

  constructor(options: RoomManagerOptions = {}) {
    this.config = { ...readTogetherConfig(), ...options.config }
    this.clock = options.clock ?? systemClock
    this.getAccount = options.getAccount ?? getManagedAccount
  }

  // ---- C→S methods ----

  createRoom(socket: LX.Socket): Result<Snapshot> {
    const account = this.getAccount(socket)
    if (!account) return fail('NOT_LUX_ACCOUNT', 'Listen together requires an active Lux account')
    const memberId = socket.keyInfo.clientId
    if (this.memberRooms.has(memberId)) return fail('ALREADY_IN_ROOM', 'This device is already in a room')
    if (this.rooms.size >= this.config.maxRooms) return fail('ROOM_LIMIT', 'The server has reached its room limit')

    const now = this.clock.now()
    const code = this.generateCode()
    const room: Room = {
      roomId: crypto.randomUUID(),
      code,
      hostId: memberId,
      members: new Map(),
      maxMembers: this.config.maxMembers,
      createdAt: now,
      version: 1,
      playbackVersion: 1,
      queueVersion: 1,
      playback: { musicInfo: null, quality: null, isPlaying: false, positionMs: 0, durationMs: 0, updatedAt: now },
      queue: { items: [], currentId: null },
      hostUpdates: [],
    }
    room.members.set(memberId, this.createMemberEntry(socket, account, now))
    this.rooms.set(code, room)
    this.memberRooms.set(memberId, code)
    return ok(this.snapshot(room))
  }

  joinRoom(socket: LX.Socket, req: unknown): Result<Snapshot> {
    const account = this.getAccount(socket)
    if (!account) return fail('NOT_LUX_ACCOUNT', 'Listen together requires an active Lux account')
    const memberId = socket.keyInfo.clientId
    const now = this.clock.now()
    let failures = this.joinFailures.get(memberId)
    if (failures && isLimited(failures, now, TOGETHER_LIMITS.joinFailures, TOGETHER_LIMITS.joinFailureWindowMs)) {
      return fail('RATE_LIMITED', 'Too many failed join attempts, try again later')
    }
    const recordFailure = <T>(result: Result<T>) => {
      if (!failures) this.joinFailures.set(memberId, failures = [])
      failures.push(now)
      return result
    }

    const code = normalizeInviteCode(isRecord(req) ? req.code : undefined)
    if (!code) return recordFailure(fail('INVALID_PARAMS', 'Invite code must be 6 digits'))

    const currentCode = this.memberRooms.get(memberId)
    if (currentCode == code) {
      const room = this.rooms.get(code)!
      this.bindSocket(room, room.members.get(memberId)!, socket)
      return ok(this.snapshot(room))
    }
    if (currentCode != null) return fail('ALREADY_IN_ROOM', 'This device is already in another room')

    const room = this.rooms.get(code)
    if (!room) return recordFailure(fail('ROOM_NOT_FOUND', 'Room not found'))
    if (room.members.size >= room.maxMembers) return recordFailure(fail('ROOM_FULL', 'Room is full'))

    room.members.set(memberId, this.createMemberEntry(socket, account, now))
    this.memberRooms.set(memberId, code)
    room.version++
    this.pushMemberChanged(room, { type: 'join', memberId }, memberId)
    return ok(this.snapshot(room))
  }

  getRoom(socket: LX.Socket): Result<Snapshot | null> {
    if (!this.getAccount(socket)) return fail('NOT_LUX_ACCOUNT', 'Listen together requires an active Lux account')
    const room = this.getRoomOf(socket.keyInfo.clientId)
    return ok(room ? this.snapshot(room) : null)
  }

  leaveRoom(socket: LX.Socket, req: unknown): Result<null> {
    const found = this.findMembership(socket, req)
    if (!found.ok) return found
    const { room, memberId } = found.data
    if (room.hostId == memberId) this.removeHost(room, 'host_left')
    else this.removeMember(room, memberId, 'left')
    return ok(null)
  }

  closeRoom(socket: LX.Socket, req: unknown): Result<null> {
    const found = this.findMembership(socket, req)
    if (!found.ok) return found
    const { room, memberId } = found.data
    if (room.hostId != memberId) return fail('NOT_HOST', 'Only the host can close the room')
    this.destroyRoom(room, 'host_closed')
    return ok(null)
  }

  hostUpdateState(socket: LX.Socket, req: unknown): Result<LX.Sync.Together.UpdateAck> {
    const found = this.findHost(socket, req)
    if (!found.ok) return found
    const room = found.data
    const r = req as Record<string, unknown>
    let musicInfo: LX.Music.MusicInfoOnline | null = null
    if (r.musicInfo != null) {
      musicInfo = sanitizeMusicInfo(r.musicInfo)
      if (!musicInfo) return fail('INVALID_MUSIC', 'musicInfo must be an online song')
    }
    if (!isFiniteNumber(r.baseVersion) ||
      (r.quality != null && !isQuality(r.quality)) ||
      typeof r.isPlaying != 'boolean' ||
      !isNonNegativeNumber(r.positionMs) ||
      !isNonNegativeNumber(r.durationMs) ||
      !isFiniteNumber(r.sampledAt)) {
      return fail('INVALID_PARAMS', 'Invalid playback state')
    }
    if (r.baseVersion != room.playbackVersion) return fail('VERSION_CONFLICT', 'Playback version conflict', this.snapshot(room))

    const now = this.clock.now()
    const updatedAt = clamp(r.sampledAt, now - TOGETHER_LIMITS.sampledAtSkewMs, now)
    // Keep `positionMs` meaning "progress at updatedAt" when sampledAt had to be clamped.
    let positionMs = r.positionMs + (r.isPlaying ? updatedAt - r.sampledAt : 0)
    positionMs = clamp(positionMs, 0, r.durationMs > 0 ? r.durationMs : Infinity)
    room.playback = {
      musicInfo,
      quality: musicInfo ? (r.quality as LX.Quality | null) ?? null : null,
      isPlaying: musicInfo ? r.isPlaying : false,
      positionMs,
      durationMs: r.durationMs,
      updatedAt,
    }
    room.playbackVersion++
    room.version++
    this.pushRoomState(room, false)
    return ok({ version: room.version, subVersion: room.playbackVersion, updatedAt })
  }

  hostUpdateQueue(socket: LX.Socket, req: unknown): Result<LX.Sync.Together.UpdateAck> {
    const found = this.findHost(socket, req)
    if (!found.ok) return found
    const room = found.data
    const r = req as Record<string, unknown>
    if (!isFiniteNumber(r.baseVersion) ||
      !Array.isArray(r.items) ||
      r.items.length > TOGETHER_LIMITS.queueItems ||
      (r.currentId !== null && typeof r.currentId != 'string')) {
      return fail('INVALID_PARAMS', `Invalid queue (at most ${TOGETHER_LIMITS.queueItems} songs)`)
    }
    const items: LX.Music.MusicInfoOnline[] = []
    for (const item of r.items) {
      const musicInfo = sanitizeMusicInfo(item)
      if (!musicInfo) return fail('INVALID_MUSIC', 'Queue may only contain online songs')
      items.push(musicInfo)
    }
    if (r.baseVersion != room.queueVersion) return fail('VERSION_CONFLICT', 'Queue version conflict', this.snapshot(room))

    room.queue = { items, currentId: r.currentId as string | null }
    room.queueVersion++
    room.version++
    this.pushRoomState(room, true)
    return ok({ version: room.version, subVersion: room.queueVersion, updatedAt: this.clock.now() })
  }

  transferHost(socket: LX.Socket, req: unknown): Result<null> {
    const found = this.findMembership(socket, req)
    if (!found.ok) return found
    const { room, memberId } = found.data
    if (room.hostId != memberId) return fail('NOT_HOST', 'Only the host can transfer the host role')
    const targetId = (req as Record<string, unknown>).memberId
    if (typeof targetId != 'string') return fail('INVALID_PARAMS', 'memberId must be a string')
    const target = room.members.get(targetId)
    if (!target) return fail('MEMBER_NOT_FOUND', 'Member not found')
    if (!target.info.online) return fail('MEMBER_OFFLINE', 'Member is offline')
    if (targetId != memberId) this.changeHost(room, targetId, 'transfer')
    return ok(null)
  }

  ping(req: unknown): Result<LX.Sync.Together.PingResult> {
    const t0 = isRecord(req) ? req.t0 : undefined
    if (!isFiniteNumber(t0)) return fail('INVALID_PARAMS', 't0 must be a number')
    return ok(createPingResult(t0, this.clock))
  }

  // ---- connection lifecycle (§4.5) ----

  /** A new socket for the same clientId finished `togetherModule.sync`: rebind it within the grace period. */
  handleSocketReady(socket: LX.Socket) {
    const room = this.getRoomOf(socket.keyInfo.clientId)
    if (!room) return
    this.bindSocket(room, room.members.get(socket.keyInfo.clientId)!, socket)
  }

  handleSocketClosed(socket: LX.Socket) {
    const memberId = socket.keyInfo?.clientId
    if (!memberId) return
    const room = this.getRoomOf(memberId)
    if (!room) return
    const member = room.members.get(memberId)!
    // A replacement socket (checkDuplicateClient) may already be bound.
    if (member.socket !== socket) return
    const now = this.clock.now()
    member.socket = null
    member.info.online = false
    member.info.offlineAt = now
    this.clearGrace(member)
    const roomId = room.roomId
    member.graceTimer = this.clock.setTimeout(() => {
      this.handleGraceExpired(roomId, memberId)
    }, this.config.graceMs)
    room.version++
    this.pushMemberChanged(room, { type: 'offline', memberId }, memberId)
  }

  // ---- admin / maintenance ----

  getStats(): TogetherStats {
    let members = 0
    let onlineMembers = 0
    for (const room of this.rooms.values()) {
      for (const member of room.members.values()) {
        members++
        if (member.info.online) onlineMembers++
      }
    }
    return { activeRooms: this.rooms.size, members, onlineMembers }
  }

  clear() {
    for (const room of this.rooms.values()) {
      for (const member of room.members.values()) this.clearGrace(member)
    }
    this.rooms.clear()
    this.memberRooms.clear()
    this.joinFailures.clear()
  }

  // ---- internals ----

  private generateCode() {
    for (;;) {
      const code = String(crypto.randomInt(100000, 1000000))
      if (!this.rooms.has(code)) return code
    }
  }

  private createMemberEntry(socket: LX.Socket, account: MemberAccount, now: number): MemberEntry {
    return {
      info: {
        memberId: socket.keyInfo.clientId,
        userId: account.userId,
        username: account.username,
        displayName: account.displayName,
        avatar: account.avatar,
        deviceName: socket.keyInfo.deviceName,
        joinedAt: now,
        online: true,
      },
      socket,
      graceTimer: null,
    }
  }

  private getRoomOf(memberId: string) {
    const code = this.memberRooms.get(memberId)
    return code == null ? null : this.rooms.get(code) ?? null
  }

  private findMembership(socket: LX.Socket, req: unknown): Result<{ room: Room, memberId: string }> {
    if (!this.getAccount(socket)) return fail('NOT_LUX_ACCOUNT', 'Listen together requires an active Lux account')
    const memberId = socket.keyInfo.clientId
    const room = this.getRoomOf(memberId)
    const roomId = isRecord(req) ? req.roomId : undefined
    if (!room || room.roomId !== roomId) return fail('NOT_IN_ROOM', 'Not in this room')
    return ok({ room, memberId })
  }

  private findHost(socket: LX.Socket, req: unknown): Result<Room> {
    const found = this.findMembership(socket, req)
    if (!found.ok) return found
    const { room, memberId } = found.data
    if (room.hostId != memberId) return fail('NOT_HOST', 'Only the host can update the room')
    if (isLimited(room.hostUpdates, this.clock.now(), TOGETHER_LIMITS.hostUpdates, TOGETHER_LIMITS.hostUpdateWindowMs)) {
      return fail('RATE_LIMITED', 'Too many updates')
    }
    room.hostUpdates.push(this.clock.now())
    return ok(room)
  }

  private bindSocket(room: Room, member: MemberEntry, socket: LX.Socket) {
    member.socket = socket
    member.info.deviceName = socket.keyInfo.deviceName
    if (member.info.online) return
    this.clearGrace(member)
    member.info.online = true
    delete member.info.offlineAt
    room.version++
    this.pushMemberChanged(room, { type: 'online', memberId: member.info.memberId }, member.info.memberId)
  }

  private clearGrace(member: MemberEntry) {
    if (member.graceTimer == null) return
    this.clock.clearTimeout(member.graceTimer)
    member.graceTimer = null
  }

  private handleGraceExpired(roomId: string, memberId: string) {
    const room = this.getRoomOf(memberId)
    if (!room || room.roomId != roomId) return
    const member = room.members.get(memberId)!
    member.graceTimer = null
    if (member.info.online) return
    if (room.hostId == memberId) this.removeHost(room, 'host_timeout')
    else this.removeMember(room, memberId, 'timeout')
  }

  /** The host leaves or times out: earliest-joined online member takes over, otherwise the room closes. */
  private removeHost(room: Room, reason: 'host_left' | 'host_timeout') {
    const previousHostId = room.hostId
    const successor = [...room.members.values()]
      .filter(m => m.info.memberId != previousHostId && m.info.online)
      .sort((a, b) => a.info.joinedAt - b.info.joinedAt)[0]
    if (!successor) {
      this.destroyRoom(room, reason == 'host_left' ? 'empty' : 'host_timeout', previousHostId)
      return
    }
    this.changeHost(room, successor.info.memberId, reason, previousHostId)
    this.removeMember(room, previousHostId, reason == 'host_left' ? 'left' : 'timeout')
  }

  private changeHost(room: Room, hostId: string, reason: LX.Sync.Together.HostChangeReason, exceptMemberId?: string) {
    const previousHostId = room.hostId
    room.hostId = hostId
    room.hostUpdates = []
    room.version++
    const push: LX.Sync.Together.HostChangedPush = { roomId: room.roomId, version: room.version, hostId, previousHostId, reason }
    broadcastRoom(room, async remote => remote['together:onHostChanged'](push), exceptMemberId)
  }

  private removeMember(room: Room, memberId: string, reason: LX.Sync.Together.LeaveReason) {
    const member = room.members.get(memberId)
    if (!member) return
    this.clearGrace(member)
    room.members.delete(memberId)
    this.memberRooms.delete(memberId)
    room.version++
    this.pushMemberChanged(room, { type: 'leave', memberId, reason }, memberId)
  }

  private destroyRoom(room: Room, reason: LX.Sync.Together.CloseReason, exceptMemberId?: string) {
    const push: LX.Sync.Together.RoomClosedPush = { roomId: room.roomId, reason }
    broadcastRoom(room, async remote => remote['together:onRoomClosed'](push), exceptMemberId)
    for (const [memberId, member] of room.members) {
      this.clearGrace(member)
      this.memberRooms.delete(memberId)
    }
    room.members.clear()
    this.rooms.delete(room.code)
  }

  private pushMemberChanged(room: Room, change: LX.Sync.Together.MemberChangedPush['change'], exceptMemberId?: string) {
    const push: LX.Sync.Together.MemberChangedPush = {
      roomId: room.roomId,
      version: room.version,
      members: this.members(room),
      change,
    }
    broadcastRoom(room, async remote => remote['together:onMemberChanged'](push), exceptMemberId)
  }

  private pushRoomState(room: Room, withQueue: boolean) {
    const push: LX.Sync.Together.RoomStatePush = {
      roomId: room.roomId,
      version: room.version,
      serverTime: this.clock.now(),
      playbackVersion: room.playbackVersion,
      playback: { ...room.playback },
      queueVersion: room.queueVersion,
    }
    if (withQueue) push.queue = { items: [...room.queue.items], currentId: room.queue.currentId }
    broadcastRoom(room, async remote => remote['together:onRoomState'](push), room.hostId)
  }

  private members(room: Room): Member[] {
    return [...room.members.values()]
      .map(m => ({ ...m.info }))
      .sort((a, b) => a.joinedAt - b.joinedAt)
  }

  private snapshot(room: Room): Snapshot {
    return {
      roomId: room.roomId,
      code: room.code,
      hostId: room.hostId,
      members: this.members(room),
      maxMembers: room.maxMembers,
      createdAt: room.createdAt,
      version: room.version,
      playbackVersion: room.playbackVersion,
      queueVersion: room.queueVersion,
      playback: { ...room.playback },
      queue: { items: [...room.queue.items], currentId: room.queue.currentId },
      serverTime: this.clock.now(),
    }
  }
}

let manager: RoomManager | null = null

export const getRoomManager = () => {
  manager ??= new RoomManager()
  return manager
}

/** Tests swap in a manager with a fake clock / account lookup. */
export const setRoomManager = (next: RoomManager | null) => {
  manager?.clear()
  manager = next
}
