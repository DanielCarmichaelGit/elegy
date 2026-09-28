// Sessions with an owner: people wait to be let in, viewers can't change
// files, agents can be limited to folders, and the relay enforces all of it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'

let srv, server
const sessions = []
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `cowove-acc-${name}-`))
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

const EDIT = 'edit-secret'
const VIEW = 'view-secret'
let room = 0

async function open (dir, name, extra = {}) {
  const s = new Session({ dir, server, secret: EDIT, name, identity: generateIdentity(), ...extra })
  sessions.push(s)
  await s.start({ waitTimeoutMs: 5000 })
  return s
}

/** A fresh controlled room: the owner, plus a function to bring someone in. */
async function ownedRoom () {
  const r = `acc-${++room}`
  const ownerDir = tmp('owner')
  write(ownerDir, 'README.md', 'hello\n')
  write(ownerDir, 'src/app.js', 'app\n')
  const owner = await open(ownerDir, 'olive', { room: r, viewSecret: VIEW })
  await waitFor(() => owner.access && owner.access.owner)
  const bring = async (name, { secret = EDIT, kind = 'human', role, scopes } = {}) => {
    const dir = tmp(name)
    const s = await open(dir, name, { room: r, secret, kind })
    await waitFor(() => s.access && s.access.state === 'pending')
    const req = await waitFor(() => owner.waiting.find((p) => p.name === name))
    await owner.approve(req.key, { role, scopes })
    await waitFor(() => s.access.state === 'approved' && read(dir, 'README.md') === 'hello\n')
    return { s, dir, key: req.key }
  }
  return { owner, ownerDir, bring, room: r }
}

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: (m) => process.env.DBG && console.log('RELAY', m) })
  server = `ws://127.0.0.1:${srv.port}`
})
after(async () => {
  for (const s of sessions) await s.stop().catch(() => {})
  await srv.close()
})

test('joiners wait for the owner, then sync both ways as editors', async () => {
  const { owner, ownerDir, bring } = await ownedRoom()
  const { s: sam, dir, key } = await bring('sam')
  assert.equal(sam.access.role, 'editor')
  assert.equal(owner.waiting.length, 0)
  assert.ok(owner.members.some((m) => m.key === key && m.role === 'editor'))
  write(dir, 'src/app.js', 'app by sam\n')
  await waitFor(() => read(ownerDir, 'src/app.js') === 'app by sam\n')
  // Approved people come straight back in next time.
  await sam.stop()
  const again = await open(dir, 'sam', { room: sam.room, identity: sam.identity })
  await waitFor(() => again.access && again.access.state === 'approved')
})

test('nothing syncs to someone still waiting', async () => {
  const { room: r } = await ownedRoom()
  const dir = tmp('waiter')
  const w = await open(dir, 'wendy', { room: r })
  await waitFor(() => w.access && w.access.state === 'pending')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(read(dir, 'README.md'), null)
})

test('viewers can chat but their file changes are undone by the relay', async () => {
  const { owner, ownerDir, bring } = await ownedRoom()
  const { s: vic, dir } = await bring('vic', { secret: VIEW })
  assert.equal(vic.access.role, 'viewer', 'the view-only invite makes a viewer')
  // Their own cowove refuses the change and puts the shared file back.
  write(dir, 'README.md', 'vandalized\n')
  await waitFor(() => read(dir, 'README.md') === 'hello\n')
  // A client that ignores that (edits the doc directly) is undone by the relay.
  vic.doc.transact(() => vic.files.get('src/app.js').insert(0, 'EVIL '))
  await waitFor(() => vic.files.get('src/app.js').toString() === 'app\n')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(read(ownerDir, 'src/app.js'), 'app\n', 'the owner never saw it')
  await vic.say('looks good!')
  await waitFor(() => owner.messages({ markRead: false }).some((m) => m.text === 'looks good!'))
})

test('agents limited to folders can change only those', async () => {
  const { ownerDir, bring } = await ownedRoom()
  const { s: bot, dir } = await bring('helper bot', { kind: 'agent', scopes: ['src'] })
  assert.deepEqual(bot.access.scopes, ['src'])
  write(dir, 'src/app.js', 'app by bot\n')
  await waitFor(() => read(ownerDir, 'src/app.js') === 'app by bot\n')
  write(dir, 'README.md', 'bot was here\n')
  await waitFor(() => read(dir, 'README.md') === 'hello\n')
  bot.doc.transact(() => bot.files.get('README.md').insert(0, 'sneaky '))
  await waitFor(() => bot.files.get('README.md').toString() === 'hello\n')
  assert.equal(read(ownerDir, 'README.md'), 'hello\n')
})

test('the owner can change roles live, deny, and remove people', async () => {
  const { owner, room: r, bring } = await ownedRoom()
  const { s: vic, dir, key } = await bring('vic2', { secret: VIEW })
  await owner.setMember(key, { role: 'editor' })
  await waitFor(() => vic.access.role === 'editor')
  write(dir, 'notes.txt', 'now I can edit\n')
  await waitFor(() => owner.files.get('notes.txt')?.toString() === 'now I can edit\n')

  // Nobody but the owner can let people in.
  await assert.rejects(vic.approve('whatever'), /only the session owner/)

  const dDir = tmp('denied')
  const denied = new Session({ dir: dDir, server, room: r, secret: EDIT, name: 'dana', identity: generateIdentity() })
  sessions.push(denied)
  let fatal = null
  denied.on('fatal', (err) => { fatal = err })
  await denied.start({ waitTimeoutMs: 5000 })
  const req = await waitFor(() => owner.waiting.find((p) => p.name === 'dana'))
  await owner.deny(req.key)
  await waitFor(() => fatal)
  assert.match(fatal.message, /did not let you in/)

  let removed = null
  vic.on('fatal', (err) => { removed = err })
  await owner.removeMember(key)
  await waitFor(() => removed)
  assert.match(removed.message, /removed you/)
})

test('sessions without an owner (older clients) still let everyone edit', async () => {
  const r = 'legacy-room'
  const aDir = tmp('la')
  write(aDir, 'a.txt', 'a\n')
  const a = await open(aDir, 'al', { room: r })
  const bDir = tmp('lb')
  const b = await open(bDir, 'bo', { room: r })
  await waitFor(() => read(bDir, 'a.txt') === 'a\n')
  assert.equal(b.access.controlled, false)
  write(bDir, 'a.txt', 'b edit\n')
  await waitFor(() => read(aDir, 'a.txt') === 'b edit\n')
  assert.equal(a.waiting.length, 0)
})
