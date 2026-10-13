// lux_protocol.d.ts (source + common)
declare namespace LX {
  namespace Sync {
    type LuxErrorCode =
      // common
      | 'INVALID_PARAMS' | 'RATE_LIMITED' | 'INTERNAL'
      // source
      | 'NO_SOURCE'          // 没有启用的脚本声明支持这个 source+action
      | 'ACTION_UNSUPPORTED' // action 不可用（例如没有脚本提供 lyric）
      | 'SOURCE_FAILED'      // 所有尝试都失败了
      | 'TIMEOUT'            // 超过 LUX_SOURCE_TIMEOUT_MS
      // together
      | 'NOT_LUX_ACCOUNT' | 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'ROOM_LIMIT'
      | 'ALREADY_IN_ROOM' | 'NOT_IN_ROOM' | 'NOT_HOST' | 'MEMBER_NOT_FOUND'
      | 'MEMBER_OFFLINE' | 'VERSION_CONFLICT' | 'INVALID_MUSIC'

    type LuxResult<T> =
      | { ok: true, data: T }
      | { ok: false, code: LuxErrorCode, message: string, detail?: unknown }

    namespace Source {
      type Action = 'musicUrl' | 'lyric' | 'pic'

      interface Capability {
        actions: Action[]
        qualitys: LX.Quality[]   // 所有启用脚本对这个 source 声明的音质取并集
      }
      interface Info {
        /** 至少有一个脚本已启用并完成初始化 */
        available: boolean
        sources: Partial<Record<LX.OnlineSource, Capability>>
        proxyStream: boolean     // LUX_SOURCE_PROXY_STREAM
        updatedAt: number
      }

      interface MusicUrlRequest {
        musicInfo: LX.Music.MusicInfoOnline
        quality: LX.Quality      // 期望音质（客户端 getPlayQuality 的结果）
        isRefresh?: boolean      // true = 跳过服务端缓存（播放出错后重试时用）
        allowToggleSource?: boolean           // 默认 true
        toggleCandidates?: LX.Music.MusicInfoOnline[] // 最多 10 条，见 §2.3
      }
      interface MusicUrlResult {
        url: string              // 绝对 http(s) 地址；proxied=true 时是以 /api/source/stream/ 开头的路径
        proxied: boolean
        quality: LX.Quality      // 实际音质
        musicInfo: LX.Music.MusicInfoOnline // 实际解析成功的那首（发生换源时和请求里的不同）
        toggled: boolean
        fromCache: boolean
        expiresAt: number        // 缓存提示：客户端过了这个时间就不要再复用这个 URL
      }

      interface LyricRequest {
        musicInfo: LX.Music.MusicInfoOnline
        isRefresh?: boolean
        allowToggleSource?: boolean
        toggleCandidates?: LX.Music.MusicInfoOnline[]
      }
      interface LyricResult {
        lyric: LX.Music.LyricInfo // { lyric, tlyric?, rlyric?, lxlyric? }
        musicInfo: LX.Music.MusicInfoOnline
        toggled: boolean
        fromCache: boolean
        expiresAt: number
      }

      interface PicRequest {
        musicInfo: LX.Music.MusicInfoOnline
        isRefresh?: boolean
        allowToggleSource?: boolean
        toggleCandidates?: LX.Music.MusicInfoOnline[]
      }
      interface PicResult {
        url: string
        from: 'meta' | 'script'  // meta = 直接用了 musicInfo.meta.picUrl
        musicInfo: LX.Music.MusicInfoOnline
        toggled: boolean
        fromCache: boolean
        expiresAt: number
      }

      interface AttemptError {   // 放在 SOURCE_FAILED / TIMEOUT 的 detail 里，内容为 AttemptError[]
        scriptId: string
        source: LX.OnlineSource
        songId: string           // musicInfo.id
        quality?: LX.Quality
        message: string
      }
    }

    type ServerSyncSourceActions = WarpPromiseRecord<{
      'source:getInfo': () => LuxResult<Source.Info>
      'source:resolveMusicUrl': (req: Source.MusicUrlRequest) => LuxResult<Source.MusicUrlResult>
      'source:resolveLyric': (req: Source.LyricRequest) => LuxResult<Source.LyricResult>
      'source:resolvePic': (req: Source.PicRequest) => LuxResult<Source.PicResult>
    }>
    type ClientSyncSourceActions = WarpPromiseRecord<{
      'source:onInfoChanged': (info: Source.Info) => void
    }>

    type ServerSyncHandlerSourceActions<Socket> = WarpSyncHandlerActions<Socket, ServerSyncSourceActions>
  }
}
