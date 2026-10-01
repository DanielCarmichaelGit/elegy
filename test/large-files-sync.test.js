// Big binary files travel encrypted through storage, not inside the session document.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'

let srv, server, dataDir
const sessions = []
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-lf-${n}-`))
const bytes = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel)) } catch { return null } }
async function waitFor (fn, ms = 8000) {
  const start = Date.now()
  let last
  while (Date.now() - start < ms) {
    try { last = await fn(); if (last) return last } catch (err) { last = err }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out; last value: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}
async function open (dir, name, extra) {
  const s = new Session({ dir, server, secret: 'edit', name, identity: generateIdentity(), ...extra })
  sessions.push(s)
  await s.start({ waitTimeoutMs: 5000 })
  return s
}
let n = 0
const big = () => crypto.randomBytes(300 * 1024)

before(async () => {
  dataDir = tmp('relay')
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: () => {} })
  server = `ws://127.0.0.1:${srv.port}`
})
after(async () => {
  for (const s of sessions) await s.stop().catch(() => {})
  await srv.close()
})

test('a large file reaches the other app, stored encrypted and not in the document', async () => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const img = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  const A = await open(dirA, 'alice', { room })
  const B = await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img))

  const entry = A.blobs.get('photo.png')
  assert.ok(entry.stored && entry.stored.id, 'stored, not inline')
  assert.equal(entry.data, undefined)
  assert.equal(entry.size, img.length)
  const onRelay = fs.readFileSync(path.join(dataDir, 'blobs', room, entry.stored.id))
  assert.ok(!onRelay.includes(img.subarray(5000, 5064)), 'the relay only has ciphertext')
  await waitFor(() => fs.existsSync(path.join(dataDir, `${room}.ydoc`)))
  assert.ok(fs.statSync(path.join(dataDir, `${room}.ydoc`)).size < 64 * 1024, 'the document stays small')

  const next = big()
  fs.writeFileSync(path.join(dirB, 'photo.png'), next)
  await waitFor(() => bytes(dirA, 'photo.png')?.equals(next))
  fs.rmSync(path.join(dirA, 'photo.png'))
  await waitFor(() => bytes(dirB, 'photo.png') === null)
  assert.equal(B.readShared('photo.png'), null)
})

test('small binary files and text still travel inside the document', async () => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const icon = crypto.randomBytes(4 * 1024)
  fs.writeFileSync(path.join(dirA, 'icon.png'), icon)
  fs.writeFileSync(path.join(dirA, 'big.txt'), 'x'.repeat(400 * 1024))
  const A = await open(dirA, 'alice', { room })
  await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'icon.png')?.equals(icon))
  await waitFor(() => bytes(dirB, 'big.txt')?.length === 400 * 1024)
  assert.ok(A.blobs.get('icon.png').data, 'small files stay inline')
  assert.ok(A.files.get('big.txt'), 'text stays text')
})

test('people who can only view can open large files', async () => {
  const room = `lf-${++n}`
  const ownerDir = tmp('owner')
  const img = big()
  fs.writeFileSync(path.join(ownerDir, 'hero.jpg'), img)
  const owner = await open(ownerDir, 'olive', { room, viewSecret: 'view' })
  await waitFor(() => owner.access && owner.access.owner)
  await waitFor(() => owner.blobs.get('hero.jpg')?.stored)
  const viewerDir = tmp('viewer')
  const viewer = await open(viewerDir, 'vic', { room, secret: 'view' })
  const req = await waitFor(() => owner.waiting.find((p) => p.name === 'vic'))
  await owner.approve(req.key, { role: 'viewer' })
  await waitFor(() => viewer.access && viewer.access.state === 'approved')
  await waitFor(() => bytes(viewerDir, 'hero.jpg')?.equals(img))
})

test('an owner can end the session for everyone', async () => {
  const room = `lf-${++n}`
  const ownerDir = tmp('owner')
  fs.writeFileSync(path.join(ownerDir, 'a.bin'), big())
  const owner = await open(ownerDir, 'olive', { room, viewSecret: 'view' })
  await waitFor(() => owner.blobs.get('a.bin')?.stored)
  const fatal = new Promise((resolve) => owner.on('fatal', resolve))
  await owner.endForEveryone()
  assert.equal((await fatal).ended, true)
  await waitFor(() => !fs.existsSync(path.join(dataDir, 'blobs', room)))
})

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex')
// Holds every download until released (only the receiving app downloads).
function holdDownloads (t) {
  const real = globalThis.fetch
  let release
  const gate = new Promise((resolve) => { release = resolve })
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/download') && (await gate) === 'fail') throw new Error('connection lost')
    return real(url, opts)
  }
  const restore = () => { globalThis.fetch = real }
  t.after(restore)
  return { release: (how = 'go') => release(how), restore }
}
// Every update before it has reached `to` once `to` sees this marker.
async function roundTrip (from, to) {
  const name = `marker-${crypto.randomBytes(3).toString('hex')}.txt`
  fs.writeFileSync(path.join(from.root, name), 'marker')
  await waitFor(() => to.files.get(name))
  return name
}

