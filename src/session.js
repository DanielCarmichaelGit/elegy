// A sync session: mirrors a project folder into a shared Yjs document and
// back. Any tool that edits files on disk (Claude Code, Cursor, Codex, vim...)
// participates automatically; concurrent edits are merged character by
// character by the CRDT.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as Y from 'yjs'
import diff from 'fast-diff'
import { watch } from 'chokidar'
import { Connection } from './connection.js'
import { loadIdentity } from './identity.js'
import { MAX_SHARED_FILE_BYTES } from './protocol.js'
import { formatBytes } from './status.js'
import {
  loadIgnore, isIgnored, isSafeRelPath, resolveInside, looksBinary, sha1, walk,
  toPosix, globMatcher, MAX_TEXT_BYTES, MAX_BINARY_BYTES
} from './fsutil.js'

const LOCAL = Symbol('local')
const COLORS = ['#b9432b', '#3b6a9a', '#4a7a45', '#855a9c', '#a8701c', '#2e7a80', '#9c4f6b']
const RECENT_MS = 2 * 60 * 1000
const AGENT_FEED_CAP = 300
// chokidar drops a 'change' for a path within 50ms of the previous one (no
// trailing event), so each change is re-checked once that window has passed.
const WATCH_RECHECK_MS = 80

export class Session extends EventEmitter {
  constructor ({ dir, server, room, secret, key = '', name, tool = 'unknown', color = null, prefer = 'remote', kind = 'human', shareAgent = true, identity = null }) {
    super()
    this.root = path.resolve(dir)
    this.server = server
    this.room = room
    this.secret = secret
    this.key = key
    this.name = name
    this.identity = identity
    this.tool = tool
    this.color = color
    this.prefer = prefer
    this.stateDir = path.join(this.root, '.cowove')
    this.stateFile = path.join(this.stateDir, 'state.bin')

    this.doc = new Y.Doc()
    this.files = this.doc.getMap('files') // path -> Y.Text
    this.blobs = this.doc.getMap('blobs') // path -> { hash, data(base64) }
    // pattern -> { by, pattern, note, ts }. The relay owns claims (it checks
    // who asks), so they live outside the shared doc; we keep the last list.
    this.claims = new Map()
    this.chat = this.doc.getArray('chat') // { by, text, ts }
    this.activity = this.doc.getArray('activity') // { by, path, kind, detail, ts }
    this.agentFeed = this.doc.getArray('agentFeed') // { id, by, tool, conv, kind, text, ts }

    this.ig = loadIgnore(this.root)
    this.lastKnown = new Map() // path -> text content, or "bin:<sha1>"
    this.pending = new Set()
    this.flushTimer = null
    this.rechecks = new Map() // path -> timer
    this.ready = false
    this.myEdits = new Map() // path -> ts of my last edit
    this.lastActivityPush = new Map()
    this.warnedLarge = new Set()
    this.agents = new Set()
    this.focus = ''
    this.kind = kind === 'agent' ? 'agent' : 'human' // an AI agent that joined by itself
    this.agentSharing = shareAgent !== false
    this.agentState = null
  }

  log (msg) { this.emit('log', msg) }

