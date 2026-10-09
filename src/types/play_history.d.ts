declare namespace LX {
  namespace Sync {
    namespace PlayHistory {
      interface Song {
        source: string
        songmid: string
        name: string
        singer: string
        albumName?: string
        interval?: string
        img?: string
      }

      interface Record {
        id: string
        deviceId: string
        startedAt: number
        endedAt: number
        listenedMs: number
        song: Song
      }

      interface PushRequest {
        records: Record[]
      }

      interface PushResult {
        accepted: number
        ignored: number
        cursor: number
      }

      interface PullRequest {
        since?: number
      }

      interface PullResult {
        records: Record[]
        cursor: number
        hasMore: boolean
      }
    }
  }
}
