// The relay as it runs when hosted publicly: health, relay key, quotas,
// per-IP limits, unloading idle rooms, and expiring abandoned ones.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { startServer } from '../src/server.js'
import { encodeInvite, decodeInvite } from '../src/runner.js'
import { Session } from '../src/session.js'
import { Connection } from '../src/connection.js'
import { generateIdentity } from '../src/identity.js'

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-relay-${n}-`))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, ms = 5000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
const quiet = () => {}
/** Cleanups that run last-in first-out when the test ends, even if it failed. */
function cleanups (t) {
  const fns = []
  t.after(async () => { for (const fn of fns.reverse()) await fn() })
  return (fn) => fns.push(fn)
}
// Sessions without an identity create one in ~/.quilt; keep that out of the real home.
process.env.HOME = tmp('home')

test('health endpoint and status page', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, relayKey: 'k' })
  defer(() => srv.close())
  const h = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json()
  assert.equal(h.ok, true)
  assert.equal(h.requiresKey, true)
  const page = await (await fetch(`http://127.0.0.1:${srv.port}/status`)).text()
  assert.match(page, /quilt relay/)
  assert.match(page, /Running/)
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/nope`)).status, 404)
})

test('invite links open a join page that never needs the secret', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  defer(() => srv.close())
  const page = await fetch(`http://127.0.0.1:${srv.port}/join/room-abc`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /room-abc/)
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/join/bad%20room`)).status, 404)
  assert.equal(srv.rooms.has('room-abc'), false, 'viewing the page does not create a room')
})

test('invites are links, and older codes still work', () => {
  const conn = { server: 'wss://relay.example.com', room: 'room-1a2b', secret: 'abc_D-9' }
  const link = encodeInvite(conn)
  assert.equal(link, 'https://relay.example.com/join/room-1a2b#abc_D-9')
  assert.deepEqual(decodeInvite(link), conn)
  assert.deepEqual(decodeInvite(`  quilt join ${link}\n`), conn)
  assert.deepEqual(decodeInvite(encodeInvite({ server: 'ws://192.168.1.4:4321/', room: 'r', secret: 's' })), { server: 'ws://192.168.1.4:4321', room: 'r', secret: 's' })
  const old = Buffer.from(JSON.stringify({ s: conn.server, r: conn.room, k: conn.secret })).toString('base64url')
  assert.deepEqual(decodeInvite(old), conn)
  assert.throws(() => decodeInvite('nonsense'), /invite link is not valid/)
})

test('a relay key is needed to create rooms, not to join them', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, relayKey: 'team-key' })
  defer(() => srv.close())
  const server = `ws://127.0.0.1:${srv.port}`
  const stranger = new Session({ dir: tmp('s'), server, room: 'r1', secret: 'x', name: 'stranger' })
  await assert.rejects(stranger.start({ waitTimeoutMs: 3000 }), /relay key/)
  await stranger.stop()
  assert.equal(srv.rooms.has('r1'), false, 'refused rooms are not kept')

  const host = new Session({ dir: tmp('h'), server, room: 'r1', secret: 'x', key: 'team-key', name: 'host' })
  defer(() => host.stop())
  await host.start({ waitTimeoutMs: 3000 })
  const guest = new Session({ dir: tmp('g'), server, room: 'r1', secret: 'x', name: 'guest' })
  defer(() => guest.stop())
  await guest.start({ waitTimeoutMs: 3000 })
  const up = await fetch(`http://127.0.0.1:${srv.port}/files/other-room`, { method: 'POST', headers: { 'x-quilt-secret': 'x' }, body: 'hi' })
  assert.equal(up.status, 403)
})

test('too many connections from one address are refused', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxConnsPerIp: 2 })
  defer(() => srv.close())
  const open = () => new Promise((resolve) => {
    const id = generateIdentity()
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/cap?secret=s&name=n${Math.random()}&key=${id.publicKey}`)
    ws.on('open', () => resolve({ ws, status: 101 }))
    ws.on('unexpected-response', (req, res) => resolve({ status: res.statusCode }))
  })
  const a = await open(); const b = await open(); const c = await open()
  defer(() => { a.ws?.close(); b.ws?.close() })
  assert.deepEqual([a.status, b.status, c.status], [101, 101, 429])
})

test('a room over its size quota refuses new edits', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxRoomBytes: 4000 })
  defer(() => srv.close())
  const dir = tmp('big')
  const s = new Session({ dir, server: `ws://127.0.0.1:${srv.port}`, room: 'big', secret: 's', name: 'a' })
  let fatal = null
  s.on('fatal', (err) => { fatal = err })
  defer(() => s.stop())
  await s.start({ waitTimeoutMs: 3000 })
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x'.repeat(6000))
  await waitFor(() => srv.rooms.get('big')?.full)
  fs.writeFileSync(path.join(dir, 'b.txt'), 'more')
  await waitFor(() => fatal)
  assert.match(fatal.message, /size limit/)
})

