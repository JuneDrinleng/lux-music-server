import crypto from 'node:crypto'
import { getAccountStore } from '@/account/store'
import { isSocketOpen } from '@/server/socketState'
import { getUserSpace } from '@/user'
import { broadcastRoom } from './broadcast'
import { type Clock, createPingResult, systemClock } from './clock'
import { TOGETHER_LIMITS, type TogetherConfig, readTogetherConfig } from './protocol'
import {
  isFiniteNumber,
  isNonNegativeNumber,
  isQuality,
  isRecord,
  normalizeInviteCode,
  normalizeReactionEmoji,
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
  deviceId: string
  info: Member
  socket: LX.Socket | null
  graceTimer: unknown
  reactions: number[]
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
  requestsVersion: number
  requests: LX.Sync.Together.SongRequest[]
  playback: LX.Sync.Together.Playback
  queue: LX.Sync.Together.Queue
  hostUpdates: number[]
}

export interface RoomManagerOptions {
  config?: Partial<TogetherConfig>
  clock?: Clock
  /** Only active managed Lux accounts may use rooms; legacy `config.users` cannot. */
  getAccount?: (socket: LX.Socket) => MemberAccount | null
  getDeviceClientId?: (socket: LX.Socket) => string
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
  private readonly getDeviceClientId: (socket: LX.Socket) => string
  private readonly rooms = new Map<string, Room>()
  // Resolve credentials by device, while retaining the original public memberId
  // for the lifetime of a membership (including host IDs and push payloads).
  private readonly memberRooms = new Map<string, { code: string, memberId: string }>()
  private readonly socketDeviceIds = new WeakMap<LX.Socket, string>()
  private readonly joinFailures = new Map<string, number[]>()

  constructor(options: RoomManagerOptions = {}) {
    this.config = { ...readTogetherConfig(), ...options.config }
    this.clock = options.clock ?? systemClock
    this.getAccount = options.getAccount ?? getManagedAccount
    this.getDeviceClientId = options.getDeviceClientId ?? (socket => (
      getUserSpace(socket.userInfo.name).dataManage.getDeviceClientId(socket.keyInfo.clientId)
    ))
  }

  // ---- C→S methods ----

