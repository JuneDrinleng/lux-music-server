import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { throttle } from '@/utils/common'
import { filterFileName, toMD5 } from '@/utils'
import { File } from '@/constants'
import { deviceActivity, migrateDevicesInfo, updateDeviceMetadata, type DevicesInfo } from './deviceIdentity'


interface ServerInfo {
  serverId: string
  version: number
}
const serverInfoFilePath = path.join(global.lx.dataPath, File.serverInfoJSON)
const saveServerInfoThrottle = throttle(() => {
  fs.writeFile(serverInfoFilePath, JSON.stringify(serverInfo), 'utf8', (err) => {
    if (err) console.error(err)
  })
})
let serverInfo: ServerInfo
if (fs.existsSync(serverInfoFilePath)) {
  serverInfo = JSON.parse(fs.readFileSync(serverInfoFilePath).toString())
} else {
  serverInfo = {
    serverId: randomBytes(4 * 4).toString('base64'),
    version: 2,
  }
  saveServerInfoThrottle()
}
export const getServerId = (): string => {
  return serverInfo.serverId
}
export const getVersion = () => {
  return serverInfo.version ?? 1
}
export const setVersion = (version: number) => {
  serverInfo.version = version
  saveServerInfoThrottle()
}

export const getUserDirname = (userName: string) => `${filterFileName(userName)}_${toMD5(userName).substring(0, 6)}`

export const getUserConfig = (userName: string): Required<LX.User> => {
  const user = global.lx.config.users.find(u => u.name == userName)
  if (!user) throw new Error('user not found: ' + userName)
  return {
    maxSnapshotNum: global.lx.config.maxSnapshotNum,
    'list.addMusicLocationType': global.lx.config['list.addMusicLocationType'],
    ...user,
  }
}

// Credentials must be durable before being returned to a client. A delayed write
// can lose a newly issued key on restart, and concurrent writes can restore stale
// device entries. Rename also prevents startup from reading a partial JSON file.
const saveDevicesInfo = (filePath: string, info: DevicesInfo) => {
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
  }
}

const loadDevicesInfo = (filePath: string): DevicesInfo => {
  const original = JSON.parse(fs.readFileSync(filePath, 'utf8')) as DevicesInfo
  const migrated = migrateDevicesInfo(original)
  if (JSON.stringify(original) != JSON.stringify(migrated)) saveDevicesInfo(filePath, migrated)
  return migrated
}

const ownValue = <T>(entries: Record<string, T> | undefined, id: string): T | undefined => {
  return entries && Object.prototype.hasOwnProperty.call(entries, id) ? entries[id] : undefined
}


// 读取所有用户目录下的devicesInfo信息，建立clientId与用户的对应关系，用于非首次连接
const deviceUserMap = new Map<string, string>()
for (const dirname of fs.readdirSync(global.lx.userPath)) {
  const devicesFilePath = path.join(global.lx.userPath, dirname, File.userDevicesJSON)
  if (!fs.existsSync(devicesFilePath)) continue
  const devicesInfo = loadDevicesInfo(devicesFilePath)
  if (getUserDirname(devicesInfo.userName) != dirname) continue
  for (const device of [...Object.values(devicesInfo.clients), ...Object.values(devicesInfo.clientAliases ?? {})]) {
    deviceUserMap.set(device.clientId, devicesInfo.userName)
  }
}
export const getUserName = (clientId: string | null): string | null => {
  if (!clientId) return null
  return deviceUserMap.get(clientId) ?? null
}
export const setUserName = (clientId: string, dir: string) => {
  deviceUserMap.set(clientId, dir)
}
export const deleteUserName = (clientId: string) => {
  deviceUserMap.delete(clientId)
}

export const createClientKeyInfo = (deviceName: string, isMobile: boolean): LX.Sync.KeyInfo => {
  const keyInfo: LX.Sync.KeyInfo = {
    clientId: randomBytes(4 * 4).toString('base64'),
    key: randomBytes(16).toString('base64'),
    deviceName,
    isMobile,
    lastConnectDate: 0,
  }
  return keyInfo
}

export class UserDataManage {
  userName: string
  userDir: string
  devicesFilePath: string
  devicesInfo: DevicesInfo

  private saveDevicesInfo = () => saveDevicesInfo(this.devicesFilePath, this.devicesInfo)

  getAllClientKeyInfo = () => {
    return Object.values(this.devicesInfo.clients).sort((a, b) => deviceActivity(b) - deviceActivity(a))
  }

  saveClientKeyInfo = (keyInfo: LX.Sync.KeyInfo, updatePublicKeyHash = false) => {
    const alias = ownValue(this.devicesInfo.clientAliases, keyInfo.clientId)
    const canonical = this.getClientKeyInfo(alias?.deviceClientId ?? keyInfo.clientId)
    if (!canonical && Object.keys(this.devicesInfo.clients).length > 101) throw new Error('max keys')
    if (canonical?.deviceId && keyInfo.deviceId && canonical.deviceId != keyInfo.deviceId) throw new Error('Conflicting device identity')
    keyInfo.lastSeen = Math.max(keyInfo.lastSeen ?? 0, Date.now())
    if (alias) {
      this.devicesInfo.clientAliases![keyInfo.clientId] = { ...keyInfo, deviceClientId: alias.deviceClientId }
      if (canonical) updateDeviceMetadata(canonical, {
        ...keyInfo,
        // A reconnect with an old credential must not undo a newer key pairing.
        publicKeyHash: updatePublicKeyHash ? keyInfo.publicKeyHash : canonical.publicKeyHash ?? keyInfo.publicKeyHash,
      })
    } else this.devicesInfo.clients[keyInfo.clientId] = keyInfo
    setUserName(keyInfo.clientId, this.userName)
    this.saveDevicesInfo()
  }

