import assert from 'node:assert/strict'
import { it } from 'node:test'
import { getAccountStore } from '../../../src/account/store'
import { getUserSpace } from '../../../src/user'
import { song } from '../fakes'
import { createFixture } from './fixture'

it('HTTP playlist create broadcasts to a real same-user WS device and advances its sync baseline', { timeout: 25000 }, async() => {
  const fixture = await createFixture()
  try {
    fixture.reset()
    const client = await fixture.connect('host', { list: true })
    const other = await fixture.connect('member', { list: true })
    const pat = getAccountStore().pats.create(fixture.users.host.id, 'WS', ['playlist:write'], 'never')
    const response = await fetch(fixture.baseUrl + '/api/v1/playlists', { method: 'POST', headers: { authorization: `Bearer ${pat.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'WS mix', songs: [song('one')] }) })
    assert.equal(response.status, 201)
    const { id } = await response.json() as { id: string }
    await client.waitFor(() => client.handshake.filter(h => h.method == 'onListSyncAction').length >= 2, 'playlist pushes')
    assert.deepEqual(client.handshake.filter(h => h.method == 'onListSyncAction').map(h => (h.args[0] as any).action), ['list_create', 'list_music_add'])
    assert.equal(other.handshake.filter(h => h.method == 'onListSyncAction').length, 0)
    const manage = getUserSpace(fixture.users.host.username).listManage
    const key = await manage.getCurrentListInfoKey()
    // The server records the device's snapshot key after the device acknowledges, which emits no client event, so poll.
    const acked = () => manage.snapshotDataManage.snapshotInfo.clients[fixture.credentials.host.clientId]?.snapshotKey == key
    for (let deadline = Date.now() + 5000; !acked() && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(acked(), 'device snapshot key acknowledged')
    assert.equal((await manage.snapshotDataManage.getSnapshot(key))!.userList.find(l => l.id == id)!.list[0].id, song('one').id)
  } finally { await fixture.close() }
})
