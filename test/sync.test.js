import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { isSafeRelPath, globMatcher } from '../src/fsutil.js'

let srv, server
const sessions = []
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `elegy-${name}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), text)
}

async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  let last
  while (Date.now() - start < ms) {
    try { last = await fn(); if (last) return last } catch (err) { last = err }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out; last value: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}

async function open (dir, name, extra = {}) {
  const s = new Session({ dir, server, room: extra.room || 'test', secret: 'pw', name, ...extra })
  await s.start({ waitTimeoutMs: 5000 })
  sessions.push(s)
  return s
}

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {} })
  server = `ws://127.0.0.1:${srv.port}`
})

after(async () => {
  for (const s of sessions) await s.stop().catch(() => {})
  await srv.close()
})

let A, B, dirA, dirB

test('first joiner seeds the room, second joiner receives files', async () => {
  dirA = tmp('a'); dirB = tmp('b')
  write(dirA, 'README.md', '# hello\n')
  write(dirA, 'src/app.js', 'console.log(1)\n')
  write(dirA, '.env', 'SECRET=1\n')
  write(dirA, 'node_modules/x/index.js', 'x')
  A = await open(dirA, 'alice', { tool: 'claude' })
  B = await open(dirB, 'bob', { tool: 'cursor' })
  assert.equal(read(dirB, 'README.md'), '# hello\n')
  assert.equal(read(dirB, 'src/app.js'), 'console.log(1)\n')
  assert.equal(read(dirB, '.env'), null, '.env must never sync')
  assert.equal(read(dirB, 'node_modules/x/index.js'), null)
})

test('edits propagate live in both directions', async () => {
  write(dirA, 'src/new.ts', 'export const a = 1\n')
  await waitFor(() => read(dirB, 'src/new.ts') === 'export const a = 1\n')
  write(dirB, 'src/new.ts', 'export const a = 2\n')
  await waitFor(() => read(dirA, 'src/new.ts') === 'export const a = 2\n')
})

test('concurrent edits to different parts of a file merge', async () => {
  const base = 'line1\nline2\nline3\nline4\nline5\n'
  write(dirA, 'merge.txt', base)
  await waitFor(() => read(dirB, 'merge.txt') === base)
  // Both write at (nearly) the same time before seeing each other's change.
  write(dirA, 'merge.txt', 'LINE1 by alice\nline2\nline3\nline4\nline5\n')
  write(dirB, 'merge.txt', 'line1\nline2\nline3\nline4\nLINE5 by bob\n')
  const expected = 'LINE1 by alice\nline2\nline3\nline4\nLINE5 by bob\n'
  await waitFor(() => read(dirA, 'merge.txt') === expected && read(dirB, 'merge.txt') === expected)
})

test('deletes and folder removals propagate', async () => {
  write(dirA, 'tmp/a.txt', 'a')
  write(dirA, 'tmp/b.txt', 'b')
  await waitFor(() => read(dirB, 'tmp/b.txt') === 'b')
  fs.rmSync(path.join(dirA, 'tmp'), { recursive: true })
  await waitFor(() => read(dirB, 'tmp/a.txt') === null && read(dirB, 'tmp/b.txt') === null)
})

test('binary files sync byte for byte', async () => {
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 254])
  fs.writeFileSync(path.join(dirA, 'logo.png'), buf)
  await waitFor(() => fs.existsSync(path.join(dirB, 'logo.png')) && fs.readFileSync(path.join(dirB, 'logo.png')).equals(buf))
})

test('unsafe paths from a peer are never written', async () => {
  const evil = path.join(path.dirname(dirB), 'elegy-escape.txt')
  fs.rmSync(evil, { force: true })
  A.doc.transact(() => {
    A.files.set('../elegy-escape.txt', new Y.Text('pwned'))
    A.files.set('.git/hooks/pre-commit', new Y.Text('pwned'))
    A.files.set('.env', new Y.Text('pwned'))
  })
  write(dirA, 'marker.txt', 'after')
  await waitFor(() => read(dirB, 'marker.txt') === 'after')
  assert.equal(fs.existsSync(evil), false)
  assert.equal(read(dirB, '.git/hooks/pre-commit'), null)
  assert.equal(read(dirB, '.env'), null)
  assert.equal(isSafeRelPath('a/../../b'), false)
  assert.equal(isSafeRelPath('src/ok.js'), true)
})

