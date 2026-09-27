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

test('offline edits merge when a client comes back', async () => {
  write(dirA, 'offline.txt', 'top\nmiddle\nbottom\n')
  await waitFor(() => read(dirB, 'offline.txt') === 'top\nmiddle\nbottom\n')
  await B.stop()
  sessions.splice(sessions.indexOf(B), 1)
  write(dirB, 'offline.txt', 'top (bob offline)\nmiddle\nbottom\n')
  write(dirB, 'bob-only.txt', 'made on a plane\n')
  write(dirA, 'offline.txt', 'top\nmiddle\nbottom (alice)\n')
  await new Promise((r) => setTimeout(r, 200))
  B = await open(dirB, 'bob')
  const expected = 'top (bob offline)\nmiddle\nbottom (alice)\n'
  await waitFor(() => read(dirA, 'offline.txt') === expected && read(dirB, 'offline.txt') === expected)
  await waitFor(() => read(dirA, 'bob-only.txt') === 'made on a plane\n')
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
