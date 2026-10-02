// "May chat and post to the feed": someone whose access says no can still read and (if
// they may) edit, but the relay undoes their chat messages and feed entries, tells them
// why, and refuses the files they try to send in chat.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'
import { PASS_KEYS, makePass, testPasses } from './pass-helpers.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-rt-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-rt-${n}-`))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 6000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
const QUIET = { files: 'edit', folders: [], foldersExcept: [], talk: false }

let srv, server, owner, quiet, quietDir, quietId
const room = 'rt-1'
before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  server = `ws://127.0.0.1:${srv.port}`
  const oid = generateIdentity()
  const ownerDir = tmp('owner')
  fs.writeFileSync(path.join(ownerDir, 'README.md'), 'hello\n')
  owner = new Session({ dir: ownerDir, server, room, secret: 'e', viewSecret: 'v', name: 'Olive', identity: oid, passes: testPasses(oid, { name: 'Olive', sub: 'olive' }) })
  await owner.start({ waitTimeoutMs: 5000 })
  await waitFor(() => owner.isOwner)
  quietId = generateIdentity()
  quietDir = tmp('quiet')
  quiet = new Session({ dir: quietDir, server, room, secret: 'e', name: 'Quinn', identity: quietId, passes: testPasses(quietId, { name: 'Quinn', sub: 'quinn', room, access: QUIET }) })
  await quiet.start({ waitTimeoutMs: 5000 })
  await waitFor(() => quiet.access?.state === 'approved')
})
after(async () => { await quiet.stop(); await owner.stop(); await srv.close() })

test('their chat messages and feed entries are undone, and they are told why', async () => {
  assert.equal(quiet.access.talk, false)
  quiet.doc.transact(() => quiet.chat.push([{ id: 'm1', by: 'Quinn', to: null, text: 'psst', ts: Date.now() }]))
  quiet.doc.transact(() => quiet.agentFeed.push([{ id: 'f1', by: 'Quinn', kind: 'prompt', text: 'secret plan', ts: Date.now() }]))
  await waitFor(() => quiet.chat.length === 0 && quiet.agentFeed.length === 0)
  await wait(150)
  assert.equal(owner.chat.length, 0, 'the owner never saw the message')
  assert.equal(owner.agentFeed.length, 0)
  const rm = srv.rooms.get(room)
  assert.equal(rm.chat.length, 0)
  assert.deepEqual([quiet.access.why, quiet.access.refused], ["you can't post in this session", ['the feed']])
})

test('they can still change files their access allows', async () => {
  fs.writeFileSync(path.join(quietDir, 'notes.md'), 'from Quinn\n')
  await waitFor(() => owner.files.get('notes.md')?.toString() === 'from Quinn\n')
})

test('everyone else may still post', async () => {
  owner.say('hi Quinn')
  await waitFor(() => quiet.chat.toArray().some((m) => m.text === 'hi Quinn'))
})

test('a file sent in chat is refused', async () => {
  const pass = makePass({ identity: quietId, name: 'Quinn', sub: 'quinn', room, access: QUIET })
  const res = await fetch(`http://127.0.0.1:${srv.port}/files/${room}`, { method: 'POST', headers: { 'x-quilt-secret': 'e', 'x-quilt-pass': pass }, body: 'hi' })
  assert.deepEqual([res.status, await res.text()], [403, "You can't post in this session."])
  const ownerPass = makePass({ identity: owner.identity, name: 'Olive', sub: 'olive' })
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/files/${room}`, { method: 'POST', headers: { 'x-quilt-secret': 'e', 'x-quilt-pass': ownerPass }, body: 'hi' })).status, 201)
})