test('presence, focus, claims and chat are shared', async () => {
  A.setFocus('building login page')
  A.claim('src/auth/**', 'rewriting auth')
  B.say('hey, I will take the CSS')
  await waitFor(() => {
    const st = B.status()
    return st.peers.some((p) => p.name === 'alice' && p.focus === 'building login page') &&
      st.claims.some((c) => c.pattern === 'src/auth/**' && c.by === 'alice')
  })
  await waitFor(() => A.status().chat.some((m) => m.by === 'bob'))
  assert.throws(() => B.claim('src/auth/**'), /already claimed by alice/)
  assert.equal(B.claimFor('src/auth/login.ts').by, 'alice')
  assert.equal(B.claim('src/auth/login.ts').overlapping[0].by, 'alice')
  B.release('src/auth/login.ts')
  assert.equal(A.release('*'), 1)
})

test('direct messages are only shown to sender and recipient', async () => {
  const r = B.say('psst alice', { to: 'alice' })
  assert.equal(r.recipientOnline, true)
  B.say('note to carol', { to: 'carol' })
  await waitFor(() => A.messages({ markRead: false }).some((m) => m.text === 'psst alice' && m.to === 'alice'))
  assert.ok(!A.messages({ markRead: false }).some((m) => m.text === 'note to carol'), 'alice must not see a DM to carol')
  assert.ok(B.messages({ markRead: false }).some((m) => m.text === 'note to carol'), 'sender sees their own DM')
  assert.throws(() => B.say(''), /empty/)
})

test('unread tracking', async () => {
  A.messages() // mark everything read
  assert.equal(A.unreadCount(), 0)
  B.say('are you there?')
  await waitFor(() => A.unreadCount() === 1)
  const unread = A.messages({ unreadOnly: true })
  assert.equal(unread.length, 1)
  assert.equal(unread[0].text, 'are you there?')
  assert.equal(A.unreadCount(), 0)
})

test('files sent in chat are delivered without touching the project', async () => {
  const outside = tmp('outside')
  const payload = Buffer.concat([Buffer.from('screenshot'), Buffer.from([0, 1, 2, 255])])
  fs.writeFileSync(path.join(outside, 'shot.png'), payload)
  const received = []
  B.on('log', (m) => received.push(m))
  const sent = await A.sendFile(path.join(outside, 'shot.png'), { text: 'look at this' })
  assert.equal(sent.file.name, 'shot.png')
  // Bob's session downloads it into .elegy/inbox automatically.
  const inboxFile = await waitFor(() => {
    const m = B.messages({ markRead: false }).find((x) => x.id === sent.id)
    return m && m.file.localPath
  })
  assert.ok(fs.readFileSync(path.join(dirB, inboxFile)).equals(payload))
  assert.ok(inboxFile.startsWith('.elegy/inbox/'))
  assert.equal(read(dirB, 'shot.png'), null, 'shared files must not land in the project tree')
  assert.ok(received.some((l) => l.includes('received shot.png')))
  // Fetch it again somewhere else.
  const dest = await B.fetchFile(sent.id, outside + '/copy.png')
  assert.ok(fs.readFileSync(dest).equals(payload))
  // Direct file: carol-only file is invisible to bob.
  const dm = await A.sendFile(path.join(outside, 'shot.png'), { to: 'carol' })
  await assert.rejects(B.fetchFile(dm.id), /no such file/)
})

test('relay rejects file access with the wrong secret', async () => {
  const res = await fetch(`http://127.0.0.1:${srv.port}/files/test`, { method: 'POST', headers: { 'x-elegy-secret': 'nope' }, body: 'x' })
  assert.equal(res.status, 401)
})

test('offline edits merge when a client comes back', async () => {
  write(dirA, 'offline.txt', 'top\nmiddle\nbottom\n')
  await waitFor(() => read(dirB, 'offline.txt') === 'top\nmiddle\nbottom\n')
  await B.stop()
  sessions.splice(sessions.indexOf(B), 1)
  const note = path.join(tmp('note'), 'while-away.txt')
  fs.writeFileSync(note, 'sent while bob was offline')
  const sentAway = await A.sendFile(note, { to: 'bob' })
  write(dirB, 'offline.txt', 'top (bob offline)\nmiddle\nbottom\n')
  write(dirB, 'bob-only.txt', 'made on a plane\n')
  write(dirA, 'offline.txt', 'top\nmiddle\nbottom (alice)\n')
  await new Promise((r) => setTimeout(r, 200))
  B = await open(dirB, 'bob')
  const expected = 'top (bob offline)\nmiddle\nbottom (alice)\n'
  await waitFor(() => read(dirA, 'offline.txt') === expected && read(dirB, 'offline.txt') === expected)
  await waitFor(() => read(dirA, 'bob-only.txt') === 'made on a plane\n')
  const got = await waitFor(() => B.messages({ markRead: false }).find((m) => m.id === sentAway.id)?.file.localPath)
  assert.equal(read(dirB, got), 'sent while bob was offline')
})

