import type { Clock } from '../../src/modules/together/clock'
import type { TogetherConfig } from '../../src/modules/together/protocol'
import { RoomManager, type MemberAccount } from '../../src/modules/together/roomManage'

export interface Push { method: string, payload: any }

export interface FakeSocket extends LX.Socket {
  pushes: Push[]
  close: () => any
  takePushes: (method?: string) => Push[]
}

export const createFakeClock = (start = 1_000_000) => {
  let now = start
  let seq = 0
  const timers = new Map<number, { at: number, fn: () => void }>()
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: id => { timers.delete(id as number) },
  }
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].fn()
    }
    now = target
  }
  return { clock, advance, pendingTimers: () => timers.size }
}

/** A socket whose `remote` records every push instead of sending it. */
export const createFakeSocket = (clientId: string, userName: string, deviceName = `${clientId}-device`): FakeSocket => {
  const closeHandlers: Array<(err: Error) => void> = []
  const pushes: Push[] = []
  const remote = new Proxy({}, {
    get: (_target, method: string) => async(payload: unknown) => {
      pushes.push({
        method,
        payload: payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)),
      })
    },
  })
  const socket = {
    keyInfo: { clientId, deviceName, key: '', isMobile: true },
    userInfo: { name: userName },
    moduleReadys: { list: false, dislike: false, playHistory: false, together: true },
    feature: { list: false, dislike: false, playHistory: false, together: true },
    remote,
    pushes,
    onClose(handler: (err: Error) => void) {
      closeHandlers.push(handler)
      return () => { closeHandlers.splice(closeHandlers.indexOf(handler), 1) }
    },
    close() {
      for (const handler of closeHandlers.splice(0)) handler(new Error('closed'))
    },
    takePushes(method?: string) {
      const taken = method ? pushes.filter(p => p.method == method) : [...pushes]
      for (const p of taken) pushes.splice(pushes.indexOf(p), 1)
      return taken
    },
  }
  return socket as unknown as FakeSocket
}

export const accounts: Record<string, MemberAccount> = {
  alice: { userId: 'u_alice', username: 'alice', displayName: 'Alice', avatar: '' },
  bob: { userId: 'u_bob', username: 'bob', displayName: 'bob', avatar: 'data:image/png;base64,AA==' },
  carol: { userId: 'u_carol', username: 'carol', displayName: 'carol', avatar: '' },
  dave: { userId: 'u_dave', username: 'dave', displayName: 'dave', avatar: '' },
}

export const createTestManager = (config: Partial<TogetherConfig> = {}) => {
  const fake = createFakeClock()
  const manager = new RoomManager({
    config: { maxMembers: 10, maxRooms: 100, graceMs: 30_000, ...config },
    clock: fake.clock,
    getAccount: socket => accounts[socket.userInfo.name] ?? null,
  })
  return { manager, ...fake }
}

export const song = (id: string, source: LX.OnlineSource = 'kw'): LX.Music.MusicInfoOnline => ({
  id: `${source}_${id}`,
  name: `song ${id}`,
  singer: 'singer',
  source,
  interval: '03:00',
  meta: { songId: id, albumName: 'album', qualitys: [], _qualitys: {} },
} as unknown as LX.Music.MusicInfoOnline)

export const unwrap = <T>(result: LX.Sync.LuxResult<T>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`)
  return result.data
}

export const codeOf = (result: LX.Sync.LuxResult<unknown>) => (result.ok ? 'OK' : result.code)
