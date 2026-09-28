// The web app's sync engine, driven through a real relay alongside a CLI
// session, so browser users and `cowove join` users interoperate.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { WebSession, decodeText, toBase64, fromBase64 } from '../src/web/engine.js'
import { nodeFolder } from './helpers/node-folder.js'

let srv, server
const open = []
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `cowove-web-${name}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), text)
}

async function waitFor (fn, ms = 6000) {
  const start = Date.now()
  let last
  while (Date.now() - start < ms) {
    try { last = await fn(); if (last) return last } catch (err) { last = err }
    await new Promise((r) => setTimeout(r, 30))
  }
  throw new Error(`timed out; last value: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}

async function web (dir, name, room) {
  const s = new WebSession({ folder: nodeFolder(dir), server, room, secret: 'pw', name, tool: 'Cursor', WebSocketImpl: WebSocket, pollMs: 50 })
  await s.start({ waitTimeoutMs: 5000 })
  open.push(s)
  return s
}

async function cli (dir, name, room) {
  const s = new Session({ dir, server, room, secret: 'pw', name })
  await s.start({ waitTimeoutMs: 5000 })
  open.push(s)
  return s
}

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {} })
  server = `ws://127.0.0.1:${srv.port}`
})

after(async () => {
  for (const s of open) await s.stop().catch(() => {})
  await srv.close()
})

test('helpers: text vs binary and base64 match the CLI', () => {
  assert.equal(decodeText(new TextEncoder().encode('héllo')), 'héllo')
  assert.equal(decodeText(new Uint8Array([104, 0, 105])), null)
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x41])), null)
  const bytes = new Uint8Array(100000).map((_, i) => (i * 7) % 256)
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'))
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes)
})