test('first join backs up conflicting local files and takes the session version', async () => {
  const dirC = tmp('c')
  write(dirC, 'README.md', 'my own readme\n')
  const C = await open(dirC, 'carol')
  assert.equal(read(dirC, 'README.md'), '# hello\n')
  const conflicts = path.join(dirC, '.elegy', 'conflicts')
  const [stamp] = fs.readdirSync(conflicts)
  assert.equal(read(path.join(conflicts, stamp), 'README.md'), 'my own readme\n')
  await C.stop()
  sessions.splice(sessions.indexOf(C), 1)
})

test('wrong secret is rejected', async () => {
  const s = new Session({ dir: tmp('d'), server, room: 'test', secret: 'nope', name: 'mallory' })
  await assert.rejects(s.start({ waitTimeoutMs: 3000 }), /Wrong room secret|refused/)
  await s.stop()
})

test('glob matching', () => {
  assert.ok(globMatcher('src/**/*.ts')('src/a/b.ts'))
  assert.ok(globMatcher('src/**/*.ts')('src/b.ts'))
  assert.ok(!globMatcher('src/*.ts')('src/a/b.ts'))
  assert.ok(globMatcher('src/auth')('src/auth/x.js'))
  assert.ok(!globMatcher('src/auth')('src/authz.js'))
})

test('AI feed entries reach the other side, deduped by id', async () => {
  const base = { tool: 'Claude Code', conv: 'c1', ts: Date.now() }
  assert.equal(A.pushAgentEntries([
    { ...base, id: 'p1', kind: 'prompt', text: 'add a navbar' },
    { ...base, id: 'r1', kind: 'reply', text: 'Sure.' }
  ]), 2)
  assert.equal(A.pushAgentEntries([{ ...base, id: 'p1', kind: 'prompt', text: 'add a navbar' }]), 0, 'same id is skipped')
  await waitFor(() => B.agentFeedFor('alice').length === 2)
  assert.deepEqual(B.agentFeedFor('alice').map((e) => [e.by, e.kind, e.text]), [['alice', 'prompt', 'add a navbar'], ['alice', 'reply', 'Sure.']])
  assert.equal(B.agentFeedFor('bob').length, 0)
})

test('AI feed keeps each person\'s newest 300 entries', async () => {
  const many = Array.from({ length: 320 }, (_, i) => ({ id: `bulk${i}`, tool: 'Cursor', conv: 'c2', kind: 'action', text: `step ${i}`, ts: Date.now() + i }))
  B.pushAgentEntries([{ id: 'bob1', kind: 'prompt', text: 'bob stays', ts: Date.now() }])
  A.pushAgentEntries(many)
  const feed = A.agentFeedFor('alice')
  assert.equal(feed.length, 300)
  assert.equal(feed.at(-1).text, 'step 319')
  assert.equal(feed[0].text, 'step 20')
  await waitFor(() => B.agentFeedFor('alice').length === 300 && A.agentFeedFor('bob').length === 1)
})

test('pausing AI sharing stops entries and leaves markers', async () => {
  A.setAgentSharing(false)
  assert.equal(A.pushAgentEntries([{ id: 'hidden', kind: 'prompt', text: 'private thought' }]), 0)
  A.setAgentSharing(true)
  A.pushAgentEntries([{ id: 'after', kind: 'prompt', text: 'back again' }])
  await waitFor(() => B.agentFeedFor('alice').at(-1)?.text === 'back again')
  const kinds = B.agentFeedFor('alice').slice(-3).map((e) => e.kind)
  assert.deepEqual(kinds, ['paused', 'resumed', 'prompt'])
  assert.ok(!B.agentFeedFor('alice').some((e) => e.text === 'private thought'))
  await waitFor(() => B.status().peers.find((p) => p.name === 'alice')?.agent?.sharing === true)
})

test('agent status is shared through presence', async () => {
  A.setAgentState({ tool: 'Claude Code', status: 'working' })
  await waitFor(() => B.status().peers.find((p) => p.name === 'alice')?.agent?.status === 'working')
  A.setAgentSharing(false)
  await waitFor(() => B.status().peers.find((p) => p.name === 'alice')?.agent?.sharing === false)
  assert.equal(B.status().peers.find((p) => p.name === 'alice').agent.status, 'idle', 'a paused person\'s activity is hidden')
  A.setAgentSharing(true)
})

test('file-changed fires for local and remote edits', async () => {
  const seenA = []
  const seenB = []
  const la = (e) => seenA.push(e)
  const lb = (e) => seenB.push(e)
  A.on('file-changed', la)
  B.on('file-changed', lb)
  write(dirA, 'watched.txt', 'v1')
  await waitFor(() => seenB.some((e) => e.path === 'watched.txt'))
  assert.ok(seenA.some((e) => e.path === 'watched.txt' && e.by === 'alice'))
  assert.equal(seenB.find((e) => e.path === 'watched.txt').by, 'alice')
  A.off('file-changed', la)
  B.off('file-changed', lb)
})