  createRoom(socket: LX.Socket): Result<Snapshot> {
    const account = this.getAccount(socket)
    if (!account) return fail('NOT_LUX_ACCOUNT', 'Listen together requires an active Lux account')
    const deviceId = this.getDeviceClientId(socket)
    const memberId = socket.keyInfo.clientId
    if (this.memberRooms.has(deviceId)) return fail('ALREADY_IN_ROOM', 'This device is already in a room')
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
      requestsVersion: 1,
      requests: [],
      playback: { musicInfo: null, quality: null, isPlaying: false, positionMs: 0, durationMs: 0, updatedAt: now },
      queue: { items: [], currentId: null },
      hostUpdates: [],
    }
    room.members.set(memberId, this.createMemberEntry(socket, account, now, deviceId))
    this.rooms.set(code, room)
    this.memberRooms.set(deviceId, { code, memberId })
    return ok(this.snapshot(room, socket))
  }

  joinRoom(socket: LX.Socket, req: unknown): Result<Snapshot> {
    const account = this.getAccount(socket)
    if (!account) return fail('NOT_LUX_ACCOUNT', 'Listen together requires an active Lux account')
    const deviceId = this.getDeviceClientId(socket)
    const memberId = socket.keyInfo.clientId
    const now = this.clock.now()
    let failures = this.joinFailures.get(deviceId)
    if (failures && isLimited(failures, now, TOGETHER_LIMITS.joinFailures, TOGETHER_LIMITS.joinFailureWindowMs)) {
      return fail('RATE_LIMITED', 'Too many failed join attempts, try again later')
    }
    const recordFailure = <T>(result: Result<T>) => {
      if (!failures) this.joinFailures.set(deviceId, failures = [])
      failures.push(now)
      return result
    }

    const code = normalizeInviteCode(isRecord(req) ? req.code : undefined)
    if (!code) return recordFailure(fail('INVALID_PARAMS', 'Invite code must be 6 digits'))

    const current = this.getMembershipOf(deviceId)
    if (current?.room.code == code) {
      const { room, member } = current
      this.bindSocket(room, member, socket)
      return ok(this.snapshot(room, socket))
    }
    if (current) return fail('ALREADY_IN_ROOM', 'This device is already in another room')

    const room = this.rooms.get(code)
    if (!room) return recordFailure(fail('ROOM_NOT_FOUND', 'Room not found'))
    if (room.members.size >= room.maxMembers) return recordFailure(fail('ROOM_FULL', 'Room is full'))

    room.members.set(memberId, this.createMemberEntry(socket, account, now, deviceId))
    this.memberRooms.set(deviceId, { code, memberId })
    room.version++
    this.pushMemberChanged(room, { type: 'join', memberId }, memberId)
    return ok(this.snapshot(room, socket))
  }

  getRoom(socket: LX.Socket): Result<Snapshot | null> {
    if (!this.getAccount(socket)) return fail('NOT_LUX_ACCOUNT', 'Listen together requires an active Lux account')
    const room = this.getMembershipOf(this.getDeviceClientId(socket))?.room
    return ok(room ? this.snapshot(room, socket) : null)
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
    if (r.baseVersion != room.playbackVersion) return fail('VERSION_CONFLICT', 'Playback version conflict', this.snapshot(room, socket))

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

  hostUpdateQueue(socket: LX.Socket, req: unknown, includeHost = false): Result<LX.Sync.Together.UpdateAck> {
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
    if (r.baseVersion != room.queueVersion) return fail('VERSION_CONFLICT', 'Queue version conflict', this.snapshot(room, socket))

    return ok(this.updateQueue(room, { items, currentId: r.currentId as string | null }, includeHost))
  }

  private updateQueue(room: Room, queue: LX.Sync.Together.Queue, includeHost = false): LX.Sync.Together.UpdateAck {
    room.queue = queue
    room.queueVersion++
    room.version++
    this.pushRoomState(room, true, includeHost)
    return { version: room.version, subVersion: room.queueVersion, updatedAt: this.clock.now() }
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

  requestAdd(socket: LX.Socket, req: unknown): Result<null> {
    const found = this.findRequestMember(socket)
    if (!found.ok) return found
    const { room, memberId, member } = found.data
    const song = sanitizeMusicInfo(isRecord(req) ? req.song : undefined)
    if (!song) return fail('INVALID_MUSIC', 'Request must contain an online song')
    if (room.requests.some(request => this.sameSong(request.song, song)) || room.queue.items.some(item => this.sameSong(item, song))) {
      return fail('DUPLICATE_SONG', 'Song is already requested or in the queue')
    }
    if (room.requests.length >= TOGETHER_LIMITS.requestsPerRoom) return fail('REQUEST_LIMIT', 'Room allows at most 30 pending requests')
    if (room.requests.filter(request => request.requestedBy.memberId == memberId).length >= TOGETHER_LIMITS.requestsPerMember) {
      return fail('REQUEST_LIMIT', 'Each member may have at most 3 pending requests')
    }
    room.requests.push({
      id: crypto.randomUUID(), song, requestedBy: { memberId, displayName: member.info.displayName },
      at: this.clock.now(), status: 'pending',
    })
    this.pushRequests(room)
    return ok(null)
  }

  requestApprove(socket: LX.Socket, req: unknown): Result<LX.Sync.Together.UpdateAck> {
    const found = this.findRequestMember(socket, true)
    if (!found.ok) return found
    const { room } = found.data
    if (!isRecord(req) || typeof req.requestId != 'string' || !req.requestId ||
      (req.expectedQueueVersion !== undefined && (!Number.isInteger(req.expectedQueueVersion) || req.expectedQueueVersion < 0))) {
      return fail('INVALID_PARAMS', 'Invalid requestId or expectedQueueVersion')
    }
    const request = room.requests.find(request => request.id == req.requestId)
    if (!request) return fail('REQUEST_NOT_FOUND', 'Pending request not found')
    if (req.expectedQueueVersion !== undefined && req.expectedQueueVersion != room.queueVersion) {
      return fail('VERSION_CONFLICT', 'Queue version conflict', this.snapshot(room, socket))
    }
    if (room.queue.items.some(item => this.sameSong(item, request.song))) return fail('DUPLICATE_SONG', 'Song is already in the queue')
    // Reuse host queue validation, rate limiting and mutation; no await between lookup and removal.
    const result = this.hostUpdateQueue(socket, {
      roomId: room.roomId, baseVersion: room.queueVersion,
      items: [...room.queue.items, request.song], currentId: room.queue.currentId,
    }, true)
    if (!result.ok) return result
    room.requests = room.requests.filter(item => item.id != request.id)
    this.pushRequests(room)
    return ok({ ...result.data, version: room.version })
  }

  requestReject(socket: LX.Socket, req: unknown): Result<null> {
    return this.dropRequest(socket, req, true)
  }

  requestRemove(socket: LX.Socket, req: unknown): Result<null> {
    return this.dropRequest(socket, req, false)
  }

  requestReorder(socket: LX.Socket, req: unknown): Result<null> {
    const found = this.findRequestMember(socket, true)
    if (!found.ok) return found
    const { room } = found.data
    const ids = isRecord(req) ? req.requestIds : undefined
    if (!Array.isArray(ids) || ids.length != room.requests.length || new Set(ids).size != ids.length ||
      Array.from(ids).some(id => typeof id != 'string' || !room.requests.some(request => request.id == id))) {
      return fail('INVALID_PARAMS', 'requestIds must be a permutation of pending request ids')
    }
    room.requests = ids.map(id => room.requests.find(request => request.id == id)!)
    this.pushRequests(room)
    return ok(null)
  }

  private findRequestMember(socket: LX.Socket, hostOnly = false) {
    if (!this.getAccount(socket)) return fail('NOT_LUX_ACCOUNT', 'Listen together requires an active Lux account')
    const found = this.getMembershipOf(this.getDeviceClientId(socket))
    if (!found || found.member.socket !== socket || !found.member.info.online || !isSocketOpen(socket)) {
      return fail('NOT_IN_ROOM', 'Not an active member of a room')
    }
    if (hostOnly && found.room.hostId != found.memberId) return fail('NOT_HOST', 'Only the host can manage requests')
    return ok(found)
  }

  private dropRequest(socket: LX.Socket, req: unknown, hostOnly: boolean): Result<null> {
    const found = this.findRequestMember(socket, hostOnly)
    if (!found.ok) return found
    const { room, memberId } = found.data
    if (!isRecord(req) || typeof req.requestId != 'string' || !req.requestId) return fail('INVALID_PARAMS', 'requestId must be a non-empty string')
    const request = room.requests.find(request => request.id == req.requestId)
    if (!request) return fail('REQUEST_NOT_FOUND', 'Pending request not found')
    if (room.hostId != memberId && request.requestedBy.memberId != memberId) return fail('NOT_REQUESTER', 'Only the requester or host can remove a request')
    room.requests = room.requests.filter(item => item.id != request.id)
    this.pushRequests(room)
    return ok(null)
  }

  private sameSong(a: LX.Music.MusicInfoOnline, b: LX.Music.MusicInfoOnline) {
    return a.id == b.id && a.source == b.source
  }

  private requests(room: Room): LX.Sync.Together.SongRequest[] {
    return JSON.parse(JSON.stringify(room.requests))
  }

  private pushRequests(room: Room) {
    room.requestsVersion++
    room.version++
    const push: LX.Sync.Together.RequestsPush = { roomId: room.roomId, requests: this.requests(room), version: room.requestsVersion }
    broadcastRoom(room, async remote => remote['together:onRequests'](push), undefined, 'together.request')
  }

  reaction(socket: LX.Socket, req: unknown): Result<null> {
    if (!this.getAccount(socket)) return fail('NOT_LUX_ACCOUNT', 'Listen together requires an active Lux account')
    const found = this.getMembershipOf(this.getDeviceClientId(socket))
    if (!found || found.member.socket !== socket || !found.member.info.online || !isSocketOpen(socket)) {
      return fail('NOT_IN_ROOM', 'Not an active member of a room')
    }
    const emoji = normalizeReactionEmoji(isRecord(req) ? req.emoji : undefined)
    if (!emoji) return fail('INVALID_PARAMS', 'emoji must be a supported reaction')
    const { room, memberId, member } = found
    const now = this.clock.now()
    const hits = member.reactions
    if (isLimited(hits, now, TOGETHER_LIMITS.reactionsPerMinute, TOGETHER_LIMITS.reactionMinuteMs) ||
      hits.filter(at => at > now - TOGETHER_LIMITS.reactionWindowMs).length >= TOGETHER_LIMITS.reactions) {
      return fail('RATE_LIMITED', 'Too many reactions (maximum 5 per 3 seconds and 60 per minute)')
    }
    hits.push(now)
    const push: LX.Sync.Together.ReactionPush = { roomId: room.roomId, memberId, displayName: member.info.displayName, emoji, at: now }
    // Ephemeral: include the sender when opted in; never change room state or versions.
    broadcastRoom(room, async remote => remote['together:onReaction'](push), undefined, 'together.reaction')
    return ok(null)
  }

  ping(req: unknown): Result<LX.Sync.Together.PingResult> {
    const t0 = isRecord(req) ? req.t0 : undefined
    if (!isFiniteNumber(t0)) return fail('INVALID_PARAMS', 't0 must be a number')
    return ok(createPingResult(t0, this.clock))
  }

  // ---- connection lifecycle (§4.5) ----

  /** A new socket for the same device finished `togetherModule.sync`: rebind it within the grace period. */
  handleSocketReady(socket: LX.Socket) {
    if (!isSocketOpen(socket)) return
    const found = this.getMembershipOf(this.getDeviceClientId(socket))
    if (!found) return
    this.bindSocket(found.room, found.member, socket)
  }

  handleSocketClosed(socket: LX.Socket) {
    // Credentials or even the account directory may already have been removed.
    // Lifecycle cleanup must use the identity bound while the session was live.
    const deviceId = this.socketDeviceIds.get(socket)
    if (!deviceId) return
    const found = this.getMembershipOf(deviceId)
    if (!found) return
    const { room, memberId, member } = found
    // A replacement socket (checkDuplicateClient) may already be bound.
    if (member.socket !== socket) return
    const now = this.clock.now()
    member.socket = null
    member.info.online = false
    member.info.offlineAt = now
    this.clearGrace(member)
    const roomId = room.roomId
    member.graceTimer = this.clock.setTimeout(() => {
      this.handleGraceExpired(roomId, member.deviceId)
    }, this.config.graceMs)
    room.version++
    this.pushMemberChanged(room, { type: 'offline', memberId }, memberId)
  }

  /** Feature disable or failed sync leaves immediately, without the disconnect grace period. */
  handleSocketDisabled(socket: LX.Socket) {
    const deviceId = this.socketDeviceIds.get(socket)
    if (!deviceId) return
    const found = this.getMembershipOf(deviceId)
    // An old session must not remove the membership of its replacement.
    if (!found || found.member.socket !== socket) return
    const { room, memberId } = found
    if (room.hostId == memberId) this.removeHost(room, 'host_left')
    else this.removeMember(room, memberId, 'left')
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

  /** Remove every room membership for a deleted Lux account (all devices). */
  evictUser(userId: string) {
    for (const room of [...this.rooms.values()]) {
      while (true) {
        const memberId = [...room.members.entries()].find(([, member]) => member.info.userId == userId)?.[0]
        if (!memberId) break
        if (room.hostId == memberId) this.removeHost(room, 'host_left')
        else this.removeMember(room, memberId, 'left')
      }
    }
  }

  // ---- internals ----

  private generateCode() {
    for (;;) {
      const code = String(crypto.randomInt(100000, 1000000))
      if (!this.rooms.has(code)) return code
    }
  }

  private createMemberEntry(socket: LX.Socket, account: MemberAccount, now: number, deviceId: string): MemberEntry {
    this.socketDeviceIds.set(socket, deviceId)
    return {
      deviceId,
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
      reactions: [],
    }
  }

  private getMembershipOf(deviceId: string) {
    const membership = this.memberRooms.get(deviceId)
    if (!membership) return null
    const room = this.rooms.get(membership.code)
    const member = room?.members.get(membership.memberId)
    return room && member ? { room, memberId: membership.memberId, member } : null
  }

  private findMembership(socket: LX.Socket, req: unknown): Result<{ room: Room, memberId: string }> {
    if (!this.getAccount(socket)) return fail('NOT_LUX_ACCOUNT', 'Listen together requires an active Lux account')
    const found = this.getMembershipOf(this.getDeviceClientId(socket))
    const roomId = isRecord(req) ? req.roomId : undefined
    if (!found || found.room.roomId !== roomId) return fail('NOT_IN_ROOM', 'Not in this room')
    return ok({ room: found.room, memberId: found.memberId })
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
    if (!isSocketOpen(socket)) return
    this.socketDeviceIds.set(socket, member.deviceId)
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

  private handleGraceExpired(roomId: string, deviceId: string) {
    const found = this.getMembershipOf(deviceId)
    if (!found || found.room.roomId != roomId) return
    const { room, memberId, member } = found
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
    this.memberRooms.delete(member.deviceId)
    const remaining = room.requests.filter(request => request.requestedBy.memberId != memberId)
    if (remaining.length != room.requests.length) {
      room.requests = remaining
      this.pushRequests(room)
    }
    room.version++
    this.pushMemberChanged(room, { type: 'leave', memberId, reason }, memberId)
  }

  private destroyRoom(room: Room, reason: LX.Sync.Together.CloseReason, exceptMemberId?: string) {
    const push: LX.Sync.Together.RoomClosedPush = { roomId: room.roomId, reason }
    broadcastRoom(room, async remote => remote['together:onRoomClosed'](push), exceptMemberId)
    for (const member of room.members.values()) {
      this.clearGrace(member)
      this.memberRooms.delete(member.deviceId)
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

  private pushRoomState(room: Room, withQueue: boolean, includeHost = false) {
    const push: LX.Sync.Together.RoomStatePush = {
      roomId: room.roomId,
      version: room.version,
      serverTime: this.clock.now(),
      playbackVersion: room.playbackVersion,
      playback: { ...room.playback },
      queueVersion: room.queueVersion,
    }
    if (withQueue) push.queue = { items: [...room.queue.items], currentId: room.queue.currentId }
    broadcastRoom(room, async remote => remote['together:onRoomState'](push), includeHost ? undefined : room.hostId)
  }

  private members(room: Room): Member[] {
    return [...room.members.values()]
      .map(m => ({ ...m.info }))
      .sort((a, b) => a.joinedAt - b.joinedAt)
  }

  private snapshot(room: Room, socket: LX.Socket): Snapshot {
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
      ...(socket.feature['together.request'] ? { requests: this.requests(room), requestsVersion: room.requestsVersion } : {}),
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
