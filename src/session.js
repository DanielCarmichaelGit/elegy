// A sync session: mirrors a project folder into a shared Yjs document and
// back. Any tool that edits files on disk (Claude Code, Cursor, Codex, vim...)
// participates automatically; concurrent edits are merged character by
// character by the CRDT.
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import * as Y from 'yjs'
import diff from 'fast-diff'
import { watch } from 'chokidar'
import { Connection } from './connection.js'
import {
  loadIgnore, isIgnored, isSafeRelPath, resolveInside, looksBinary, sha1, walk,
  toPosix, globMatcher, MAX_TEXT_BYTES, MAX_BINARY_BYTES
} from './fsutil.js'

const LOCAL = Symbol('local')
const COLORS = ['#e06c75', '#61afef', '#98c379', '#c678dd', '#e5c07b', '#56b6c2', '#d19a66']
const RECENT_MS = 2 * 60 * 1000

export class Session extends EventEmitter {
  constructor ({ dir, server, room, secret, name, tool = 'unknown', prefer = 'remote' }) {
    super()
    this.root = path.resolve(dir)
    this.server = server
    this.room = room
    this.secret = secret
    this.name = name
    this.tool = tool
    this.prefer = prefer
    this.stateDir = path.join(this.root, '.elegy')
    this.stateFile = path.join(this.stateDir, 'state.bin')

    this.doc = new Y.Doc()
    this.files = this.doc.getMap('files') // path -> Y.Text
    this.blobs = this.doc.getMap('blobs') // path -> { hash, data(base64) }
    this.claims = this.doc.getMap('claims') // pattern -> { by, pattern, note, ts }
    this.chat = this.doc.getArray('chat') // { by, text, ts }
    this.activity = this.doc.getArray('activity') // { by, path, kind, detail, ts }

    this.ig = loadIgnore(this.root)
    this.lastKnown = new Map() // path -> text content, or "bin:<sha1>"
    this.pending = new Set()
    this.flushTimer = null
    this.ready = false
    this.myEdits = new Map() // path -> ts of my last edit
    this.lastActivityPush = new Map()
    this.warnedLarge = new Set()
    this.agents = new Set()
    this.focus = ''
  }

  log (msg) { this.emit('log', msg) }