  upsertClientKeyInfo = ({ deviceId, clientId, publicKeyHash, deviceName, isMobile }: {
    deviceId?: string
    clientId?: string
    publicKeyHash?: string
    deviceName?: string
    isMobile?: boolean
  }): LX.Sync.KeyInfo => {
    const existingCredential = this.getClientKeyInfo(clientId ?? null)
    const existingDevice = existingCredential ? this.getClientKeyInfo(this.getDeviceClientId(existingCredential.clientId)) : null
    const byDeviceId = deviceId ? this.getAllClientKeyInfo().find(client => client.deviceId == deviceId) : undefined
    if (existingDevice && deviceId && ((existingDevice.deviceId && existingDevice.deviceId != deviceId) || (byDeviceId && byDeviceId.clientId != existingDevice.clientId))) {
      throw new Error('Conflicting device identity')
    }
    // Reusing a known credential is also evidence for attaching a stable ID to
    // an older installation. Unknown client IDs never become server credentials.
    let keyInfo = existingCredential ?? byDeviceId
    if (!keyInfo && publicKeyHash) {
      const credentials = [...this.getAllClientKeyInfo(), ...Object.values(this.devicesInfo.clientAliases ?? {})]
      const matchingIds = new Set(credentials.filter(client => client.publicKeyHash == publicKeyHash).map(client => this.getDeviceClientId(client.clientId)))
      const matches = this.getAllClientKeyInfo().filter(client => matchingIds.has(client.clientId) && (!deviceId || !client.deviceId || client.deviceId == deviceId))
      // An ambiguous key shared by several explicitly distinct installations
      // must not pick an arbitrary device.
      if (matches.length == 1) {
        const deviceClientId = matches[0].clientId
        keyInfo = credentials.find(client => client.publicKeyHash == publicKeyHash && this.getDeviceClientId(client.clientId) == deviceClientId)
      }
    }
    if (!keyInfo) keyInfo = createClientKeyInfo(deviceName ?? 'Unknown', isMobile ?? true)
    else {
      const device = this.getClientKeyInfo(this.getDeviceClientId(keyInfo.clientId))!
      // A historical credential carries historical display metadata. Omitted
      // request fields must preserve the current device, even for an alias.
      keyInfo = { ...keyInfo, deviceName: device.deviceName, isMobile: device.isMobile }
    }
    if (deviceId) keyInfo.deviceId = deviceId
    if (publicKeyHash) keyInfo.publicKeyHash = publicKeyHash
    if (deviceName !== undefined) keyInfo.deviceName = deviceName
    if (isMobile !== undefined) keyInfo.isMobile = isMobile
    this.saveClientKeyInfo(keyInfo, publicKeyHash !== undefined)
    return keyInfo
  }

  getClientKeyInfo = (clientId: string | null): LX.Sync.KeyInfo | null => {
    if (!clientId) return null
    return ownValue(this.devicesInfo.clients, clientId) ?? ownValue(this.devicesInfo.clientAliases, clientId) ?? null
  }

  getDeviceClientId = (clientId: string): string => {
    return ownValue(this.devicesInfo.clientAliases, clientId)?.deviceClientId ?? clientId
  }

  getDeviceClientIds = (clientId: string): string[] => {
    const deviceClientId = this.getDeviceClientId(clientId)
    if (!ownValue(this.devicesInfo.clients, deviceClientId)) return []
    return [deviceClientId, ...Object.values(this.devicesInfo.clientAliases ?? {}).filter(alias => alias.deviceClientId == deviceClientId).map(alias => alias.clientId)]
  }

  removeClientKeyInfo = async(clientId: string) => {
    for (const id of this.getDeviceClientIds(clientId)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this.devicesInfo.clients[id]
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      if (this.devicesInfo.clientAliases) delete this.devicesInfo.clientAliases[id]
      deleteUserName(id)
    }
    this.saveDevicesInfo()
  }

  isIncluedsClient = (clientId: string) => {
    return this.getClientKeyInfo(clientId) != null
  }

  constructor(userName: string) {
    this.userName = userName
    this.userDir = path.join(global.lx.userPath, getUserDirname(userName))
    fs.mkdirSync(this.userDir, { recursive: true })
    this.devicesFilePath = path.join(this.userDir, File.userDevicesJSON)
    this.devicesInfo = fs.existsSync(this.devicesFilePath) ? loadDevicesInfo(this.devicesFilePath) : { userName, clients: {} }
    for (const client of [...Object.values(this.devicesInfo.clients), ...Object.values(this.devicesInfo.clientAliases ?? {})]) setUserName(client.clientId, userName)
  }
}
// type UserDataManages = Map<string, UserDataManage>

// export const createUserDataManage = (user: LX.UserConfig) => {
//   const manage = Object.create(userDataManage) as typeof userDataManage
//   manage.userDir = user.dataPath
// }
