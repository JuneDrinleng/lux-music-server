import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import log4js from 'log4js'
import { getAccountStore } from '../../../src/account/store'
import { File } from '../../../src/constants'
import { createModuleEvent } from '../../../src/event'
import { RoomManager, setRoomManager } from '../../../src/modules/together'
import { startServerForTests } from '../../../src/server/server'
import { getUserDirname, getUserSpace, releaseUserSpace } from '../../../src/user'
import { resetTestState } from '../../helpers'
import { createFakeClock } from '../fakes'
import { TogetherClient, loginAndGetKey, type ClientOptions, type Credentials } from './client'

/** One real server per file; each case gets fresh rooms, clocks and sockets. */
export const createFixture = async() => {
  const clients = new Set<TogetherClient>()
  const userNames: string[] = []
  let server: Awaited<ReturnType<typeof startServerForTests>> | undefined
  let closed = false
  const closeClients = async() => {
    const settled = await Promise.allSettled([...clients].map(async client => client.close()))
    const errors: unknown[] = settled.flatMap(result => result.status == 'rejected' ? [result.reason] : [])
    clients.clear()
    try { setRoomManager(null) } catch (error) { errors.push(error) }
    for (const userName of userNames) {
      try { releaseUserSpace(userName, true) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Failed to clean up together clients')
  }
  const close = async() => {
    if (closed) return
    closed = true
    const errors: unknown[] = []
    try { await closeClients() } catch (error) { errors.push(error) }
    try { await server?.close() } catch (error) { errors.push(error) }
    // Server termination can schedule delayed user cleanup after client cleanup.
    for (const userName of userNames) {
      try { releaseUserSpace(userName, true) } catch (error) { errors.push(error) }
    }
    try {
      await new Promise<void>((resolve, reject) => log4js.shutdown(error => error ? reject(error) : resolve()))
    } catch (error) { errors.push(error) }
    try {
      const root = (global as typeof globalThis & { __LUX_TEST_ROOT__?: string }).__LUX_TEST_ROOT__
      if (root) fs.rmSync(root, { recursive: true, force: true })
    } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Failed to clean up together fixture')
  }

  try {
    const unusedApp = resetTestState()
    await unusedApp.close()
    createModuleEvent()
    server = await startServerForTests()
    const baseUrl = `http://127.0.0.1:${server.port}`
    const password = 'together-e2e-password'
    const host = await getAccountStore().createUser({ username: 'e2e-host', password, role: 'admin', displayName: 'Host' })
    userNames.push(host.username)
    const member = await getAccountStore().createUser({ username: 'e2e-member', password, role: 'user', displayName: 'Listener' })
    userNames.push(member.username)
    const users = { host, member }
    const credentials = {
      host: await loginAndGetKey(baseUrl, users.host.username, password, { deviceId: 'host-installation', deviceName: 'Host device' }),
      member: await loginAndGetKey(baseUrl, users.member.username, password, { deviceId: 'member-installation', deviceName: 'Member device' }),
    }
    let fake = createFakeClock()

    const reset = () => {
      fake = createFakeClock()
      // Existing test seam: keep real managed-account lookup and room logic; only
      // the room clock is fake. HTTP, sockets, zlib and RPC timeouts stay real.
      setRoomManager(new RoomManager({
        clock: fake.clock,
        config: { maxMembers: 10, maxRooms: 100, graceMs: 30_000 },
      }))
    }
    return {
      baseUrl, users, credentials, reset, closeClients,
      now: () => fake.clock.now(),
      advance: (ms: number) => { fake.advance(ms) },
      pendingTimers: () => fake.pendingTimers(),
      async connect(who: keyof typeof users, options: ClientOptions = {}, ready = true, key: Credentials = credentials[who]) {
        const client = await TogetherClient.connect(baseUrl, key, options)
        clients.add(client)
        if (ready) await client.waitReady()
        return client
      },
      seedHostAlias(): Credentials {
        // Reproduce a real migrated devices file, as test/devices.test.ts does.
        // Never mutate a live server socket or the room manager's membership map.
        releaseUserSpace(users.host.username, true)
        const filename = path.join(global.lx.userPath, getUserDirname(users.host.username), File.userDevicesJSON)
        const data = JSON.parse(fs.readFileSync(filename, 'utf8'))
        const canonical = data.clients[credentials.host.clientId]
        const alias = {
          ...canonical,
          clientId: `historical-${randomUUID()}`,
          key: randomBytes(16).toString('base64'),
          lastConnectDate: 1,
          lastSeen: 1,
        }
        data.clients[alias.clientId] = alias
        fs.writeFileSync(filename, JSON.stringify(data))
        const store = getUserSpace(users.host.username).dataManage
        assert.equal(store.getDeviceClientId(alias.clientId), credentials.host.clientId)
        return alias
      },
      close,
    }
  } catch (error) {
    try { await close() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Together fixture setup and cleanup failed')
    }
    throw error
  }
}

export type Fixture = Awaited<ReturnType<typeof createFixture>>
