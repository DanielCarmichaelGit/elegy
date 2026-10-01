import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DiskStore, SupabaseStore, makeStore } from '../src/blobstore.js'
import { relayConfig } from '../src/server.js'

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-blob-${n}-`))
const ID = 'a'.repeat(32)

test('disk store links are signed, method-bound and expire', async () => {
  const store = new DiskStore(tmp('disk'))
  const up = await store.uploadTarget('room', ID)
  assert.equal(up.method, 'PUT')
  const q = new URL(up.url, 'http://x').searchParams
  assert.match(up.url, new RegExp(`^/blobs/room/${ID}/data\\?`))
  assert.equal(store.verify('room', ID, 'PUT', q.get('exp'), q.get('sig')), true)
  assert.equal(store.verify('room', ID, 'GET', q.get('exp'), q.get('sig')), false, 'bound to the method')
  assert.equal(store.verify('other', ID, 'PUT', q.get('exp'), q.get('sig')), false, 'bound to the room')
  assert.equal(store.verify('room', ID, 'PUT', String(Date.now() - 1), q.get('sig')), false, 'expired or altered')
})

test('disk store removes files and whole rooms', async () => {
  const dir = tmp('rm')
  const store = new DiskStore(dir)
  fs.mkdirSync(path.dirname(store.file('room', ID)), { recursive: true })
  fs.writeFileSync(store.file('room', ID), 'x')
  fs.writeFileSync(store.file('room', 'b'.repeat(32)), 'y')
  await store.remove('room', [ID])
  assert.equal(fs.existsSync(store.file('room', ID)), false)
  assert.equal(fs.existsSync(store.file('room', 'b'.repeat(32))), true)
  await store.removeRoom('room')
  assert.equal(fs.existsSync(path.join(dir, 'room')), false)
})

test('the relay uses Supabase only when it has both a URL and a key', () => {
  assert.ok(makeStore(relayConfig({}), tmp('a')) instanceof DiskStore)
  const cfg = relayConfig({ storageUrl: 'https://x.supabase.co', storageKey: 'sb_secret_x' })
  assert.ok(makeStore(cfg, tmp('b')) instanceof SupabaseStore)
  assert.equal(cfg.storageBucket, 'session-files')
  assert.equal(relayConfig({}).maxStoredFileBytes, 100 * 1024 * 1024)
  assert.equal(relayConfig({ maxStoredFileBytes: 10 }).maxStoredFileBytes, 10)
})
