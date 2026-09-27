import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { startCursorReader, findWorkspace } from '../src/agents/cursor.js'

let sqlite = null
try { sqlite = await import('node:sqlite') } catch {}
const skip = !sqlite && 'node:sqlite not available'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function makeCursor () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elegy-cursor-'))
  const userDir = path.join(root, 'User')
  const project = path.join(root, 'proj')
  const otherProject = path.join(root, 'other')
  fs.mkdirSync(project)
  const mkWs = (name, folder) => {
    const d = path.join(userDir, 'workspaceStorage', name)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(folder).href }))
    const db = new sqlite.DatabaseSync(path.join(d, 'state.vscdb'))
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
    return db
  }
  const wsDb = mkWs('aaa', project)
  const otherDb = mkWs('bbb', otherProject)
  fs.mkdirSync(path.join(userDir, 'globalStorage'), { recursive: true })
  const g = new sqlite.DatabaseSync(path.join(userDir, 'globalStorage', 'state.vscdb'))
  g.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')

  const put = (db, table, key, value) => db.prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value))
  const convs = {}
  const setComposers = (db, list) => put(db, 'ItemTable', 'composer.composerData', { allComposers: list })
  function addBubble (cid, bubbleId, bubble, db = wsDb) {
    convs[cid] = convs[cid] || []
    if (!convs[cid].includes(bubbleId)) convs[cid].push(bubbleId)
    put(g, 'cursorDiskKV', `bubbleId:${cid}:${bubbleId}`, { bubbleId, ...bubble })
    put(g, 'cursorDiskKV', `composerData:${cid}`, { _v: 3, composerId: cid, fullConversationHeadersOnly: convs[cid].map((b) => ({ bubbleId: b, type: 1 })) })
  }
  return { root, userDir, project, otherProject, wsDb, otherDb, g, put, setComposers, addBubble }
}

test('finds the workspace for a folder', { skip }, () => {
  const c = makeCursor()
  assert.equal(findWorkspace(c.userDir, c.project), path.join(c.userDir, 'workspaceStorage', 'aaa'))
  assert.equal(findWorkspace(c.userDir, path.join(c.root, 'nope')), null)
})

test('maps bubbles for this folder only, then follows live updates', { skip }, async () => {
  const c = makeCursor()
  const t0 = Date.now()
  c.addBubble('c1', 'b1', { type: 1, text: 'Make the header sticky' })
  c.addBubble('c1', 'b2', { type: 2, text: 'Done, I updated the CSS.', toolFormerData: { name: 'edit_file', rawArgs: JSON.stringify({ target_file: 'src/header.css' }) } })
  c.setComposers(c.wsDb, [{ composerId: 'c1', lastUpdatedAt: t0 }])
  c.addBubble('x1', 'bx', { type: 1, text: 'other project secret' }, c.otherDb)
  c.setComposers(c.otherDb, [{ composerId: 'x1', lastUpdatedAt: t0 }])

  const entries = []
  const states = []
  let clock = t0
  const r = startCursorReader({ dir: c.project, userDir: c.userDir, pollMs: 20, now: () => clock, onEntries: (e) => entries.push(...e), onState: (s) => states.push(s) })
  await wait(100)
  assert.deepEqual(entries.map((e) => [e.kind, e.text]), [
    ['prompt', 'Make the header sticky'],
    ['reply', 'Done, I updated the CSS.'],
    ['action', 'Edited src/header.css']
  ])
  assert.ok(entries.every((e) => e.conv === 'c1' && e.tool === 'Cursor'))

  // A new prompt and a streaming reply: the reply is only shared once it settles.
  clock += 1000
  c.addBubble('c1', 'b3', { type: 1, text: 'Now make it blue' })
  c.addBubble('c1', 'b4', { type: 2, text: 'Work' })
  c.setComposers(c.wsDb, [{ composerId: 'c1', lastUpdatedAt: clock }])
  await wait(100)
  assert.equal(entries.at(-1).text, 'Now make it blue')
  assert.equal(states.at(-1).status, 'working')
  c.addBubble('c1', 'b4', { type: 2, text: 'Working on it: made it blue.' })
  c.setComposers(c.wsDb, [{ composerId: 'c1', lastUpdatedAt: clock + 1 }])
  await wait(100)
  assert.equal(entries.at(-1).text, 'Now make it blue', 'still streaming')
  clock += 5000
  await wait(100)
  assert.equal(entries.at(-1).text, 'Working on it: made it blue.')
  clock += 20000
  await wait(100)
  assert.equal(states.at(-1).status, 'idle')
  r.stop()
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length)
})

test('old conversations are not backfilled', { skip }, async () => {
  const c = makeCursor()
  c.addBubble('old', 'o1', { type: 1, text: 'from last week' })
  c.setComposers(c.wsDb, [{ composerId: 'old', lastUpdatedAt: Date.now() - 7 * 86400e3 }])
  const entries = []
  const r = startCursorReader({ dir: c.project, userDir: c.userDir, pollMs: 20, onEntries: (e) => entries.push(...e), onState: () => {} })
  await wait(80)
  r.stop()
  assert.equal(entries.length, 0)
})

test('an unrecognized layout reports unavailable instead of crashing', { skip }, async () => {
  const c = makeCursor()
  c.g.exec('DROP TABLE cursorDiskKV')
  c.setComposers(c.wsDb, [{ composerId: 'c1', lastUpdatedAt: Date.now() }])
  const states = []
  const logs = []
  startCursorReader({ dir: c.project, userDir: c.userDir, pollMs: 20, onEntries: () => {}, onState: (s) => states.push(s), onLog: (l) => logs.push(l) })
  await wait(80)
  assert.equal(states.at(-1).status, 'unavailable')
  assert.match(states.at(-1).reason, /layout isn't recognized/)
  assert.equal(logs.length, 1)
})

test('no Cursor install: stays idle quietly', { skip }, async () => {
  const states = []
  const r = startCursorReader({ dir: os.tmpdir(), userDir: path.join(os.tmpdir(), 'no-cursor-here'), pollMs: 20, onEntries: () => {}, onState: (s) => states.push(s) })
  await wait(60)
  r.stop()
  assert.deepEqual(states.map((s) => s.status), ['idle'])
})
