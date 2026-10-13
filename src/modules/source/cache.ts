import { LRUCache } from 'lru-cache'
import { SOURCE_CACHE } from './protocol'

export type SourceCacheKind = 'url' | 'lyric' | 'pic'

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

const ttlFor = (kind: SourceCacheKind) => {
  switch (kind) {
    case 'url': return SOURCE_CACHE.urlTtlMs
    case 'lyric': return SOURCE_CACHE.lyricTtlMs
    case 'pic': return SOURCE_CACHE.picTtlMs
  }
}

const urlCache = new LRUCache<string, CacheEntry<unknown>>({ max: SOURCE_CACHE.max })
const lyricCache = new LRUCache<string, CacheEntry<unknown>>({ max: SOURCE_CACHE.max })
const picCache = new LRUCache<string, CacheEntry<unknown>>({ max: SOURCE_CACHE.max })

const storeFor = (kind: SourceCacheKind) => {
  switch (kind) {
    case 'url': return urlCache
    case 'lyric': return lyricCache
    case 'pic': return picCache
  }
}

export const getSourceCache = <T>(kind: SourceCacheKind, key: string, now = Date.now()): { value: T, expiresAt: number } | null => {
  const hit = storeFor(kind).get(key) as CacheEntry<T> | undefined
  if (!hit) return null
  if (hit.expiresAt <= now) {
    storeFor(kind).delete(key)
    return null
  }
  return hit
}

export const setSourceCache = <T>(kind: SourceCacheKind, key: string, value: T, now = Date.now()) => {
  const expiresAt = now + ttlFor(kind)
  storeFor(kind).set(key, { value, expiresAt })
  return expiresAt
}

export const clearUrlSourceCache = () => {
  urlCache.clear()
}

export const clearAllSourceCacheForTests = () => {
  urlCache.clear()
  lyricCache.clear()
  picCache.clear()
}
