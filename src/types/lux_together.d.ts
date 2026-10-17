// lux_together.d.ts
declare namespace LX {
  namespace Sync {
    namespace Together {
      interface Member {
        memberId: string         // = socket.keyInfo.clientId（按设备区分；同一账号的两台设备算两个成员）
        userId: string           // Lux 账号 id
        username: string
        displayName: string      // 没设置时等于 username
        avatar: string           // 没有就是 ''
        deviceName: string
        joinedAt: number
        online: boolean
        offlineAt?: number
      }
      interface Playback {
        musicInfo: LX.Music.MusicInfoOnline | null // null = 房主停止了 / 正在播本地歌曲
        quality: LX.Quality | null // 房主实际播放的音质，只是提示；成员按自己的设置解析
        isPlaying: boolean
        positionMs: number       // 在 updatedAt 那一刻的进度
        durationMs: number       // 0 = 未知
        updatedAt: number        // 服务端时钟
      }
      interface Queue {
        items: LX.Music.MusicInfoOnline[] // 最多 200 首，只放在线歌曲
        currentId: string | null           // 当前歌曲的 musicInfo.id
      }
      interface RoomSnapshot {
        roomId: string           // UUID，每次开房都不同
        code: string             // 6 位数字邀请码
        hostId: string           // memberId
        members: Member[]        // 按 joinedAt 升序
        maxMembers: number
        createdAt: number
        version: number          // 房间级单调递增，任何变化都 +1
        playbackVersion: number
        queueVersion: number
        playback: Playback
        queue: Queue
        serverTime: number       // 生成这份快照时的 Date.now()
      }

      type CloseReason = 'host_closed' | 'host_timeout' | 'empty'
      type LeaveReason = 'left' | 'timeout' | 'replaced'
      type HostChangeReason = 'transfer' | 'host_left' | 'host_timeout'

      interface HostUpdateStateRequest {
        roomId: string
        baseVersion: number      // 房主最后一次知道的 playbackVersion
        musicInfo: LX.Music.MusicInfoOnline | null
        quality: LX.Quality | null
        isPlaying: boolean
        positionMs: number
        durationMs: number
        sampledAt: number        // 房主采样 positionMs 的时刻，换算成服务端时钟：Date.now() + clockOffsetMs
      }
      interface HostUpdateQueueRequest {
        roomId: string
        baseVersion: number      // queueVersion
        items: LX.Music.MusicInfoOnline[]
        currentId: string | null
      }
      interface UpdateAck { version: number, subVersion: number, updatedAt: number }

      interface PingResult { t0: number, serverTime: number }

      interface RoomStatePush {
        roomId: string
        version: number
        serverTime: number
        playbackVersion: number
        playback: Playback
        queueVersion: number
        queue?: Queue            // 只有队列变化时才带
      }
      interface MemberChangedPush {
        roomId: string
        version: number
        members: Member[]
        change: { type: 'join' | 'leave' | 'online' | 'offline', memberId: string, reason?: LeaveReason }
      }
      interface HostChangedPush {
        roomId: string
        version: number
        hostId: string
        previousHostId: string
        reason: HostChangeReason
      }
      /** Delivered to opted-in room sockets, including the sender; never persisted. */
      interface ReactionPush {
        roomId: string
        memberId: string
        displayName: string
        emoji: string
        at: number
      }
      interface RoomClosedPush { roomId: string, reason: CloseReason }
    }

    type ServerSyncTogetherActions = WarpPromiseRecord<{
      'together:createRoom': () => LuxResult<Together.RoomSnapshot>
      'together:joinRoom': (req: { code: string }) => LuxResult<Together.RoomSnapshot>
      'together:getRoom': () => LuxResult<Together.RoomSnapshot | null>
      'together:leaveRoom': (req: { roomId: string }) => LuxResult<null>
      'together:closeRoom': (req: { roomId: string }) => LuxResult<null>
      'together:hostUpdateState': (req: Together.HostUpdateStateRequest) => LuxResult<Together.UpdateAck>
      'together:hostUpdateQueue': (req: Together.HostUpdateQueueRequest) => LuxResult<Together.UpdateAck>
      'together:transferHost': (req: { roomId: string, memberId: string }) => LuxResult<null>
      'together:reaction': (req: { emoji: string }) => LuxResult<null>
      'together:ping': (req: { t0: number }) => LuxResult<Together.PingResult>
    }>
    type ClientSyncTogetherActions = WarpPromiseRecord<{
      'together:onRoomState': (push: Together.RoomStatePush) => void
      'together:onMemberChanged': (push: Together.MemberChangedPush) => void
      'together:onHostChanged': (push: Together.HostChangedPush) => void
      'together:onReaction': (push: Together.ReactionPush) => void
      'together:onRoomClosed': (push: Together.RoomClosedPush) => void
    }>
  }
}