  async start ({ waitTimeoutMs = 0 } = {}) {
    fs.mkdirSync(this.stateDir, { recursive: true })
    const hadState = this.loadState()

    this.conn = new Connection({
      server: this.server,
      room: this.room,
      secret: this.secret,
      doc: this.doc,
      beforeRemote: () => { if (this.ready) this.flushPending() }
    })
    this.conn.on('status', (s) => { this.log(s === 'connected' ? `connected to relay` : 'disconnected from relay, reconnecting…'); this.scheduleStatusWrite() })
    this.conn.on('warn', (m) => this.emit('debug', m))
    this.conn.on('fatal', (err) => this.emit('fatal', err))
    this.setupPresence()

    if (hadState) {
      // We've synced this folder before: fold in anything edited while we were
      // away, then let the CRDT merge it with whatever the others did.
      this.reconcileOffline()
      this.goLive()
    } else {
      this.log('waiting for relay…')
      const sync = this.conn.waitForSync()
      if (waitTimeoutMs) {
        await Promise.race([sync, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out connecting to relay')), waitTimeoutMs))])
      } else {
        await sync
      }
      this.reconcileFirstJoin()
      this.goLive()
    }
    await this.startWatcher()
    return this
  }

  goLive () {
    this.files.observeDeep((events, tr) => {
      if (tr.origin === LOCAL) return
      const paths = new Set()
      for (const ev of events) {
        if (ev.target === this.files) for (const k of ev.changes.keys.keys()) paths.add(k)
        else if (ev.path.length) paths.add(ev.path[0])
      }
      for (const p of paths) this.writeOut(p)
    })
    this.blobs.observe((ev, tr) => {
      if (tr.origin === LOCAL) return
      for (const k of ev.changes.keys.keys()) this.writeOut(k)
    })
    this.chat.observe((ev, tr) => {
      if (tr.origin === LOCAL) return
      for (const item of ev.changes.added) {
        for (const msg of item.content.getContent()) if (msg && msg.by !== this.name) this.log(`💬 ${msg.by}: ${msg.text}`)
      }
      this.scheduleStatusWrite()
    })
    this.claims.observe((ev, tr) => {
      if (tr.origin === LOCAL) return
      for (const [key, change] of ev.changes.keys) {
        const c = this.claims.get(key)
        if (change.action !== 'delete' && c) this.log(`🔒 ${c.by} claimed ${c.pattern}${c.note ? ` — ${c.note}` : ''}`)
        else if (change.action === 'delete') this.log(`🔓 claim on ${key} released`)
      }
      this.scheduleStatusWrite()
    })
    this.activity.observe(() => this.scheduleStatusWrite())
    this.doc.on('update', () => this.scheduleStateSave())
    this.ready = true
    this.scheduleStateSave()
    this.scheduleStatusWrite()
  }

  // ---------------------------------------------------------------- state --

  loadState () {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'state.json'), 'utf8'))
      if (meta.room !== this.room || meta.server !== this.server) return false
      Y.applyUpdate(this.doc, fs.readFileSync(this.stateFile), LOCAL)
      return true
    } catch {
      return false
    }
  }

  scheduleStateSave () {
    if (this.stateTimer) return
    this.stateTimer = setTimeout(() => this.saveState(), 1000)
  }

  saveState () {
    clearTimeout(this.stateTimer)
    this.stateTimer = null
    const tmp = this.stateFile + '.tmp'
    fs.writeFileSync(tmp, Y.encodeStateAsUpdate(this.doc))
    fs.renameSync(tmp, this.stateFile)
    fs.writeFileSync(path.join(this.stateDir, 'state.json'), JSON.stringify({ room: this.room, server: this.server }))
  }

  // ------------------------------------------------------------ reconcile --

  sharedPaths () {
    return new Set([...this.files.keys(), ...this.blobs.keys()])
  }

  syncable (rel) {
    return isSafeRelPath(rel) && !isIgnored(this.ig, rel)
  }

  reconcileOffline () {
    const onDisk = new Set(walk(this.root, this.ig))
    for (const rel of this.sharedPaths()) {
      if (!this.syncable(rel)) continue
      const known = this.sharedKey(rel)
      if (known !== undefined) this.lastKnown.set(rel, known)
      if (!onDisk.has(rel)) this.ingest(rel) // deleted while offline
    }
    for (const rel of onDisk) this.ingest(rel)
  }

  reconcileFirstJoin () {
    const onDisk = new Set(walk(this.root, this.ig))
    let pulled = 0; let pushed = 0; let backedUp = 0
    const backupDir = path.join(this.stateDir, 'conflicts', new Date().toISOString().replace(/[:.]/g, '-'))
    for (const rel of this.sharedPaths()) {
      if (!this.syncable(rel)) continue
      const disk = this.readDisk(rel)
      const shared = this.sharedKey(rel)
      if (disk && disk.key === shared) { this.lastKnown.set(rel, shared); continue }
      if (disk && this.prefer === 'local') continue // pushed below
      if (disk) {
        const dest = path.join(backupDir, ...rel.split('/'))
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(path.join(this.root, ...rel.split('/')), dest)
        backedUp++
      }
      this.writeOut(rel)
      onDisk.delete(rel)
      pulled++
    }
    for (const rel of onDisk) {
      if (this.lastKnown.has(rel)) continue
      if (this.ingest(rel)) pushed++
    }
    this.log(`initial sync: ${pulled} file(s) pulled, ${pushed} pushed` +
      (backedUp ? `, ${backedUp} local version(s) backed up to ${path.relative(this.root, backupDir)}` : ''))
  }

  /** The shared content of a path in lastKnown format. */
  sharedKey (rel) {
    const t = this.files.get(rel)
    if (t) return t.toString()
    const b = this.blobs.get(rel)
    if (b) return `bin:${b.hash}`
    return undefined
  }

  readDisk (rel) {
    const abs = path.join(this.root, ...rel.split('/'))
    let st
    try { st = fs.lstatSync(abs) } catch { return null }
    if (!st.isFile()) return { skip: true }
    if (st.size > MAX_BINARY_BYTES) return { tooLarge: true }
    const buf = fs.readFileSync(abs)
    if (looksBinary(buf)) {
      const hash = sha1(buf)
      return { binary: true, buf, hash, key: `bin:${hash}` }
    }
    if (buf.length > MAX_TEXT_BYTES) return { tooLarge: true }
    const text = buf.toString('utf8')
    return { text, key: text }
  }

  // ------------------------------------------------------- local -> shared --

  queue (rel) {
    this.pending.add(rel)
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushPending(), 40)
  }

  flushPending () {
    clearTimeout(this.flushTimer)
    this.flushTimer = null
    const paths = [...this.pending]
    this.pending.clear()
    for (const rel of paths) {
      try { this.ingest(rel) } catch (err) { this.log(`could not sync ${rel}: ${err.message}`) }
    }
  }

  /** Pushes the on-disk state of a path into the shared doc. Returns true if anything changed. */
  ingest (rel) {
    if (!this.syncable(rel)) return false
    if (rel === '.gitignore' || rel === '.elegyignore') this.ig = loadIgnore(this.root)
    const disk = this.readDisk(rel)
    if (disk && (disk.skip || disk.tooLarge)) {
      if (disk.tooLarge && !this.warnedLarge.has(rel)) {
        this.warnedLarge.add(rel)
        this.log(`skipping ${rel}: file too large to sync`)
      }
      return false
    }

    if (!disk) {
      if (!this.files.has(rel) && !this.blobs.has(rel)) { this.lastKnown.delete(rel); return false }
      this.doc.transact(() => {
        this.files.delete(rel)
        this.blobs.delete(rel)
        this.recordActivity(rel, 'deleted', '')
      }, LOCAL)
      this.lastKnown.delete(rel)
      this.noteMyEdit(rel)
      return true
    }

    if (disk.key === this.sharedKey(rel)) { this.lastKnown.set(rel, disk.key); return false }

    let detail = ''
    this.doc.transact(() => {
      const existed = this.files.has(rel) || this.blobs.has(rel)
      if (disk.binary) {
        this.files.delete(rel)
        this.blobs.set(rel, { hash: disk.hash, data: disk.buf.toString('base64') })
        detail = `${disk.buf.length} bytes`
      } else {
        this.blobs.delete(rel)
        let ytext = this.files.get(rel)
        if (!ytext) {
          ytext = new Y.Text()
          this.files.set(rel, ytext)
        }
        detail = applyTextDiff(ytext, disk.text)
      }
      this.recordActivity(rel, existed ? 'edited' : 'created', detail)
    }, LOCAL)
    this.lastKnown.set(rel, disk.key)
    this.noteMyEdit(rel)
    return true
  }

  recordActivity (rel, kind, detail) {
    const now = Date.now()
    const last = this.lastActivityPush.get(rel)
    // Collapse bursts of edits to the same file into one entry.
    if (kind === 'edited' && last && now - last < 20000) return
    this.lastActivityPush.set(rel, now)
    this.activity.push([{ by: this.name, path: rel, kind, detail, ts: now }])
    if (this.activity.length > 300) this.activity.delete(0, this.activity.length - 300)
  }

  noteMyEdit (rel) {
    const now = Date.now()
    this.myEdits.set(rel, now)
    const claim = this.claimFor(rel)
    if (claim && claim.by !== this.name) {
      this.log(`⚠️  you changed ${rel}, which ${claim.by} has claimed${claim.note ? ` (${claim.note})` : ''}`)
    }
    this.updatePresence()
  }

  // ------------------------------------------------------- shared -> local --

  writeOut (rel) {
    if (!this.syncable(rel)) return
    let abs
    try { abs = resolveInside(this.root, rel) } catch (err) { this.log(err.message); return }
    const shared = this.sharedKey(rel)
    const disk = this.readDisk(rel)
    if (disk && (disk.skip || disk.tooLarge)) return
    const known = this.lastKnown.get(rel)

    if (this.ready && disk && disk.key !== known && disk.key !== shared) {
      // The file changed locally in the instant before this remote change
      // arrived. Keep a copy so nothing is lost.
      const dest = path.join(this.stateDir, 'conflicts', `${Date.now()}`, ...rel.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, disk.binary ? disk.buf : disk.text)
      this.log(`⚠️  simultaneous edit on ${rel}; your version saved to ${path.relative(this.root, dest)}`)
    }

    if (shared === undefined) {
      if (disk) {
        fs.rmSync(abs, { force: true })
        removeEmptyParents(this.root, path.dirname(abs))
      }
      this.lastKnown.delete(rel)
    } else {
      if (!disk || disk.key !== shared) {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        const t = this.files.get(rel)
        fs.writeFileSync(abs, t ? t.toString() : Buffer.from(this.blobs.get(rel).data, 'base64'))
      }
      this.lastKnown.set(rel, shared)
    }
    if (rel === '.gitignore' || rel === '.elegyignore') this.ig = loadIgnore(this.root)

    if (this.ready) {
      const mine = this.myEdits.get(rel)
      if (mine && Date.now() - mine < RECENT_MS) {
        const who = this.lastEditorOf(rel)
        this.log(`👀 ${who || 'your partner'} just changed ${rel}, which you edited recently`)
      }
    }
  }

  lastEditorOf (rel) {
    for (let i = this.activity.length - 1; i >= 0; i--) {
      const a = this.activity.get(i)
      if (a.path === rel) return a.by === this.name ? null : a.by
    }
    return null
  }

  // --------------------------------------------------------------- watcher --

  async startWatcher () {
    this.watcher = watch(this.root, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (p) => {
        const rel = toPosix(path.relative(this.root, p))
        return rel !== '' && !rel.startsWith('..') && isIgnored(this.ig, rel)
      }
    })
    const onFile = (p) => {
      const rel = toPosix(path.relative(this.root, p))
      if (rel && !rel.startsWith('..')) this.queue(rel)
    }
    this.watcher.on('add', onFile).on('change', onFile).on('unlink', onFile)
    this.watcher.on('unlinkDir', (p) => {
      const relDir = toPosix(path.relative(this.root, p))
      for (const rel of this.sharedPaths()) if (rel.startsWith(relDir + '/')) this.queue(rel)
    })
    this.watcher.on('error', (err) => this.log(`watcher error: ${err.message}`))
    await new Promise((resolve) => this.watcher.once('ready', resolve))
  }

  // ----------------------------------------------------- presence & social --

  setupPresence () {
    const color = COLORS[Math.abs(hashCode(this.name)) % COLORS.length]
    this.conn.awareness.setLocalState({ name: this.name, tool: this.tool, color, focus: '', editing: {}, agents: [] })
    this.conn.awareness.on('change', ({ added, removed }, origin) => {
      if (origin === 'local' || origin === 'connection') return
      for (const id of added) {
        const s = this.conn.awareness.getStates().get(id)
        if (s && id !== this.doc.clientID) this.log(`👋 ${s.name} joined (${s.tool})`)
      }
      if (removed.length) this.log(`${removed.length === 1 ? 'a partner' : `${removed.length} partners`} left`)
      this.scheduleStatusWrite()
    })
  }

  updatePresence () {
    const now = Date.now()
    if (this.presenceTimer) return
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null
      const editing = {}
      for (const [p, ts] of this.myEdits) {
        if (now - ts < RECENT_MS * 2) editing[p] = ts
        else this.myEdits.delete(p)
      }
      this.conn.awareness.setLocalStateField('editing', editing)
    }, 500)
  }

  setFocus (text) {
    this.focus = String(text || '').slice(0, 500)
    this.conn.awareness.setLocalStateField('focus', this.focus)
    this.scheduleStatusWrite()
  }

  addAgent (client) {
    if (!client) return
    this.agents.add(String(client).slice(0, 80))
    this.conn.awareness.setLocalStateField('agents', [...this.agents])
  }

  say (text) {
    const msg = { by: this.name, text: String(text).slice(0, 4000), ts: Date.now() }
    this.doc.transact(() => {
      this.chat.push([msg])
      if (this.chat.length > 500) this.chat.delete(0, this.chat.length - 500)
    }, LOCAL)
    this.scheduleStatusWrite()
    return msg
  }

  claim (pattern, note = '') {
    pattern = String(pattern).trim()
    if (!pattern) throw new Error('pattern required')
    const existing = this.claims.get(pattern)
    if (existing && existing.by !== this.name) throw new Error(`${pattern} is already claimed by ${existing.by}`)
    const overlap = this.claimsOverlapping(pattern).filter((c) => c.by !== this.name)
    this.doc.transact(() => this.claims.set(pattern, { by: this.name, pattern, note: String(note).slice(0, 500), ts: Date.now() }), LOCAL)
    this.scheduleStatusWrite()
    return { ok: true, overlapping: overlap }
  }

  release (pattern) {
    if (pattern === '*' || pattern === undefined) {
      const mine = [...this.claims.values()].filter((c) => c.by === this.name)
      this.doc.transact(() => { for (const c of mine) this.claims.delete(c.pattern) }, LOCAL)
      this.scheduleStatusWrite()
      return mine.length
    }
    const c = this.claims.get(pattern)
    if (!c) return 0
    this.doc.transact(() => this.claims.delete(pattern), LOCAL)
    this.scheduleStatusWrite()
    return 1
  }

  claimFor (rel) {
    for (const c of this.claims.values()) if (globMatcher(c.pattern)(rel)) return c
    return null
  }

  claimsOverlapping (pattern) {
    const m = globMatcher(pattern)
    const files = [...this.sharedPaths()].filter((p) => m(p))
    return [...this.claims.values()].filter((c) => {
      if (c.pattern === pattern) return true
      const cm = globMatcher(c.pattern)
      return cm(pattern) || m(c.pattern) || files.some((f) => cm(f))
    })
  }

  status () {
    const now = Date.now()
    const states = this.conn ? this.conn.awareness.getStates() : new Map()
    const peers = []
    for (const [id, s] of states) {
      if (id === this.doc.clientID || !s || !s.name) continue
      peers.push({
        name: s.name,
        tool: s.tool,
        agents: s.agents || [],
        focus: s.focus || '',
        editing: Object.entries(s.editing || {})
          .sort((a, b) => b[1] - a[1])
          .map(([p, ts]) => ({ path: p, secondsAgo: Math.round((now - ts) / 1000) }))
      })
    }
    return {
      room: this.room,
      server: this.server,
      connected: !!(this.conn && this.conn.connected),
      me: { name: this.name, tool: this.tool, focus: this.focus, agents: [...this.agents] },
      peers,
      claims: [...this.claims.values()].sort((a, b) => a.ts - b.ts),
      activity: this.activity.toArray().slice(-30),
      chat: this.chat.toArray().slice(-20),
      fileCount: this.files.size + this.blobs.size
    }
  }

  scheduleStatusWrite () {
    if (this.statusTimer || !this.ready) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      this.emit('status-changed')
    }, 300)
  }

  async stop () {
    this.ready = false
    if (this.watcher) await this.watcher.close()
    this.flushPending()
    clearTimeout(this.statusTimer)
    clearTimeout(this.presenceTimer)
    if (this.conn) this.conn.close()
    this.saveState()
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Applies the minimal set of inserts/deletes to turn ytext into `next`. */
export function applyTextDiff (ytext, next) {
  const prev = ytext.toString()
  if (prev === next) return ''
  let pos = 0; let added = 0; let removed = 0
  for (const [op, str] of diff(prev, next)) {
    if (op === diff.EQUAL) pos += str.length
    else if (op === diff.DELETE) { ytext.delete(pos, str.length); removed += countLines(str) } else { ytext.insert(pos, str); pos += str.length; added += countLines(str) }
  }
  return `+${added} -${removed}`
}

function countLines (s) {
  const n = s.split('\n').length - 1
  return n || 1
}

function hashCode (s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

function removeEmptyParents (root, dir) {
  while (dir.startsWith(root + path.sep)) {
    try { fs.rmdirSync(dir) } catch { return }
    dir = path.dirname(dir)
  }
}
