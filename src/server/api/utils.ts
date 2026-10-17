export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value == 'object' && value != null

export const getString = (value: unknown) => typeof value == 'string' ? value.trim() : ''

export const getOptionalString = (value: unknown) => {
  const text = getString(value)
  return text || undefined
}

export const getNumber = (value: unknown) => {
  if (typeof value == 'number') return value
  if (typeof value == 'string') {
    const num = Number(value)
    return Number.isFinite(num) ? num : undefined
  }
  return undefined
}