test('an older relay without file storage: large files travel inside the document', async (t) => {
  const real = globalThis.fetch
  globalThis.fetch = (url, opts) => String(url).includes('/blobs/') ? Promise.resolve(new Response('not found', { status: 404 })) : real(url, opts)
  t.after(() => { globalThis.fetch = real })
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const img = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  const A = await open(dirA, 'alice', { room })
  await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img))
  const entry = A.blobs.get('photo.png')
  assert.ok(entry.data, 'inline')
  assert.equal(entry.stored, undefined)
})

test('restarting before a download finished fetches the file instead of deleting it', async () => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const img = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  const A = await open(dirA, 'alice', { room })
  const B = await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img) && B.storedOnDisk.get('photo.png'))
  await B.stop()
  // As if the download never finished: no file, and no record of one.
  fs.rmSync(path.join(dirB, 'photo.png'))
  const stateJson = path.join(B.stateDir, 'state.json')
  const meta = JSON.parse(fs.readFileSync(stateJson, 'utf8'))
  delete meta.storedOnDisk
  fs.writeFileSync(stateJson, JSON.stringify(meta))

  const B2 = await open(dirB, 'bob', { room, identity: B.identity })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img))
  await roundTrip(B2, A)
  assert.ok(A.blobs.get('photo.png')?.stored, 'still shared')
  assert.ok(bytes(dirA, 'photo.png')?.equals(img))
})

test('restarting with an older version still on disk downloads the newer one instead of sharing the old', async (t) => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const img = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  const A = await open(dirA, 'alice', { room })
  const B = await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img) && B.storedOnDisk.get('photo.png'))

  const hold = holdDownloads(t)
  const next = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), next)
  await waitFor(() => B.blobs.get('photo.png')?.hash === sha1(next) && B.downloading.has('photo.png'))
  await B.stop()
  hold.release('fail')
  hold.restore()

  const B2 = await open(dirB, 'bob', { room, identity: B.identity })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(next))
  await roundTrip(B2, A)
  assert.equal(A.blobs.get('photo.png').hash, sha1(next), 'the old version was not shared again')
  assert.ok(bytes(dirA, 'photo.png')?.equals(next))
  assert.ok(!fs.existsSync(path.join(B2.stateDir, 'conflicts')), 'nothing was edited, so no conflict copy')
})

test('an edit made while a download is in flight is kept as a conflict copy', async (t) => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const img = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  const A = await open(dirA, 'alice', { room })
  const B = await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img) && B.storedOnDisk.get('photo.png'))

  const hold = holdDownloads(t)
  const next = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), next)
  await waitFor(() => B.downloading.has('photo.png'))
  const mine = big()
  fs.writeFileSync(path.join(dirB, 'photo.png'), mine)
  hold.release()
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(next))
  const conflicts = path.join(B.stateDir, 'conflicts')
  const [stamp] = fs.readdirSync(conflicts)
  assert.ok(fs.readFileSync(path.join(conflicts, stamp, 'photo.png')).equals(mine))
  await roundTrip(B, A)
  assert.equal(A.blobs.get('photo.png').hash, sha1(next))
})

test('uploading a file that is already stored counts as done', async (t) => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const img = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  const A = await open(dirA, 'alice', { room })
  const B = await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img))
  const id = A.blobs.get('photo.png').stored.id
  fs.rmSync(path.join(dirA, 'photo.png'))
  await waitFor(() => !B.blobs.has('photo.png') && bytes(dirB, 'photo.png') === null)

  // The same file again has the same id, and the relay already has it.
  const real = globalThis.fetch
  const puts = []
  globalThis.fetch = async (url, opts) => {
    const res = await real(url, opts)
    if (opts && opts.method === 'PUT') puts.push(res.status)
    return res
  }
  t.after(() => { globalThis.fetch = real })
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img))
  assert.deepEqual(puts, [409])
  assert.equal(A.blobs.get('photo.png').stored.id, id)
})
