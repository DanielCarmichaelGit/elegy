// Sessions on a relay that needs passes: they connect, sync, share files, keep
// their pass fresh, come back after a lapse, and stop when signed out.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { Connection } from '../src/connection.js'
import { runSession } from '../src/runner.js'
import { generateIdentity } from '../src/identity.js'
import { PassSource, SignedOutError } from '../src/pass-source.js'
import { PASS_KEYS, makePass, testPasses } from './pass-helpers.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-sp-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-sp-${n}-`))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 8000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
/** Passes that run out after `ms`, counting how many were fetched. */
function shortPasses (identity, ms) {
  const ps = new PassSource({ earlyMs: 0, fetchPass: async () => { ps.count++; const exp = Date.now() + ms; return { pass: makePass({ identity, exp }), expiresAt: exp } } })
  ps.count = 0
  return ps
}

let srv, server
before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  server = `ws://127.0.0.1:${srv.port}`
})
after(() => srv.close())

test('two signed-in sessions sync files and share chat files through a relay that needs passes', async (t) => {
  const dana = generateIdentity()
  const eli = generateIdentity()
  const dirA = tmp('a')
  fs.writeFileSync(path.join(dirA, 'hello.txt'), 'hi')
  const a = new Session({ dir: dirA, server, room: 'sp-1', secret: 's', name: 'Dana', identity: dana, passes: testPasses(dana) })
  t.after(() => a.stop())
  await a.start({ waitTimeoutMs: 5000 })
  const dirB = tmp('b')
  const b = new Session({ dir: dirB, server, room: 'sp-1', secret: 's', name: 'Eli', identity: eli, passes: testPasses(eli, { name: 'Eli', sub: 'user-eli' }) })
  t.after(() => b.stop())
  await b.start({ waitTimeoutMs: 5000 })
  await waitFor(() => read(dirB, 'hello.txt') === 'hi')

  const notes = path.join(tmp('notes'), 'notes.txt')
  fs.writeFileSync(notes, 'shared notes')
  const sent = await a.sendFile(notes)
  await waitFor(() => b.chat.toArray().some((m) => m.id === sent.id))
  const got = await b.fetchFile(sent.id, path.join(tmp('dl'), 'notes.txt'))
  assert.equal(fs.readFileSync(got, 'utf8'), 'shared notes')
})

test('a session without a pass is told to update and sign in', async (t) => {
  const s = new Session({ dir: tmp('none'), server, room: 'sp-2', secret: 's', name: 'Old', identity: generateIdentity() })
  t.after(() => s.stop())
  await assert.rejects(s.start({ waitTimeoutMs: 5000 }), /Update Quilt and sign in to continue/)
})

test('a connection refreshes its pass while connected, so it never runs out', async (t) => {
  const id = generateIdentity()
  const passes = shortPasses(id, 700)
  const conn = new Connection({ server, room: 'sp-3', secret: 's', name: 'Dana', identity: id, doc: new Y.Doc(), passes, passRefreshMs: 250 })
  t.after(() => conn.close())
  const statuses = []
  conn.on('status', (s) => statuses.push(s))
  await conn.waitForSync()
  await wait(1500)
  assert.deepEqual(statuses, ['connected'], 'never dropped')
  assert.ok(passes.count >= 4, `fetched ${passes.count} passes`)
})

test('a lapsed pass closes with 4419, and the connection comes back with a fresh one', async (t) => {
  const id = generateIdentity()
  const passes = shortPasses(id, 400)
  const conn = new Connection({ server, room: 'sp-4', secret: 's', name: 'Dana', identity: id, doc: new Y.Doc(), passes, passRefreshMs: 60_000 })
  t.after(() => conn.close())
  const statuses = []
  conn.on('status', (s) => statuses.push(s))
  await waitFor(() => statuses.filter((s) => s === 'connected').length >= 2)
  assert.deepEqual(statuses.slice(0, 3), ['connected', 'disconnected', 'connected'])
  assert.ok(passes.count >= 2)
})

test('once the API says this computer is signed out, the connection stops for good', async () => {
  const passes = new PassSource({ fetchPass: async () => { throw new SignedOutError('This computer was signed out. Sign in again.') } })
  const conn = new Connection({ server, room: 'sp-5', secret: 's', name: 'Dana', identity: generateIdentity(), doc: new Y.Doc(), passes })
  const err = await new Promise((resolve) => conn.on('fatal', resolve))
  assert.equal(err.signedOut, true)
  assert.equal(err.message, 'This computer was signed out. Sign in again.')
  assert.equal(conn.closed, true)
})

test('runSession takes your name, and an agent badge, from the pass', async (t) => {
  const id = generateIdentity()
  const run = await runSession({ dir: tmp('run'), conn: { server, room: 'sp-6', secret: 's', viewSecret: 'v' }, name: 'ignored', identity: id, passes: testPasses(id, { name: 'helper', kind: 'agent', sub: 'agent-1' }), agentFeed: false })
  t.after(() => run.stop())
  assert.equal(run.session.name, 'helper')
  assert.equal(run.session.kind, 'agent')
  await waitFor(() => srv.rooms.get('sp-6')?.access.size)
  assert.deepEqual([...srv.rooms.get('sp-6').access.values()].map((a) => [a.name, a.kind]), [['helper', 'agent']])
})

test('runSession does not wait for a pass: a folder synced before starts offline under the saved name, then takes the pass name', async (t) => {
  const id = generateIdentity()
  const dir = tmp('offline')
  const first = await runSession({ dir, conn: { server, room: 'sp-7', secret: 's' }, name: 'Dana', identity: id, passes: testPasses(id), agentFeed: false })
  await first.stop()
  // Quilt can't be reached until the gate opens.
  let open
  const gate = new Promise((resolve) => { open = resolve })
  let fail = true
  const passes = new PassSource({ fetchPass: async () => { await gate; if (fail) throw new Error('offline'); const exp = Date.now() + 600_000; return { pass: makePass({ identity: id, name: 'Dana Smith', exp }), expiresAt: exp } } })
  const run = await runSession({ dir, conn: { server, room: 'sp-7', secret: 's' }, name: 'Dana', identity: id, passes, agentFeed: false })
  t.after(() => run.stop())
  assert.equal(run.session.name, 'Dana', 'started before any pass, with the saved name')
  fail = false
  open()
  await waitFor(() => run.session.name === 'Dana Smith')
  await waitFor(() => JSON.parse(fs.readFileSync(path.join(dir, '.quilt', 'config.json'), 'utf8')).name === 'Dana Smith')
})

test('runSession stops when the API says this computer is signed out', async () => {
  const passes = new PassSource({ fetchPass: async () => { throw new SignedOutError('This computer was signed out. Sign in again.') } })
  await assert.rejects(
    runSession({ dir: tmp('out'), conn: { server, room: 'sp-8', secret: 's' }, name: 'Dana', identity: generateIdentity(), passes, agentFeed: false }),
    (err) => err.signedOut === true
  )
})
