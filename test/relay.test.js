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
import { Session } from '../src/session.js'
import { Connection } from '../src/connection.js'

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `cowove-relay-${n}-`))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, ms = 5000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
const quiet = () => {}

test('health endpoint and status page', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, relayKey: 'k' })
  const h = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json()
  assert.equal(h.ok, true)
  assert.equal(h.requiresKey, true)
  const page = await (await fetch(`http://127.0.0.1:${srv.port}/status`)).text()
  assert.match(page, /cowove relay/)
  assert.match(page, /Running/)
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/nope`)).status, 404)
  await srv.close()
})

test('a relay key is needed to create rooms, not to join them', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, relayKey: 'team-key' })
  const server = `ws://127.0.0.1:${srv.port}`
  const stranger = new Session({ dir: tmp('s'), server, room: 'r1', secret: 'x', name: 'stranger' })
  await assert.rejects(stranger.start({ waitTimeoutMs: 3000 }), /relay key/)
  await stranger.stop()
  assert.equal(srv.rooms.has('r1'), false, 'refused rooms are not kept')

  const host = new Session({ dir: tmp('h'), server, room: 'r1', secret: 'x', key: 'team-key', name: 'host' })
  await host.start({ waitTimeoutMs: 3000 })
  const guest = new Session({ dir: tmp('g'), server, room: 'r1', secret: 'x', name: 'guest' })
  await guest.start({ waitTimeoutMs: 3000 })
  const up = await fetch(`http://127.0.0.1:${srv.port}/files/other-room`, { method: 'POST', headers: { 'x-cowove-secret': 'x' }, body: 'hi' })
  assert.equal(up.status, 403)
  await guest.stop(); await host.stop(); await srv.close()
})

test('too many connections from one address are refused', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxConnsPerIp: 2 })
  const open = () => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/cap?secret=s`)
    ws.on('open', () => resolve({ ws, status: 101 }))
    ws.on('unexpected-response', (req, res) => resolve({ status: res.statusCode }))
  })
  const a = await open(); const b = await open(); const c = await open()
  assert.deepEqual([a.status, b.status, c.status], [101, 101, 429])
  a.ws.close(); b.ws.close()
  await srv.close()
})

test('a room over its size quota refuses new edits', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxRoomBytes: 4000 })
  const dir = tmp('big')
  const s = new Session({ dir, server: `ws://127.0.0.1:${srv.port}`, room: 'big', secret: 's', name: 'a' })
  let fatal = null
  s.on('fatal', (err) => { fatal = err })
  await s.start({ waitTimeoutMs: 3000 })
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x'.repeat(6000))
  await waitFor(() => srv.rooms.get('big')?.full)
  fs.writeFileSync(path.join(dir, 'b.txt'), 'more')
  await waitFor(() => fatal)
  assert.match(fatal.message, /size limit/)
  await s.stop(); await srv.close()
})

test('file storage quota per room', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxRoomFileBytes: 1000 })
  const post = (body) => fetch(`http://127.0.0.1:${srv.port}/files/fq`, { method: 'POST', headers: { 'x-cowove-secret': 's' }, body })
  assert.equal((await post('x'.repeat(600))).status, 201)
  const r = await post('x'.repeat(600))
  assert.equal(r.status, 413)
  assert.match(await r.text(), /quota/)
  await srv.close()
})

test('idle rooms leave memory and come back intact', async () => {
  const dataDir = tmp('data')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir, idleUnloadMs: 50 })
  const doc = new Y.Doc()
  const c = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'idle', secret: 's', doc })
  await c.waitForSync()
  doc.getText('t').insert(0, 'kept')
  await waitFor(() => srv.rooms.get('idle')?.doc.getText('t').toString() === 'kept')
  c.close()
  await waitFor(() => !srv.rooms.has('idle'), 3000)
  const doc2 = new Y.Doc()
  const c2 = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'idle', secret: 's', doc: doc2 })
  await c2.waitForSync()
  assert.equal(doc2.getText('t').toString(), 'kept')
  c2.close()
  await srv.close()
})

test('rooms unused for longer than the TTL are deleted', async () => {
  const dataDir = tmp('ttl')
  fs.writeFileSync(path.join(dataDir, 'old.json'), JSON.stringify({ secretHash: 'ab', lastActive: Date.now() - 40 * 86400e3 }))
  fs.writeFileSync(path.join(dataDir, 'old.ydoc'), Buffer.from([0, 0]))
  fs.mkdirSync(path.join(dataDir, 'files', 'old'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'fresh.json'), JSON.stringify({ secretHash: 'ab', lastActive: Date.now() }))
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir, roomTtlDays: 30 })
  assert.equal(fs.existsSync(path.join(dataDir, 'old.json')), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'old.ydoc')), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'files', 'old')), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'fresh.json')), true)
  await srv.close()
})

test('new sessions are rate-limited per address; joining existing ones is not', async () => {
  const { default: WebSocket } = await import('ws')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, maxNewRoomsPerHour: 2 })
  const open = (room) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/${room}?secret=s`)
    ws.on('open', () => { ws.close(); resolve('open') })
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode))
  })
  assert.equal(await open('r1'), 'open')
  assert.equal(await open('r2'), 'open')
  assert.equal(await open('r3'), 429)
  assert.equal(await open('r1'), 'open', 'rejoining an existing room still works')
  await srv.close()
})
