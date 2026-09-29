import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/api/memory-store.js'

test('devices: the same computer relinking reuses its row and is un-revoked', async () => {
  const s = createMemoryStore()
  s.addUser('u1', { name: 'Dana' })
  const d1 = await s.upsertDevice({ userId: 'u1', name: 'Mac', platform: 'darwin', publicKey: 'pk1' })
  await s.setDeviceToken(d1.id, 'h1')
  assert.equal((await s.deviceByToken('h1')).id, d1.id)
  await s.revokeDevice(d1.id)
  assert.equal(await s.deviceByToken('h1'), null)
  const d2 = await s.upsertDevice({ userId: 'u1', name: 'Mac 2', platform: 'darwin', publicKey: 'pk1' })
  assert.equal(d2.id, d1.id)
  assert.equal(d2.revokedAt, null)
  assert.equal(d2.name, 'Mac 2')
})

test('links are found by device code and by user code', async () => {
  const s = createMemoryStore()
  const l = await s.createLink({ deviceCodeHash: 'dh', userCode: 'AAAA-BBBB', publicKey: 'pk', deviceName: 'Mac', platform: 'darwin', expiresAt: Date.now() + 1000 })
  assert.equal(l.status, 'pending')
  assert.equal((await s.linkByDeviceCode('dh')).id, l.id)
  assert.equal((await s.linkByUserCode('AAAA-BBBB')).id, l.id)
  await s.updateLink(l.id, { status: 'approved', userId: 'u1' })
  assert.equal((await s.linkByUserCode('AAAA-BBBB')).status, 'approved')
})

test('profiles, and agents only their owner can list or revoke', async () => {
  const s = createMemoryStore()
  s.addUser('u1', { name: 'Dana' }); s.addUser('u2', { name: 'Eli' })
  assert.equal((await s.profile('u1')).name, 'Dana')
  assert.equal((await s.updateProfile('u1', { color: '#123456', tool: 'Cursor' })).tool, 'Cursor')
  const a = await s.createAgent({ ownerId: 'u1', name: 'Larry', keyPrefix: 'qa_abcde', keyHash: 'kh', publicKey: 'apk', privateKeyEnc: 'enc' })
  assert.equal((await s.agentByKey('kh')).id, a.id)
  const listed = await s.listAgents('u1')
  assert.equal(listed.length, 1)
  assert.equal(listed[0].keyHash, undefined)
  assert.equal(listed[0].privateKeyEnc, undefined)
  assert.equal(await s.revokeAgent('u2', a.id), false)
  assert.equal(await s.revokeAgent('u1', a.id), true)
  assert.equal(await s.agentByKey('kh'), null)
})
