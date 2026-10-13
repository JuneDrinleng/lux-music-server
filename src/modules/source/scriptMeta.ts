import crypto from 'node:crypto'

const INFO_NAMES = {
  name: 24,
  description: 36,
  author: 56,
  homepage: 1024,
  version: 36,
} as const

export type ScriptMetaFields = Record<keyof typeof INFO_NAMES, string>

export const scriptIdFromContent = (script: string) => `src_${crypto.createHash('sha256').update(script).digest('hex').slice(0, 16)}`

export const parseScriptMeta = (script: string): ScriptMetaFields => {
  const match = /^\s*\/\*[\S|\s]+?\*\//.exec(script)
  if (!match) throw new Error('script header comment is required (/** @name … */ at the top)')

  const infos: Partial<ScriptMetaFields> = {}
  const rxp = /^\s?\*\s?@(\w+)\s(.+)$/
  for (const line of match[0].split(/\r?\n/)) {
    const result = rxp.exec(line)
    if (!result) continue
    const key = result[1] as keyof typeof INFO_NAMES
    if (INFO_NAMES[key] == null) continue
    infos[key] = result[2].trim()
  }

  for (const [key, len] of Object.entries(INFO_NAMES) as Array<[keyof typeof INFO_NAMES, number]>) {
    let value = infos[key] ?? ''
    if (key == 'name' && !value) value = 'unknown'
    if (value.length > len) value = `${value.slice(0, len)}...`
    infos[key] = value
  }
  return infos as ScriptMetaFields
}

export const sha256Hex = (script: string) => crypto.createHash('sha256').update(script).digest('hex')
