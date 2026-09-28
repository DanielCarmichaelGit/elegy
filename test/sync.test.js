import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { isSafeRelPath, globMatcher } from '../src/fsutil.js'
import { generateIdentity } from '../src/identity.js'
import WebSocket from 'ws'

let srv, server
const sessions = []
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `cowove-${name}-`))
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

// One key per person, kept across reconnects like ~/.cowove/identity.json.
const identities = new Map()
const identityOf = (name) => { if (!identities.has(name)) identities.set(name, generateIdentity()); return identities.get(name) }

async function open (dir, name, extra = {}) {
  const s = new Session({ dir, server, room: extra.room || 'test', secret: 'pw', name, identity: identityOf(name), ...extra })
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
  write(dirA, '.claude/worktrees/wt/src/app.js', 'worktree copy')
  A = await open(dirA, 'alice', { tool: 'claude' })
  B = await open(dirB, 'bob', { tool: 'cursor' })
  assert.equal(read(dirB, 'README.md'), '# hello\n')
  assert.equal(read(dirB, 'src/app.js'), 'console.log(1)\n')
  assert.equal(read(dirB, '.env'), null, '.env must never sync')
  assert.equal(read(dirB, 'node_modules/x/index.js'), null)
  assert.equal(read(dirB, '.claude/worktrees/wt/src/app.js'), null, 'Claude Code worktrees must never sync')
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
  const evil = path.join(path.dirname(dirB), 'cowove-escape.txt')
  fs.rmSync(evil, { force: true })
  A.doc.transact(() => {
    A.files.set('../cowove-escape.txt', new Y.Text('pwned'))
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
  await A.claim('src/auth/**', 'rewriting auth')
  B.say('hey, I will take the CSS')
  await waitFor(() => {
    const st = B.status()
    return st.peers.some((p) => p.name === 'alice' && p.focus === 'building login page') &&
      st.claims.some((c) => c.pattern === 'src/auth/**' && c.by === 'alice')
  })
  await waitFor(() => A.status().chat.some((m) => m.by === 'bob'))
  await assert.rejects(B.claim('src/auth/**'), /already claimed by alice/)
  assert.equal(B.claimFor('src/auth/login.ts').by, 'alice')
  await assert.rejects(B.claim('src/auth/login.ts'), /overlaps alice's claim on src\/auth\/\*\*/)
  await assert.rejects(B.claim('src'), /overlaps alice's claim/)
  assert.equal(await A.release('*'), 1)
  await waitFor(() => B.claims.size === 0)
})

test('claims are enforced: others\' edits are undone locally and never shared', async () => {
  write(dirA, 'locked/a.txt', 'original\n')
  await waitFor(() => read(dirB, 'locked/a.txt') === 'original\n')
  await A.claim('locked/**', 'mine')
  await waitFor(() => B.claimFor('locked/a.txt'))

  // Edit: bob's disk goes back to the shared text; his version is kept aside.
  write(dirB, 'locked/a.txt', 'bob was here\n')
  await waitFor(() => read(dirB, 'locked/a.txt') === 'original\n')
  const saved = fs.readdirSync(path.join(dirB, '.cowove', 'rejected'))
  assert.ok(saved.some((ts) => read(path.join(dirB, '.cowove', 'rejected', ts), 'locked/a.txt') === 'bob was here\n'))
  // New file inside the claim: removed. Delete: restored.
  write(dirB, 'locked/new.txt', 'sneaky')
  await waitFor(() => read(dirB, 'locked/new.txt') === null)
  fs.rmSync(path.join(dirB, 'locked/a.txt'))
  await waitFor(() => read(dirB, 'locked/a.txt') === 'original\n')

  // The claimer can still edit, and it reaches bob.
  write(dirA, 'locked/a.txt', 'alice edit\n')
  await waitFor(() => read(dirB, 'locked/a.txt') === 'alice edit\n')
  assert.equal(read(dirA, 'locked/new.txt'), null)
  assert.equal(A.files.get('locked/a.txt').toString(), 'alice edit\n')

  // Released: bob's edits go through again.
  await A.release('locked/**')
  await waitFor(() => !B.claimFor('locked/a.txt'))
  write(dirB, 'locked/a.txt', 'bob again\n')
  await waitFor(() => read(dirA, 'locked/a.txt') === 'bob again\n')
})

test('a claim on a folder that does not exist yet covers files created later', async () => {
  await B.claim('brand-new', 'starting a module')
  await waitFor(() => A.claimFor('brand-new/deep/x.js'))
  write(dirA, 'brand-new/deep/x.js', 'nope')
  await waitFor(() => read(dirA, 'brand-new/deep/x.js') === null)
  write(dirB, 'brand-new/deep/x.js', 'bob owns this')
  await waitFor(() => read(dirA, 'brand-new/deep/x.js') === 'bob owns this')
  await B.release('brand-new')
  await waitFor(() => !A.claimFor('brand-new/deep/x.js'))
})

test('the claimer reverts changes from clients that do not enforce claims', async () => {
  write(dirA, 'guarded.txt', 'safe\n')
  await waitFor(() => read(dirB, 'guarded.txt') === 'safe\n')
  await A.claim('guarded.txt')
  await waitFor(() => B.claimFor('guarded.txt'))
  // An old or misbehaving client writes straight into the shared doc.
  B.doc.transact(() => B.files.get('guarded.txt').insert(0, 'hacked '), 'rogue')
  await waitFor(() => B.files.get('guarded.txt').toString() === 'safe\n')
  assert.equal(read(dirA, 'guarded.txt'), 'safe\n')
  await waitFor(() => read(dirB, 'guarded.txt') === 'safe\n')
  const saved = fs.readdirSync(path.join(dirA, '.cowove', 'rejected'))
  assert.ok(saved.some((ts) => read(path.join(dirA, '.cowove', 'rejected', ts), 'guarded.txt') === 'hacked safe\n'))
  // Creating a file under someone's claim is reverted too.
  await A.claim('fort')
  await waitFor(() => B.claimFor('fort/a.txt'))
  B.doc.transact(() => B.files.set('fort/a.txt', new Y.Text('sneaky')), 'rogue')
  await waitFor(() => !B.files.has('fort/a.txt'))
  assert.equal(read(dirA, 'fort/a.txt'), null)
  await A.release('*')
})

test('globs that start overlapping through a new file resolve to the earliest claim everywhere', async () => {
  await A.claim('mix/*.js')
  await B.claim('mix/a.*')
  await waitFor(() => A.claims.size === 2 && B.claims.size === 2)
  write(dirA, 'mix/b.css', 'x')
  await waitFor(() => read(dirB, 'mix/b.css') === 'x')
  assert.equal(A.claimFor('mix/a.js').by, 'alice')
  assert.equal(B.claimFor('mix/a.js').by, 'alice')
  assert.equal(B.claimFor('mix/a.css').by, 'bob')
  await A.release('*'); await B.release('*')
  await waitFor(() => A.claims.size === 0 && B.claims.size === 0)
})

test('only the claimer can release a claim', async () => {
  await A.claim('mine-only', 'hands off')
  await waitFor(() => B.claimFor('mine-only/x'))
  await assert.rejects(B.release('mine-only'), /claimed by alice; only they can release it/)
  assert.equal(await B.release('*'), 0)
  assert.equal(A.claimFor('mine-only/x').by, 'alice')
  await A.release('mine-only')
})

test('claims written straight into the shared doc are ignored', async () => {
  B.doc.transact(() => B.doc.getMap('claims').set('forged', { by: 'alice', pattern: 'forged', note: '', ts: 1 }))
  write(dirB, 'forged/x.txt', 'bob can write here')
  await waitFor(() => read(dirA, 'forged/x.txt') === 'bob can write here')
  assert.equal(A.claimFor('forged/x.txt'), null)
  assert.equal(B.claimFor('forged/x.txt'), null)
})

test('nobody can connect under a name that belongs to someone else', async () => {
  const s = new Session({ dir: tmp('m'), server, room: 'test', secret: 'pw', name: 'alice', identity: generateIdentity() })
  await assert.rejects(s.start({ waitTimeoutMs: 3000 }), /belongs to someone else/)
  await s.stop().catch(() => {})
})

test('a client that cannot prove its key is refused', async () => {
  // Uses alice's public key but signs with a different private key.
  const fake = { publicKey: identityOf('alice').publicKey, privateKey: generateIdentity().privateKey }
  const s = new Session({ dir: tmp('m'), server, room: 'test', secret: 'pw', name: 'alice', identity: fake })
  await assert.rejects(s.start({ waitTimeoutMs: 3000 }), /Could not verify who you are/)
  await s.stop().catch(() => {})
})

test('clients without an identity (older cowove) are told to update', async () => {
  const ws = new WebSocket(`${server}/test?secret=pw`)
  ws.on('error', () => {})
  const status = await new Promise((resolve) => {
    ws.on('unexpected-response', (req, res) => resolve(`${res.statusCode} ${res.statusMessage}`))
    ws.on('open', () => resolve('open'))
  })
  ws.terminate()
  assert.match(status, /^400 .*newer cowove/)
})

test('presence under someone else\'s name is dropped', async () => {
  const rogue = new Session({ dir: tmp('r'), server, room: 'test', secret: 'pw', name: 'rogue', identity: generateIdentity() })
  await rogue.start({ waitTimeoutMs: 5000 })
  sessions.push(rogue)
  await waitFor(() => A.status().peers.some((p) => p.name === 'rogue'))
  rogue.conn.awareness.setLocalStateField('name', 'alice')
  write(dirA, 'presence-marker.txt', 'x')
  await waitFor(() => read(rogue.root, 'presence-marker.txt') === 'x')
  await new Promise((r) => setTimeout(r, 100))
  assert.ok(B.status().peers.some((p) => p.name === 'rogue'), 'bob still sees the real name')
  assert.ok(!B.status().peers.some((p) => p.name === 'alice' && p.tool === 'unknown'), 'the fake alice never reached bob')
  await rogue.stop()
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
  // Bob's session downloads it into .cowove/inbox automatically.
  const inboxFile = await waitFor(() => {
    const m = B.messages({ markRead: false }).find((x) => x.id === sent.id)
    return m && m.file.localPath
  })
  assert.ok(fs.readFileSync(path.join(dirB, inboxFile)).equals(payload))
  assert.ok(inboxFile.startsWith('.cowove/inbox/'))
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
  const res = await fetch(`http://127.0.0.1:${srv.port}/files/test`, { method: 'POST', headers: { 'x-cowove-secret': 'nope' }, body: 'x' })
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
  const conflicts = path.join(dirC, '.cowove', 'conflicts')
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

test('changes the file watcher never reports still sync', async () => {
  // macOS can drop fs events outright; simulate that by silencing A's watcher.
  await A.watcher.close()
  write(dirA, 'unseen/deep/new.txt', 'created unseen\n')
  write(dirA, 'watched.txt', 'v2')
  fs.rmSync(path.join(dirA, 'README.md'))
  await waitFor(() => read(dirB, 'unseen/deep/new.txt') === 'created unseen\n')
  await waitFor(() => read(dirB, 'watched.txt') === 'v2')
  await waitFor(() => read(dirB, 'README.md') === null)
})
