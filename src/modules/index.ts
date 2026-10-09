import { sync as listSync } from './list'
import { sync as dislikeSync } from './dislike'
import { sync as playHistorySync } from './playHistory'
import { PLAY_HISTORY_FEATURE_VERSION } from './playHistory/protocol'

export const callObj = Object.assign({},
  listSync.handler,
  dislikeSync.handler,
  playHistorySync.handler,
)

export const modules = {
  list: listSync,
  dislike: dislikeSync,
}

/** Not part of `modules`: list/dislike register local events from that map. */
export const playHistoryModule = playHistorySync


export { ListManage, ListEvent, type ListEventType } from './list'

export { DislikeManage, DislikeEvent, type DislikeEventType } from './dislike'

export { PlayHistoryManage } from './playHistory'

export const featureVersion = {
  list: 1,
  dislike: 1,
  // Lux only. Legacy clients compare list/dislike by exact version and ignore unknown keys.
  playHistory: PLAY_HISTORY_FEATURE_VERSION,
} as const
