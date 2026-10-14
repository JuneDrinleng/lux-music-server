/**
 * LX 2.x apps send `MusicInfoOnline` (ids in meta). User scripts (e.g. 野花) expect
 * LX 1.x-style fields on the same object (`songmid`, `hash`, …) — see mobile `toOldMusicInfo`.
 */
export const normalizeScriptMusicInfo = (musicInfo: LX.Music.MusicInfoOnline): LX.Music.MusicInfoOnline => {
  const meta = musicInfo.meta as Record<string, unknown>
  const songmid = String(meta.songId ?? musicInfo.id)
  const enriched: Record<string, unknown> = {
    ...musicInfo,
    songmid,
    albumName: meta.albumName,
  }
  switch (musicInfo.source) {
    case 'kg':
      if (typeof meta.hash == 'string' && meta.hash) enriched.hash = meta.hash
      break
    case 'tx':
      if (typeof meta.strMediaMid == 'string' && meta.strMediaMid) enriched.strMediaMid = meta.strMediaMid
      if (meta.id != null && meta.id !== '') enriched.songId = meta.id
      if (typeof meta.albumMid == 'string' && meta.albumMid) enriched.albumMid = meta.albumMid
      break
    case 'mg':
      if (typeof meta.copyrightId == 'string' && meta.copyrightId) enriched.copyrightId = meta.copyrightId
      break
    default:
      break
  }
  return enriched as LX.Music.MusicInfoOnline
}
