export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value == 'object' && value != null

export const getString = (value: unknown) => typeof value == 'string' ? value.trim() : ''

export const getOptionalString = (value: unknown) => {
  const text = getString(value)
  return text || undefined
}

/** Script bodies must not be trimmed — whitespace can matter for hashes and some headers. */
export const getRawString = (value: unknown) => typeof value == 'string' ? value : ''

export const decodeScriptBase64 = (value: unknown): string | null => {
  const raw = getRawString(value).trim()
  if (!raw) return null
  let decoded: string
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8')
  } catch {
    throw new Error('scriptBase64 is not valid base64')
  }
  if (!decoded.length) throw new Error('scriptBase64 decoded to empty content')
  return decoded
}

export const getNumber = (value: unknown) => {
  if (typeof value == 'number') return value
  if (typeof value == 'string') {
    const num = Number(value)
    return Number.isFinite(num) ? num : undefined
  }
  return undefined
}