test('a stored room too big to load is refused instead of loaded', async (t) => {
  const defer = cleanups(t)
  const dataDir = tmp('toobig')
  const big = new Y.Doc()
  big.getMap('files').set('a.txt', new Y.Text('x'.repeat(10000))) // over twice the limit
  fs.writeFileSync(path.join(dataDir, 'huge.ydoc'), Y.encodeStateAsUpdate(big))
  const logs = []
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: (m) => logs.push(m), dataDir, maxRoomBytes: 4000 })
  defer(() => srv.close())
  const s = new Session({ dir: tmp('toobig-client'), server: `ws://127.0.0.1:${srv.port}`, room: 'huge', secret: 's', name: 'a' })
  let fatal = null
  s.on('fatal', (err) => { fatal = err })
  defer(() => s.stop())
  s.start({ waitTimeoutMs: 3000 }).catch(() => {})
  await waitFor(() => fatal)
  assert.match(fatal.message, /size limit/)
  assert.equal(srv.rooms.get('huge'), undefined, 'the room is not kept in memory')
  assert.ok(logs.some((m) => /too big to load/.test(m)))
})

test('file storage quota per room', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxRoomFileBytes: 1000 })
  defer(() => srv.close())
  const post = (body) => fetch(`http://127.0.0.1:${srv.port}/files/fq`, { method: 'POST', headers: { 'x-quilt-secret': 's' }, body })
  assert.equal((await post('x'.repeat(600))).status, 201)
  const r = await post('x'.repeat(600))
  assert.equal(r.status, 413)
  assert.match(await r.text(), /quota/)
})

test('idle rooms leave memory and come back intact', async (t) => {
  const defer = cleanups(t)
  const dataDir = tmp('data')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir, idleUnloadMs: 50 })
  defer(() => srv.close())
  const doc = new Y.Doc()
  const identity = generateIdentity()
  const c = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'idle', secret: 's', name: 'idler', identity, doc })
  defer(() => { if (!c.closed) c.close() })
  await c.waitForSync()
  doc.getText('t').insert(0, 'kept')
  await waitFor(() => srv.rooms.get('idle')?.doc.getText('t').toString() === 'kept')
  c.close()
  await waitFor(() => !srv.rooms.has('idle'), 3000)
  const doc2 = new Y.Doc()
  const c2 = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'idle', secret: 's', name: 'idler', identity, doc: doc2 })
  defer(() => { if (!c2.closed) c2.close() })
  await c2.waitForSync()
  assert.equal(doc2.getText('t').toString(), 'kept')
})

test('rooms unused for longer than the TTL are deleted', async (t) => {
  const defer = cleanups(t)
  const dataDir = tmp('ttl')
  fs.writeFileSync(path.join(dataDir, 'old.json'), JSON.stringify({ secretHash: 'ab', lastActive: Date.now() - 40 * 86400e3 }))
  fs.writeFileSync(path.join(dataDir, 'old.ydoc'), Buffer.from([0, 0]))
  fs.mkdirSync(path.join(dataDir, 'files', 'old'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'fresh.json'), JSON.stringify({ secretHash: 'ab', lastActive: Date.now() }))
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir, roomTtlDays: 30 })
  defer(() => srv.close())
  assert.equal(fs.existsSync(path.join(dataDir, 'old.json')), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'old.ydoc')), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'files', 'old')), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'fresh.json')), true)
})

test('new sessions are rate-limited per address; joining existing ones is not', async () => {
  const { default: WebSocket } = await import('ws')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxNewRoomsPerHour: 2 })
  const id = generateIdentity()
  const open = (room) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/${room}?secret=s&name=a&key=${id.publicKey}`)
    ws.on('open', () => { ws.close(); resolve('open') })
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode))
  })
  assert.equal(await open('r1'), 'open')
  assert.equal(await open('r2'), 'open')
  assert.equal(await open('r3'), 429)
  assert.equal(await open('r1'), 'open', 'rejoining an existing room still works')
  await srv.close()
})
