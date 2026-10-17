import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

// Synchronous so callers (including async account operations) cannot reorder saves.
export const atomicWriteFileSync = (filePath: string, content: string) => {
  const tempPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  let file: number | undefined
  let directory: number | undefined
  let tempCreated = false
  try {
    file = fs.openSync(tempPath, 'wx', 0o600)
    tempCreated = true
    fs.writeFileSync(file, content, 'utf-8')
    fs.fsyncSync(file)
    fs.closeSync(file)
    file = undefined
    fs.renameSync(tempPath, filePath)
    tempCreated = false

    try {
      directory = fs.openSync(path.dirname(filePath), 'r')
      fs.fsyncSync(directory)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code != 'EINVAL' && code != 'EPERM') throw err
    }
  } finally {
    if (file !== undefined) fs.closeSync(file)
    if (directory !== undefined) fs.closeSync(directory)
    if (tempCreated) fs.unlinkSync(tempPath)
  }
}
