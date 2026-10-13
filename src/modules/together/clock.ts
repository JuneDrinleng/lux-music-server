export interface Clock {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: timer => { clearTimeout(timer as NodeJS.Timeout) },
}

/** Clients compute offset = serverTime - (t0 + t1) / 2 from the lowest-RTT sample (§4.6). */
export const createPingResult = (t0: number, clock: Clock = systemClock): LX.Sync.Together.PingResult => ({
  t0,
  serverTime: clock.now(),
})