  async start ({ waitTimeoutMs = 0 } = {}) {
    fs.mkdirSync(this.stateDir, { recursive: true })
    const hadState = this.loadState()
    if (hadState) this.loadClaims()

    this.conn = new Connection({
      server: this.server,
      room: this.room,
      secret: this.secret,
      key: this.key,
      name: this.name,
      identity: this.identity || loadIdentity(),
      doc: this.doc,
      beforeRemote: () => { if (this.ready) this.flushPending() }
    })
    this.conn.on('status', (s) => { this.log(s === 'connected' ? `connected to relay` : 'disconnected from relay, reconnecting…'); this.scheduleStatusWrite() })
    this.conn.on('warn', (m) => this.emit('debug', m))
    this.conn.on('fatal', (err) => this.emit('fatal', err))
    this.conn.on('claims', (list) => this.setClaims(list))
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
      for (const p of paths) this.fromRemote(p)
    })
    this.blobs.observe((ev, tr) => {
      if (tr.origin === LOCAL) return
      for (const k of ev.changes.keys.keys()) this.fromRemote(k)
    })
    this.chat.observe((ev, tr) => {
      for (const item of ev.changes.added) {
        for (const msg of item.content.getContent()) {
          if (!msg || !this.canSee(msg)) continue
          this.emit('message', this.describeMessage(msg))
          if (tr.origin === LOCAL || msg.by === this.name) continue
          this.log(`💬 ${formatMessage(msg)}`)
          if (msg.file) {
            this.fetchFile(msg).then(
              (dest) => this.log(`📎 received ${msg.file.name} from ${msg.by} → ${path.relative(this.root, dest)}`),
              (err) => this.log(`could not download ${msg.file.name}: ${err.message} (retry with: cowove get ${msg.id})`)
            )
          }
        }
      }
      this.scheduleStatusWrite()
    })
    this.activity.observe(() => this.scheduleStatusWrite())
    this.agentFeed.observe((ev) => {
      const added = []
      for (const item of ev.changes.added) for (const e of item.content.getContent()) if (e && e.id) added.push(e)
      if (added.length) this.emit('agent-feed', added)
    })
    this.doc.on('update', () => this.scheduleStateSave())
    this.ready = true
    this.fetchMissedFiles()
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
    if (rel === '.gitignore' || rel === '.cowoveignore') this.ig = loadIgnore(this.root)
    const disk = this.readDisk(rel)
    if (disk && (disk.skip || disk.tooLarge)) {
      if (disk.tooLarge && !this.warnedLarge.has(rel)) {
        this.warnedLarge.add(rel)
        this.log(`skipping ${rel}: file too large to sync`)
      }
      return false
    }

    const claim = this.claimFor(rel)
    if (claim && claim.by !== this.name && (disk ? disk.key : undefined) !== this.sharedKey(rel)) {
      this.rejectClaimed(rel, disk, claim)
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

  /** Someone else claimed rel: keep our version aside and put the shared one back on disk. */
  rejectClaimed (rel, disk, claim) {
    let kept = ''
    if (disk) {
      const dest = path.join(this.stateDir, 'rejected', `${Date.now()}`, ...rel.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, disk.binary ? disk.buf : disk.text)
      kept = `; your version saved to ${path.relative(this.root, dest)}`
    }
    const abs = path.join(this.root, ...rel.split('/'))
    const t = this.files.get(rel)
    const b = this.blobs.get(rel)
    if (t || b) {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, t ? t.toString() : Buffer.from(b.data, 'base64'))
      this.lastKnown.set(rel, this.sharedKey(rel))
    } else {
      fs.rmSync(abs, { force: true })
      removeEmptyParents(this.root, path.dirname(abs))
      this.lastKnown.delete(rel)
    }
    this.log(`🔒 ${rel} is claimed by ${claim.by}${claim.note ? ` (${claim.note})` : ''}, so your change was undone${kept}`)
    this.emit('file-changed', { path: rel, by: claim.by })
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
    this.emit('file-changed', { path: rel, by: this.name })
    this.myEdits.set(rel, now)
    this.updatePresence()
  }

  // ------------------------------------------------------- shared -> local --

  fromRemote (rel) {
    const claim = this.claimFor(rel)
    if (claim && claim.by === this.name) this.reclaim(rel)
    else this.writeOut(rel)
  }

  /**
   * A partner changed a path we claimed (their cowove should have refused, so
   * it's an old or misbehaving client): keep their version aside and put ours
   * back into the shared doc.
   */
  reclaim (rel) {
    if (!this.syncable(rel)) return
    const t = this.files.get(rel)
    const b = this.blobs.get(rel)
    if ((t || b) && this.sharedKey(rel) !== this.lastKnown.get(rel)) {
      const dest = path.join(this.stateDir, 'rejected', `${Date.now()}`, ...rel.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, t ? t.toString() : Buffer.from(b.data, 'base64'))
    }
    // Outside the observer, so the revert goes out as its own update.
    queueMicrotask(() => {
      try {
        if (this.ingest(rel)) this.log(`🔒 reverted a partner's change to ${rel}, which you claimed; theirs is in .cowove/rejected`)
      } catch (err) { this.log(`could not revert ${rel}: ${err.message}`) }
    })
  }

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
    if (rel === '.gitignore' || rel === '.cowoveignore') this.ig = loadIgnore(this.root)

    if (this.ready) {
      this.emit('file-changed', { path: rel, by: this.lastEditorOf(rel) || 'partner' })
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
    const onChange = (p) => {
      onFile(p)
      const rel = toPosix(path.relative(this.root, p))
      if (!rel || rel.startsWith('..')) return
      clearTimeout(this.rechecks.get(rel))
      this.rechecks.set(rel, setTimeout(() => { this.rechecks.delete(rel); if (this.ready) this.queue(rel) }, WATCH_RECHECK_MS))
    }
    this.watcher.on('add', onFile).on('change', onChange).on('unlink', onFile)
    this.watcher.on('unlinkDir', (p) => {
      const relDir = toPosix(path.relative(this.root, p))
      for (const rel of this.sharedPaths()) if (rel.startsWith(relDir + '/')) this.queue(rel)
    })
    this.watcher.on('error', (err) => this.log(`watcher error: ${err.message}`))
    await new Promise((resolve) => this.watcher.once('ready', resolve))
  }

  // ----------------------------------------------------- presence & social --

  setupPresence () {
    const color = this.color || COLORS[Math.abs(hashCode(this.name)) % COLORS.length]
    this.conn.awareness.setLocalState({
      name: this.name, tool: this.tool, color, focus: '', editing: {}, agents: [], kind: this.kind,
      agent: { tool: null, status: 'idle', sharing: this.agentSharing }
    })
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

  // ------------------------------------------------------------ messaging --

  /**
   * Posts a chat message. `to` makes it a direct message: it is only shown to
   * that person (it still travels through the shared room, so it isn't secret
   * from the relay or a modified client).
   */
  say (text, { to = null, file = null } = {}) {
    text = String(text || '').slice(0, 4000)
    if (!text && !file) throw new Error('message is empty')
    to = to ? String(to).trim() : null
    if (to === this.name) throw new Error('that is you')
    const msg = { id: crypto.randomBytes(8).toString('hex'), by: this.name, to, text, ts: Date.now() }
    if (file) msg.file = file
    this.doc.transact(() => {
      this.chat.push([msg])
      if (this.chat.length > 500) this.chat.delete(0, this.chat.length - 500)
    }, LOCAL)
    this.markRead([msg.id])
    this.scheduleStatusWrite()
    const online = !to || this.peerNames().includes(to)
    return { ...this.describeMessage(msg), recipientOnline: online }
  }

  /** Uploads a file to the relay and posts it as a message. */
  async sendFile (filePath, { to = null, text = '' } = {}) {
    const abs = path.resolve(this.root, filePath)
    const st = fs.statSync(abs)
    if (!st.isFile()) throw new Error(`${filePath} is not a file`)
    if (st.size > MAX_SHARED_FILE_BYTES) throw new Error(`${filePath} is larger than ${MAX_SHARED_FILE_BYTES / 1024 / 1024} MB`)
    const res = await fetch(`${this.httpBase()}/files/${encodeURIComponent(this.room)}`, {
      method: 'POST',
      headers: { 'x-cowove-secret': this.secret, 'content-type': 'application/octet-stream', ...(this.key ? { 'x-cowove-key': this.key } : {}) },
      body: fs.readFileSync(abs)
    })
    if (!res.ok) throw new Error(`upload failed: ${await res.text()}`)
    const fileId = await res.text()
    return this.say(text, { to, file: { id: fileId, name: path.basename(abs), size: st.size } })
  }

  /** Downloads a message's attachment (to .cowove/inbox/ by default). */
  async fetchFile (msgOrId, dest) {
    const msg = typeof msgOrId === 'string' ? this.chat.toArray().find((m) => m.id === msgOrId || (m.file && m.file.id === msgOrId)) : msgOrId
    if (!msg || !msg.file || !this.canSee(msg)) throw new Error('no such file')
    const target = dest ? path.resolve(dest) : this.inboxPath(msg)
    const finalPath = fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, safeName(msg.file.name)) : target
    const res = await fetch(`${this.httpBase()}/files/${encodeURIComponent(this.room)}/${msg.file.id}`, {
      headers: { 'x-cowove-secret': this.secret }
    })
    if (!res.ok) throw new Error(`download failed: ${await res.text()}`)
    fs.mkdirSync(path.dirname(finalPath), { recursive: true })
    fs.writeFileSync(finalPath, Buffer.from(await res.arrayBuffer()))
    return finalPath
  }

  /** Downloads unread files that were sent while we were offline. */
  fetchMissedFiles () {
    for (const m of this.messages({ unreadOnly: true, markRead: false, limit: 50 })) {
      if (!m.file || m.file.localPath) continue
      this.fetchFile(m.id).then(
        (dest) => this.log(`📎 received ${m.file.name} from ${m.by} while you were away → ${path.relative(this.root, dest)}`),
        () => {}
      )
    }
  }

  inboxPath (msg) {
    return path.join(this.stateDir, 'inbox', `${msg.id.slice(0, 6)}-${safeName(msg.file.name)}`)
  }

  httpBase () {
    return this.server.replace(/^ws/, 'http').replace(/\/+$/, '')
  }

  canSee (msg) {
    return !msg.to || msg.to === this.name || msg.by === this.name
  }

  peerNames () {
    return this.status().peers.map((p) => p.name)
  }

  describeMessage (msg) {
    const out = { ...msg, unread: msg.by !== this.name && !this.readIds().has(msg.id) }
    if (msg.file) {
      const local = this.inboxPath(msg)
      out.file = { ...msg.file, localPath: fs.existsSync(local) ? path.relative(this.root, local) : null }
    }
    return out
  }

  /** Messages visible to me, oldest first. */
  messages ({ limit = 50, unreadOnly = false, markRead = true, withName = null } = {}) {
    let list = this.chat.toArray().filter((m) => m && m.id && this.canSee(m))
    if (withName) list = list.filter((m) => m.by === withName || m.to === withName)
    let out = list.map((m) => this.describeMessage(m))
    if (unreadOnly) out = out.filter((m) => m.unread)
    out = out.slice(-limit)
    if (markRead) this.markRead(out.map((m) => m.id))
    return out
  }

  unreadCount () {
    const read = this.readIds()
    return this.chat.toArray().filter((m) => m && m.id && this.canSee(m) && m.by !== this.name && !read.has(m.id)).length
  }

  readIds () {
    if (!this._read) {
      try { this._read = new Set(JSON.parse(fs.readFileSync(path.join(this.stateDir, 'read.json'), 'utf8'))) } catch { this._read = new Set() }
    }
    return this._read
  }

  markRead (ids) {
    const read = this.readIds()
    let changed = false
    for (const id of ids) if (!read.has(id)) { read.add(id); changed = true }
    if (!changed) return
    const live = new Set(this.chat.toArray().map((m) => m && m.id))
    for (const id of read) if (!live.has(id)) read.delete(id)
    try { fs.writeFileSync(path.join(this.stateDir, 'read.json'), JSON.stringify([...read])) } catch {}
    this.scheduleStatusWrite()
  }

  /** Asks the relay for a claim; it refuses overlaps with anyone else's. */
  async claim (pattern, note = '') {
    pattern = String(pattern ?? '').trim()
    if (!pattern) throw new Error('pattern required')
    await this.conn.claimRequest({ op: 'claim', pattern, note: String(note) })
    return { ok: true }
  }

  /** Releases one of our claims, or all of them with '*'. Resolves to the number released. */
  async release (pattern = '*') {
    const r = await this.conn.claimRequest({ op: 'release', pattern: String(pattern) })
    return r.released || 0
  }

  /** Takes the relay's claim list, logging what changed. */
  setClaims (list) {
    const next = new Map()
    for (const c of Array.isArray(list) ? list : []) if (c && typeof c.pattern === 'string' && typeof c.by === 'string') next.set(c.pattern, c)
    if (this.ready) {
      for (const [p, c] of next) {
        const was = this.claims.get(p)
        if (c.by !== this.name && (!was || was.by !== c.by)) this.log(`🔒 ${c.by} claimed ${c.pattern}${c.note ? ` — ${c.note}` : ''}`)
      }
      for (const [p, c] of this.claims) if (!next.has(p) && c.by !== this.name) this.log(`🔓 ${c.by} released ${p}`)
    }
    this.claims = next
    try { fs.writeFileSync(path.join(this.stateDir, 'claims.json'), JSON.stringify([...next.values()])) } catch {}
    this.scheduleStatusWrite()
    this.emit('claims', [...next.values()])
  }

  /** Last known claims, so they're enforced before the relay answers (or while offline). */
  loadClaims () {
    try {
      for (const c of JSON.parse(fs.readFileSync(path.join(this.stateDir, 'claims.json'), 'utf8'))) this.claims.set(c.pattern, c)
    } catch {}
  }

  /**
   * The claim that owns rel. The relay refuses overlapping claims, but a glob
   * pair can start overlapping once a new file matches both; every client
   * then picks the same owner: the earliest claim (ties broken by name, then
   * pattern).
   */
  claimFor (rel) {
    let owner = null
    for (const c of this.claims.values()) {
      if (!c || !globMatcher(c.pattern)(rel)) continue
      if (!owner || c.ts < owner.ts || (c.ts === owner.ts && (c.by < owner.by || (c.by === owner.by && c.pattern < owner.pattern)))) owner = c
    }
    return owner
  }

  // ------------------------------------------------------------ AI feed --

  /** Adds entries from this person's AI chat reader. Dedupes by id, keeps the newest 300 per person. */
  pushAgentEntries (entries) {
    if (!this.agentSharing || !entries || !entries.length) return 0
    const mine = new Set()
    for (const e of this.agentFeed) if (e && e.by === this.name) mine.add(e.id)
    const fresh = []
    for (const e of entries) {
      if (!e || !e.id || mine.has(e.id)) continue
      mine.add(e.id)
      fresh.push({ id: String(e.id), by: this.name, tool: e.tool || null, conv: e.conv || null, kind: e.kind, text: String(e.text || ''), ts: e.ts || Date.now() })
    }
    if (!fresh.length) return 0
    this.doc.transact(() => {
      this.agentFeed.push(fresh)
      this.trimAgentFeed()
    }, LOCAL)
    return fresh.length
  }

  trimAgentFeed (cap = AGENT_FEED_CAP) {
    const idx = []
    this.agentFeed.forEach((e, i) => { if (e && e.by === this.name) idx.push(i) })
    const extra = idx.length - cap
    // Delete from the end backwards so earlier indexes stay valid.
    for (let k = extra - 1; k >= 0; k--) this.agentFeed.delete(idx[k], 1)
  }

  /** Turns sharing of your AI chat on or off, leaving a marker in the feed. */
  setAgentSharing (on) {
    on = !!on
    if (on === this.agentSharing) return on
    const marker = { id: `${on ? 'resumed' : 'paused'}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, by: this.name, tool: null, conv: null, kind: on ? 'resumed' : 'paused', text: '', ts: Date.now() }
    this.doc.transact(() => {
      this.agentFeed.push([marker])
      this.trimAgentFeed()
    }, LOCAL)
    this.agentSharing = on
    this.publishAgentState()
    try {
      const file = path.join(this.stateDir, 'config.json')
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
      cfg.shareAgent = on
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 })
    } catch {}
    this.scheduleStatusWrite()
    return on
  }

  /** Live status from the AI chat reader ("working", "idle", "unavailable"). */
  setAgentState (state) {
    this.agentState = state ? { tool: state.tool || null, status: state.status || 'idle', ...(state.reason ? { reason: state.reason } : {}), ...(state.notes ? { notes: state.notes } : {}) } : null
    this.publishAgentState()
  }

  publishAgentState () {
    if (!this.conn) return
    const st = this.agentState || { tool: null, status: 'idle' }
    // While paused, partners only learn that sharing is off, not whether you're working.
    const shared = this.agentSharing ? { ...st, sharing: true } : { tool: st.tool, status: 'idle', sharing: false }
    this.conn.awareness.setLocalStateField('agent', shared)
  }

  /** One person's AI feed, oldest first. */
  agentFeedFor (name, { limit = AGENT_FEED_CAP } = {}) {
    return this.agentFeed.toArray().filter((e) => e && e.by === name).slice(-limit)
  }

  // ---------------------------------------------------------- shared files --

  /**
   * Every shared path with who last edited it (from activity and live
   * presence) and the claim covering it. Read from the shared doc.
   */
  tree () {
    const edited = new Map()
    const note = (p, by, ts) => {
      const cur = edited.get(p)
      if (!cur || ts > cur.ts) edited.set(p, { by, ts })
    }
    for (const a of this.activity) if (a && a.path && a.kind !== 'deleted') note(a.path, a.by, a.ts)
    const states = this.conn ? this.conn.awareness.getStates() : new Map()
    for (const [id, st] of states) {
      if (!st || !st.name) continue
      const editing = id === this.doc.clientID ? Object.fromEntries(this.myEdits) : (st.editing || {})
      for (const [p, ts] of Object.entries(editing)) note(p, st.name, ts)
    }
    const claimFor = (p) => {
      const c = this.claimFor(p)
      return c ? { by: c.by, pattern: c.pattern, note: c.note } : null
    }
    const out = []
    for (const p of this.sharedPaths()) {
      if (!isSafeRelPath(p)) continue
      const blob = this.blobs.get(p)
      out.push({ path: p, binary: !!blob && !this.files.has(p), edited: edited.get(p) || null, claim: claimFor(p) })
    }
    out.sort((a, b) => a.path.localeCompare(b.path))
    return {
      files: out,
      // Claims on folders or globs that don't match a file yet still show up.
      claims: [...this.claims.values()].map((c) => ({ by: c.by, pattern: c.pattern, note: c.note, ts: c.ts }))
    }
  }

  /** Contents of one shared file, straight from the shared doc (never from disk). */
  readShared (rel) {
    rel = String(rel || '').replace(/^\.\//, '')
    if (!isSafeRelPath(rel)) return null
    const t = this.files.get(rel)
    if (t) return { path: rel, text: t.toString() }
    const b = this.blobs.get(rel)
    if (b) return { path: rel, binary: true, size: Math.floor(b.data.length * 3 / 4) - (b.data.endsWith('==') ? 2 : b.data.endsWith('=') ? 1 : 0) }
    return null
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
        color: s.color,
        kind: s.kind || 'human',
        agent: s.agent || null,
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
      me: {
        name: this.name,
        tool: this.tool,
        kind: this.kind,
        focus: this.focus,
        agents: [...this.agents],
        color: this.conn?.awareness.getLocalState()?.color,
        agent: { ...(this.agentState || { status: 'idle' }), sharing: this.agentSharing }
      },
      peers,
      claims: [...this.claims.values()].sort((a, b) => a.ts - b.ts),
      activity: this.activity.toArray().slice(-30),
      chat: this.messages({ limit: 20, markRead: false }),
      unread: this.unreadCount(),
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
    for (const t of this.rechecks.values()) clearTimeout(t)
    this.rechecks.clear()
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

export function formatMessage (m) {
  const head = m.to ? `${m.by} → ${m.to} (direct)` : m.by
  const file = m.file ? ` 📎 ${m.file.name} (${formatBytes(m.file.size)})` : ''
  return `${head}: ${m.text}${file}`
}

function safeName (name) {
  const base = path.basename(String(name)).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '')
  return base.slice(0, 120) || 'file'
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
