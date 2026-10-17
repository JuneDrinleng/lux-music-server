import fs from 'node:fs'
import { randomBytes } from 'node:crypto'

/** Missing stores start empty; existing unreadable/invalid stores must never be overwritten. */
export const loadStoreFile = <T>(filePath: string, label: string, validate: (data: unknown) => data is T, empty: () => T): T => {
  const refuse = (cause: unknown): never => {
    const backupPath = `${filePath}.corrupt-${new Date().toISOString().replace(/:/g, '-')}-${randomBytes(4).toString('hex')}`
    let backupMessage: string
    try {
      fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL)
      backupMessage = `Backup saved to ${backupPath}.`
    } catch (err) {
      backupMessage = `Could not create backup at ${backupPath}: ${String(err)}.`
    }
    const message = `${label} file ${filePath} is corrupt or unreadable. ${backupMessage} Refusing to start; original file was not changed. Restore a known-good backup or move the file away to start fresh.`
    console.error(message, cause)
    throw new Error(message)
  }
  // lstat also detects dangling symlinks, which must not be treated as missing files.
  try {
    fs.lstatSync(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code == 'ENOENT') return empty()
    return refuse(err)
  }
  try {
    const data: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    if (!validate(data)) throw new Error(`Invalid ${label.toLowerCase()} store shape`)
    return data
  } catch (err) {
    return refuse(err)
  }
}
