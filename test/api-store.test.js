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
  assert.equal(await s.deviceByToken('h1'), null, 'the old token stays dead')
})

test('devices: revoking clears the token, and relinking clears it too', async () => {
  const s = createMemoryStore()
  const d = await s.upsertDevice({ userId: 'u1', name: 'Mac', platform: 'darwin', publicKey: 'pk1' })
  await s.setDeviceToken(d.id, 'h1')
  await s.revokeDevice(d.id)
  assert.equal((await s.upsertDevice({ userId: 'u1', name: 'Mac', platform: 'darwin', publicKey: 'pk1' })).tokenHash, null)
  await s.setDeviceToken(d.id, 'h2')
  const again = await s.upsertDevice({ userId: 'u1', name: 'Mac', platform: 'darwin', publicKey: 'pk1' })
  assert.equal(again.tokenHash, null, 'a relink without a revoke also retires the old token')
  assert.equal(await s.deviceByToken('h2'), null)
})

test('devices: the same key under two accounts is two rows; one never touches the other', async () => {
  const s = createMemoryStore()
  const a = await s.upsertDevice({ userId: 'u1', name: 'Mac', platform: 'darwin', publicKey: 'pk1' })
  await s.setDeviceToken(a.id, 'ha')
  const b = await s.upsertDevice({ userId: 'u2', name: 'Stolen', platform: 'darwin', publicKey: 'pk1' })
  assert.notEqual(b.id, a.id)
  assert.equal(b.userId, 'u2')
  const stillA = await s.deviceByToken('ha')
  assert.equal(stillA.id, a.id)
  assert.equal(stillA.userId, 'u1')
  assert.equal(stillA.name, 'Mac')
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

test('claimLink only changes status once', async () => {
  const s = createMemoryStore()
  const l = await s.createLink({ deviceCodeHash: 'dh2', userCode: 'CCCC-DDDD', publicKey: 'pk', deviceName: 'Mac', platform: 'darwin', expiresAt: Date.now() + 1000 })
  await s.updateLink(l.id, { status: 'approved' })
  assert.equal(await s.claimLink(l.id, 'approved', 'consumed'), true)
  assert.equal((await s.linkByDeviceCode('dh2')).status, 'consumed')
  assert.equal(await s.claimLink(l.id, 'approved', 'consumed'), false)
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

test('profileKind defaults to personal, and only an org account reads back org', async () => {
  const s = createMemoryStore()
  s.addUser('u1', { name: 'Dana' })
  s.addUser('u2', { name: 'Org', kind: 'org' })
  assert.equal(await s.profileKind('u1'), 'personal')
  assert.equal(await s.profileKind('u2'), 'org')
  assert.equal(await s.profileKind('missing'), null)
})

test('deleting a user removes their profile, computers and agents', async () => {
  const s = createMemoryStore()
  s.addUser('gone', { name: 'Gone' })
  const d = await s.upsertDevice({ userId: 'gone', name: 'Mac', platform: 'darwin', publicKey: 'pk-gone' })
  await s.setDeviceToken(d.id, 'h-gone')
  await s.createAgent({ ownerId: 'gone', name: 'A', keyPrefix: 'qa_xxxxx', keyHash: 'k-gone', publicKey: 'apk-gone', privateKeyEnc: 'e' })
  await s.deleteUser('gone')
  assert.equal(await s.profile('gone'), null)
  assert.equal(await s.deviceByToken('h-gone'), null)
  assert.equal(await s.agentByKey('k-gone'), null)
})
