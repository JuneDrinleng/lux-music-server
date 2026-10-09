export interface ClientAlias extends LX.Sync.KeyInfo {
  deviceClientId: string
}

export interface DevicesInfo {
  userName: string
  clients: Record<string, LX.Sync.KeyInfo>
  clientAliases?: Record<string, ClientAlias>
}

export const deviceActivity = (client: LX.Sync.KeyInfo) => {
  // Device deduplication runs while loading the user module, before the v1 -> v2
  // migration moves each credential's embedded snapshot cursor into list data.
  const legacyLastSyncDate = (client as LX.Sync.KeyInfo & { lastSyncDate?: number }).lastSyncDate
  return Math.max(client.lastSeen ?? 0, client.lastConnectDate ?? 0, legacyLastSyncDate ?? 0)
}

// Names, platform and network addresses are not unique to an installation.
const identity = (client: LX.Sync.KeyInfo) => {
  if (client.deviceId) return `device:${client.deviceId}`
  if (client.publicKeyHash) return `public-key:${client.publicKeyHash}`
  if (client.key) return `key:${client.key}`
  return `client:${client.clientId}`
}

/** Copy device metadata without replacing a credential or its snapshot identity. */
export const updateDeviceMetadata = (target: LX.Sync.KeyInfo, source: LX.Sync.KeyInfo) => {
  target.deviceName = source.deviceName
  target.isMobile = source.isMobile
  if (source.deviceId) target.deviceId = source.deviceId
  if (source.publicKeyHash) target.publicKeyHash = source.publicKeyHash
  if (source.lastSeen !== undefined) target.lastSeen = Math.max(target.lastSeen ?? 0, source.lastSeen)
  if (source.lastConnectDate !== undefined) target.lastConnectDate = Math.max(target.lastConnectDate ?? 0, source.lastConnectDate)
}

/** Keep old credentials as aliases so their independent sync baselines survive. */
export const migrateDevicesInfo = (info: DevicesInfo): DevicesInfo => {
  const clients = new Map(Object.values(info.clients ?? {}).map(client => [client.clientId, { ...client }]))
  const aliases = new Map(Object.values(info.clientAliases ?? {}).map(alias => [alias.clientId, { ...alias }]))
  for (const clientId of clients.keys()) aliases.delete(clientId)

  const promoteAlias = (alias: ClientAlias) => {
    const { deviceClientId, ...client } = alias
    clients.set(client.clientId, client)
    aliases.delete(client.clientId)
  }
  const resolveOwner = (alias: ClientAlias) => {
    let owner = alias.deviceClientId
    const visited = new Set([alias.clientId])
    while (!clients.has(owner)) {
      if (visited.has(owner)) return undefined
      visited.add(owner)
      const parent = aliases.get(owner)
      if (!parent) return undefined
      owner = parent.deviceClientId
    }
    return clients.get(owner)
  }
  // Recover orphaned aliases conservatively, including hand-edited old files.
  for (const alias of aliases.values()) {
    const owner = resolveOwner(alias)
    if (!owner || (alias.deviceId && owner.deviceId && alias.deviceId != owner.deviceId)) promoteAlias(alias)
    else alias.deviceClientId = owner.clientId
  }

  const groups = new Map<string, LX.Sync.KeyInfo[]>()
  for (const client of clients.values()) {
    const key = identity(client)
    const group = groups.get(key) ?? []
    group.push(client)
    groups.set(key, group)
  }
  const canonicalClients = new Map<string, LX.Sync.KeyInfo>()
  const canonicalIds = new Map<string, string>()
  for (const group of groups.values()) {
    const canonical = group.reduce((latest, client) => deviceActivity(client) > deviceActivity(latest) ? client : latest)
    const metadata = [...group, ...[...aliases.values()].filter(alias => group.some(client => client.clientId == alias.deviceClientId))]
    // The canonical metadata already includes previous alias updates. Prefer it
    // on equal timestamps so a restart cannot restore an older alias name.
    metadata.sort((a, b) => deviceActivity(a) - deviceActivity(b) || Number(a.clientId == canonical.clientId) - Number(b.clientId == canonical.clientId))
    // Clone first: updating timestamps must not change the ordering of metadata.
    const merged = { ...canonical }
    for (const client of metadata) updateDeviceMetadata(merged, client)
    // Alias activity updates display metadata, but does not roll back a stable
    // ID or public key subsequently attached to the canonical installation.
    if (canonical.deviceId) merged.deviceId = canonical.deviceId
    if (canonical.publicKeyHash) merged.publicKeyHash = canonical.publicKeyHash
    canonicalClients.set(merged.clientId, merged)
    for (const client of group) {
      canonicalIds.set(client.clientId, merged.clientId)
      if (client.clientId != merged.clientId) aliases.set(client.clientId, { ...client, deviceClientId: merged.clientId })
    }
  }
  for (const alias of aliases.values()) alias.deviceClientId = canonicalIds.get(alias.deviceClientId) ?? alias.deviceClientId

  return {
    ...info,
    clients: Object.fromEntries(canonicalClients),
    ...(aliases.size || info.clientAliases ? { clientAliases: Object.fromEntries(aliases) } : {}),
  }
}
