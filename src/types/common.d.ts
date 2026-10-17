declare namespace LX {
  type OnlineSource = 'kw' | 'kg' | 'tx' | 'wy' | 'mg'
  type Source = OnlineSource | 'local'
  type Quality = '128k' | '320k' | 'flac' | 'flac24bit' | '192k' | 'ape' | 'wav'
  type QualityList = Partial<Record<Source, Quality[]>>
  type AddMusicLocationType = 'top' | 'bottom'

  namespace Sync {
    interface Status {
      status: boolean
      message: string
      address: string[]
      // code: string
      devices: KeyInfo[]
    }
    interface KeyInfo {
      clientId: string
      key: string
      sessionId?: string
      origin?: 'account' | 'code'
      deviceName: string
      /** Stable installation identifier supplied by newer clients. */
      deviceId?: string
      /** Fingerprint of the public key used by legacy LX authorization. */
      publicKeyHash?: string
      lastSeen?: number
      lastConnectDate?: number
      isMobile: boolean
    }

    interface ListConfig {
      skipSnapshot: boolean
    }
    interface DislikeConfig {
      skipSnapshot: boolean
    }
    type ServerType = 'desktop-app' | 'server'
    interface EnabledFeatures {
      list?: false | ListConfig
      dislike?: false | DislikeConfig
      /** Lux listening history. Absent on legacy LX clients. */
      playHistory?: false | true
      /** Lux listen together. Absent on legacy LX clients. */
      together?: boolean
      /** Opt in to ephemeral together:onReaction pushes. */
      'together.reaction'?: boolean
    }
    type SupportedFeatures = Partial<{ [k in keyof EnabledFeatures]: number } & {
      /** Optional record fields; does not require separate client enablement. */
      'playHistory.outcome': number
    }>
  }
}
