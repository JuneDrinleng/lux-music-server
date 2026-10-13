import log4js from 'log4js'

const logger = log4js.getLogger('source')
const warned = new Set<string>()
const warnOnce = (name: string, raw: string, message: string) => {
  const key = `${name}=${raw}`
  if (warned.has(key)) return
  warned.add(key)
  logger.warn(message)
}

export interface SourceSettings {
  timeoutMs: number
  memoryMb: number
  proxyStream: boolean
}

const readInt = (name: string, defaultValue: number, min: number, max: number) => {
  const raw = process.env[name]
  if (raw == null || raw === '') return defaultValue
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    warnOnce(name, raw, `${name}=${raw} is invalid (expected integer ${min}-${max}), using ${defaultValue}`)
    return defaultValue
  }
  return value
}

const readBool = (name: string, defaultValue: boolean) => {
  const raw = process.env[name]
  if (raw == null || raw === '') return defaultValue
  const value = raw.trim().toLowerCase()
  if (value == 'true' || value == '1') return true
  if (value == 'false' || value == '0') return false
  warnOnce(name, raw, `${name}=${raw} is invalid (expected true/false/1/0), using ${String(defaultValue)}`)
  return defaultValue
}

/** Read on every call so tests and restarts see the current process.env. */
export const getSourceSettings = (): SourceSettings => ({
  timeoutMs: readInt('LUX_SOURCE_TIMEOUT_MS', 15000, 1000, 60000),
  memoryMb: readInt('LUX_SOURCE_MEMORY_MB', 128, 32, 1024),
  proxyStream: readBool('LUX_SOURCE_PROXY_STREAM', false),
})