test('a browser user starts a session and a CLI user joins; edits flow both ways', async () => {
  const w = tmp('w'); const c = tmp('c')
  write(w, 'README.md', '# hi\n')
  write(w, 'src/app.js', 'let a = 1\n')
  write(w, 'node_modules/x.js', 'nope')
  write(w, '.env', 'SECRET=1')
  fs.writeFileSync(path.join(w, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
  const W = await web(w, 'wendy', 'r1')
  const C = await cli(c, 'carl', 'r1')

  assert.equal(read(c, 'README.md'), '# hi\n')
  assert.equal(read(c, 'src/app.js'), 'let a = 1\n')
  assert.deepEqual([...fs.readFileSync(path.join(c, 'logo.png'))], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
  assert.equal(read(c, 'node_modules/x.js'), null)
  assert.equal(read(c, '.env'), null)

  // CLI -> browser folder
  write(c, 'src/app.js', 'let a = 2\n')
  write(c, 'src/new.js', 'export {}\n')
  await waitFor(() => read(w, 'src/app.js') === 'let a = 2\n' && read(w, 'src/new.js') === 'export {}\n')

  // browser folder -> CLI (found by polling)
  write(w, 'README.md', '# hi there\n')
  await waitFor(() => read(c, 'README.md') === '# hi there\n')

  // deletes both ways
  fs.rmSync(path.join(w, 'src/new.js'))
  await waitFor(() => read(c, 'src/new.js') === null)
  fs.rmSync(path.join(c, 'logo.png'))
  await waitFor(() => !fs.existsSync(path.join(w, 'logo.png')))

  // presence and chat
  await waitFor(() => W.status().peers.some((p) => p.name === 'carl'))
  assert.ok(C.status().peers.some((p) => p.name === 'wendy' && p.tool === 'Cursor'))
  W.say('hello from the browser')
  await waitFor(() => C.messages({ markRead: false }).some((m) => m.text === 'hello from the browser'))
  C.say('hi back')
  await waitFor(() => W.status().chat.some((m) => m.text === 'hi back'))

  // the browser user sees the CLI user's AI feed
  C.pushAgentEntries([{ id: 'e1', tool: 'Claude Code', kind: 'prompt', text: 'Add a footer' }])
  await waitFor(() => W.status().feed.some((e) => e.text === 'Add a footer' && e.by === 'carl'))
})

test('a browser user joins into an empty folder and edits merge character by character', async () => {
  const c = tmp('c2'); const w = tmp('w2')
  write(c, 'notes.txt', 'top\nmiddle\nbottom\n')
  await cli(c, 'carl', 'r2')
  await web(w, 'wendy', 'r2')
  assert.equal(read(w, 'notes.txt'), 'top\nmiddle\nbottom\n')

  write(c, 'notes.txt', 'TOP\nmiddle\nbottom\n')
  await waitFor(() => read(w, 'notes.txt') === 'TOP\nmiddle\nbottom\n')
  write(w, 'notes.txt', 'TOP\nmiddle\nBOTTOM\n')
  await waitFor(() => read(c, 'notes.txt') === 'TOP\nmiddle\nBOTTOM\n')
})

test('joining a non-empty folder keeps the local version as a conflict copy', async () => {
  const c = tmp('c3'); const w = tmp('w3')
  write(c, 'a.txt', 'shared\n')
  write(w, 'a.txt', 'mine\n')
  write(w, 'only-mine.txt', 'local only\n')
  await cli(c, 'carl', 'r3')
  await web(w, 'wendy', 'r3')
  assert.equal(read(w, 'a.txt'), 'shared\n')
  const conflicts = fs.readdirSync(path.join(w, '.cowove', 'conflicts'))
  assert.equal(read(path.join(w, '.cowove', 'conflicts', conflicts[0]), 'a.txt'), 'mine\n')
  await waitFor(() => read(c, 'only-mine.txt') === 'local only\n')
})

test('reopening the tab later merges edits made while it was closed', async () => {
  const c = tmp('c4'); const w = tmp('w4')
  write(c, 'x.txt', 'one\n')
  const C = await cli(c, 'carl', 'r4')
  const W = await web(w, 'wendy', 'r4')
  assert.equal(read(w, 'x.txt'), 'one\n')
  await new Promise((r) => setTimeout(r, 2300)) // let the engine save its state
  await W.stop()

  write(w, 'x.txt', 'one\ntwo\n') // edited while the tab was closed
  write(w, 'y.txt', 'new while away\n')
  write(c, 'z.txt', 'from carl while wendy was away\n')
  await waitFor(() => C.files.has('z.txt'))

  await web(w, 'wendy', 'r4')
  await waitFor(() => read(c, 'x.txt') === 'one\ntwo\n' && read(c, 'y.txt') === 'new while away\n')
  await waitFor(() => read(w, 'z.txt') === 'from carl while wendy was away\n')
})

test('a local edit racing a remote edit to the same file is kept as a conflict copy', async () => {
  const c = tmp('c5'); const w = tmp('w5')
  write(c, 'race.txt', 'base\n')
  await cli(c, 'carl', 'r5')
  const W = new WebSession({ folder: nodeFolder(w), server, room: 'r5', secret: 'pw', name: 'wendy', WebSocketImpl: WebSocket, pollMs: 1500 })
  await W.start({ waitTimeoutMs: 5000 })
  open.push(W)
  assert.equal(read(w, 'race.txt'), 'base\n')
  write(w, 'race.txt', 'wendy was here\n') // not polled yet...
  write(c, 'race.txt', 'carl was here\n') // ...when carl's edit arrives
  await waitFor(() => read(w, 'race.txt') === 'carl was here\n')
  const dir = path.join(w, '.cowove', 'conflicts')
  await waitFor(() => fs.existsSync(dir))
  const copy = read(path.join(dir, fs.readdirSync(dir)[0]), 'race.txt')
  assert.equal(copy, 'wendy was here\n')
  await new Promise((r) => setTimeout(r, 1700)) // the next poll must not undo carl's edit
  assert.equal(read(c, 'race.txt'), 'carl was here\n')
})

test('website invite links work in the CLI, and CLI codes in the website', async () => {
  const { decodeInvite: cliDecode, encodeInvite: cliEncode } = await import('../src/runner.js')
  const web = await import('../src/web/invite.js')
  const conn = web.newRoom('wss://cowove.example')
  const link = web.inviteLink('https://cowove.example/', conn)
  assert.match(link, /^https:\/\/cowove\.example\/#/)
  assert.deepEqual(cliDecode(link), conn)
  assert.deepEqual(cliDecode(`cowove join ${web.encodeInvite(conn)}`), conn)
  assert.deepEqual(web.decodeInvite(cliEncode(conn)), conn)
  assert.deepEqual(web.decodeInvite(`cowove join ${cliEncode(conn)}`), conn)
  assert.equal(web.decodeInvite('https://cowove.example/#garbage'), null)
})

test('the relay serves the website', async () => {
  const home = await fetch(server.replace('ws', 'http') + '/')
  assert.match(home.headers.get('content-type'), /text\/html/)
  assert.match(await home.text(), /<script type="module" src="\/app.js">/)
  const js = await fetch(server.replace('ws', 'http') + '/app.js')
  assert.equal(js.status, 200)
  assert.match(js.headers.get('content-type'), /javascript/)
})

test('files a partner adds while the tab is closed are not deleted on reopen, even if they arrive mid-reconcile', async () => {
  const c = tmp('c6'); const w = tmp('w6')
  write(c, 'a.txt', 'a\n')
  const C = await cli(c, 'carl', 'r6')
  const W = await web(w, 'wendy', 'r6')
  await new Promise((r) => setTimeout(r, 2300)) // state saved
  await W.stop()
  write(c, 'while-away.txt', 'hello again\n')
  await waitFor(() => C.files.has('while-away.txt'))

  // A slow disk: the partner's changes arrive while the engine is still listing files.
  const slow = nodeFolder(w)
  const list = slow.list
  slow.list = async (...a) => { await new Promise((r) => setTimeout(r, 400)); return list(...a) }
  const W2 = new WebSession({ folder: slow, server, room: 'r6', secret: 'pw', name: 'wendy', WebSocketImpl: WebSocket, pollMs: 50 })
  await W2.start({ waitTimeoutMs: 5000 })
  open.push(W2)
  await waitFor(() => read(w, 'while-away.txt') === 'hello again\n')
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(read(c, 'while-away.txt'), 'hello again\n')
  assert.ok(C.files.has('while-away.txt'))
})
