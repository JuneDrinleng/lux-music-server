import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)
const KEY_LENGTH = 64

export const hashPassword = async(password: string): Promise<string> => {
  const salt = randomBytes(16).toString('base64')
  const key = await scryptAsync(password, salt, KEY_LENGTH) as Buffer
  return `scrypt$${salt}$${key.toString('base64')}`
}

export const hashPasswordSync = (password: string): string => {
  const salt = randomBytes(16).toString('base64')
  const key = scryptSync(password, salt, KEY_LENGTH)
  return `scrypt$${salt}$${key.toString('base64')}`
}

export const verifyPassword = async(password: string, hash: string): Promise<boolean> => {
  const [type, salt, encodedKey] = hash.split('$')
  if (type != 'scrypt' || !salt || !encodedKey) return false

  const expectedKey = Buffer.from(encodedKey, 'base64')
  const actualKey = await scryptAsync(password, salt, expectedKey.length) as Buffer
  return expectedKey.length == actualKey.length && timingSafeEqual(expectedKey, actualKey)
}

export const createSecret = (size = 32) => randomBytes(size).toString('base64url')
