// The web app's sync engine: mirrors a folder the person picked in their
// browser into the shared Yjs document and back. It speaks exactly the same
// document layout as src/session.js, so people in the browser and people
// running `elegy join` can be in the same session.
//
// Differences from the CLI, because a web page can't watch the disk:
// - Local changes are found by polling (size + modified time) every second.
// - Every read and write goes through one queue, so a poll and a remote
//   change never touch the same file at the same time.
//
// `folder` is an adapter (see folders.js): list, stat, read, write, remove.
import * as Y from 'yjs'
import { WebConnection, REMOTE } from './connection.js'
import { Emitter } from './emitter.js'
import { applyTextDiff } from '../textdiff.js'
import { makeIgnore, isIgnored, isSafeRelPath, globMatcher, MAX_TEXT_BYTES, MAX_BINARY_BYTES } from '../pathrules.js'

const LOCAL = Symbol('local')
const COLORS = ['#e06c75', '#61afef', '#98c379', '#c678dd', '#e5c07b', '#56b6c2', '#d19a66']
const RECENT_MS = 2 * 60 * 1000
const STATE_DIR = '.elegy'
const enc = new TextEncoder()

export class WebSession extends Emitter {
  constructor ({ folder, server, room, secret, key = '', name, tool = 'unknown', WebSocketImpl, pollMs = 1000 }) {
    super()
    this.folder = folder
    this.server = server
    this.room = room
    this.secret = secret
    this.key = key
    this.name = name
    this.tool = tool
    this.WebSocketImpl = WebSocketImpl
    this.pollMs = pollMs

    this.doc = new Y.Doc()
    this.files = this.doc.getMap('files')
    this.blobs = this.doc.getMap('blobs')
    this.claims = this.doc.getMap('claims')
    this.chat = this.doc.getArray('chat')
    this.activity = this.doc.getArray('activity')
    this.agentFeed = this.doc.getArray('agentFeed')

    this.ig = makeIgnore()
    this.lastKnown = new Map() // path -> text, or "bin:<sha1>"
    this.seen = new Map() // path -> "size:mtime" as last read or written
    this.myEdits = new Map()
    this.lastActivityPush = new Map()
    this.warnedLarge = new Set()
    this.remoteQueue = new Set()
    this.chain = Promise.resolve()
    this.ready = false
    this.stopped = false
  }

  log (msg) { this.emit('log', msg) }

  /** Runs fn after everything queued before it. Errors are logged, not thrown. */
  run (fn) {
    const next = this.chain.then(() => this.stopped ? undefined : fn())
    this.chain = next.catch((err) => this.log(`sync error: ${err.message}`))
    return next
  }

  async start ({ waitTimeoutMs = 20000 } = {}) {
    await this.loadIgnore()
    const hadState = await this.loadState()
    // What the session looked like when this folder last synced. Taken before
    // connecting: files others add while we reconcile must not look "deleted here".
    const base = hadState ? new Map([...this.sharedPaths()].map((p) => [p, this.sharedKey(p)])) : null
    this.conn = new WebConnection({ server: this.server, room: this.room, secret: this.secret, key: this.key, doc: this.doc, WebSocketImpl: this.WebSocketImpl })
    this.conn.on('status', (s) => { this.log(s === 'connected' ? 'connected' : 'disconnected, reconnecting…'); this.emit('change') })
    this.conn.on('warn', (m) => this.log(m))
    this.conn.on('fatal', (err) => this.emit('fatal', err))
    this.setupPresence()
    // Listen before reconciling: remote changes can arrive while we read the disk.
    this.observe()

    if (hadState) {
      // Synced here before: fold in what changed while the tab was closed; the CRDT merges it.
      await this.run(() => this.reconcileOffline(base))
    } else {
      this.log('connecting…')
      let timer
      await Promise.race([
        this.conn.waitForSync(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Could not reach the session. Check the link and your connection.')), waitTimeoutMs) })
      ]).finally(() => clearTimeout(timer))
      await this.run(() => this.reconcileFirstJoin())
    }
    this.ready = true
    this.run(() => this.flushRemote())
    this.scheduleStateSave()
    this.emit('change')
    this.schedulePoll()
    return this
  }

  observe () {
    const remote = (paths) => {
      for (const p of paths) this.remoteQueue.add(p)
      // Until the first reconcile is done, just collect them; it runs first.
      if (this.ready) this.run(() => this.flushRemote())
    }
    this.files.observeDeep((events, tr) => {
      if (tr.origin === LOCAL) return
      const paths = new Set()
      for (const ev of events) {
        if (ev.target === this.files) for (const k of ev.changes.keys.keys()) paths.add(k)
        else if (ev.path.length) paths.add(ev.path[0])
      }
      remote(paths)
    })
    this.blobs.observe((ev, tr) => { if (tr.origin !== LOCAL) remote(ev.changes.keys.keys()) })
    for (const arr of [this.chat, this.activity]) arr.observe(() => this.emit('change'))
    this.agentFeed.observe((ev) => {
      // My AI shared something through elegy's MCP link: show it as working.
      for (const item of ev.changes.added) {
        for (const e of item.content.getContent()) {
          if (e && e.by === this.name && e.tool && Date.now() - (e.ts || 0) < 2 * 60 * 1000) this.markAiActive(e.tool)
        }
      }
      this.emit('change')
    })
    this.claims.observe(() => this.emit('change'))
    this.doc.on('update', () => { if (this.ready) this.scheduleStateSave() })
  }

  async flushRemote (opts) {
    const paths = [...this.remoteQueue]
    this.remoteQueue.clear()
    for (const p of paths) {
      try { await this.writeOut(p, opts) } catch (err) { this.log(`could not write ${p}: ${err.message}`) }
    }
  }

  // ---------------------------------------------------------------- state --

  async loadIgnore () {
    const texts = []
    for (const f of ['.gitignore', '.elegyignore']) {
      const b = await this.folder.read(f).catch(() => null)
      if (b) texts.push(new TextDecoder().decode(b))
    }
    this.ig = makeIgnore(texts)
  }

  async loadState () {
    try {
      const meta = JSON.parse(new TextDecoder().decode(await this.folder.read(`${STATE_DIR}/state.json`)))
      if (meta.room !== this.room || meta.server !== this.server) return false
      const bin = await this.folder.read(`${STATE_DIR}/state.bin`)
      if (!bin) return false
      Y.applyUpdate(this.doc, bin, LOCAL)
      return true
    } catch {
      return false
    }
  }

  scheduleStateSave () {
    if (this.stateTimer || this.stopped) return
    this.stateTimer = setTimeout(() => { this.stateTimer = null; this.run(() => this.saveState()) }, 2000)
  }

  async saveState () {
    await this.folder.write(`${STATE_DIR}/state.bin`, Y.encodeStateAsUpdate(this.doc))
    await this.folder.write(`${STATE_DIR}/state.json`, enc.encode(JSON.stringify({ room: this.room, server: this.server })))
  }

  // ------------------------------------------------------------ reconcile --

  sharedPaths () { return new Set([...this.files.keys(), ...this.blobs.keys()]) }

  syncable (rel) { return isSafeRelPath(rel) && !isIgnored(this.ig, rel) }

  async listDisk () {
    const list = await this.folder.list((dir) => isIgnored(this.ig, dir))
    return list.filter((f) => this.syncable(f.path))
  }

  async reconcileOffline (base) {
    for (const [rel, key] of base) if (this.syncable(rel)) this.lastKnown.set(rel, key)
    const onDisk = new Set((await this.listDisk()).map((f) => f.path))
    for (const rel of base.keys()) {
      // Gone from disk since last time: deleted while away (unless someone
      // changed it meanwhile; ingest then restores their version instead).
      if (this.syncable(rel) && !onDisk.has(rel)) await this.ingest(rel)
    }
    for (const rel of onDisk) await this.ingest(rel)
  }

  async reconcileFirstJoin () {
    const onDisk = new Set((await this.listDisk()).map((f) => f.path))
    let pulled = 0; let pushed = 0; let backedUp = 0
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (const rel of this.sharedPaths()) {
      if (!this.syncable(rel)) continue
      const disk = await this.readDisk(rel)
      const shared = this.sharedKey(rel)
      if (disk && disk.key === shared) { this.lastKnown.set(rel, shared); this.seen.set(rel, disk.stamp); onDisk.delete(rel); continue }
      if (disk && !disk.skip) {
        // The session's version wins; keep theirs safe.
        await this.folder.write(`${STATE_DIR}/conflicts/${stamp}/${rel}`, disk.bytes)
        backedUp++
      }
      await this.writeOut(rel)
      onDisk.delete(rel)
      pulled++
    }
    for (const rel of onDisk) if (await this.ingest(rel)) pushed++
    this.log(`initial sync: ${pulled} file(s) pulled, ${pushed} pushed` + (backedUp ? `, ${backedUp} of your versions saved in .elegy/conflicts` : ''))
  }

  sharedKey (rel) {
    const t = this.files.get(rel)
    if (t) return t.toString()
    const b = this.blobs.get(rel)
    if (b) return `bin:${b.hash}`
    return undefined
  }

  async readDisk (rel) {
    const st = await this.folder.stat(rel)
    if (!st) return null
    if (st.dir) return { skip: true }
    if (st.size > MAX_BINARY_BYTES) return { tooLarge: true }
    const bytes = await this.folder.read(rel)
    if (!bytes) return null
    const stamp = `${st.size}:${st.mtime}`
    const text = decodeText(bytes)
    if (text === null) {
      const hash = await sha1(bytes)
      return { binary: true, bytes, hash, key: `bin:${hash}`, stamp }
    }
    if (bytes.length > MAX_TEXT_BYTES) return { tooLarge: true }
    return { text, bytes, key: text, stamp }
  }

  // ------------------------------------------------------- local -> shared --

  schedulePoll () {
    if (this.stopped) return
    this.pollTimer = setTimeout(() => this.run(() => this.poll()).finally(() => this.schedulePoll()), this.pollMs)
  }

  /** Finds files that changed on disk since we last looked and shares them. */
  async poll () {
    const list = await this.listDisk()
    const now = new Set()
    for (const f of list) {
      now.add(f.path)
      if (this.seen.get(f.path) !== `${f.size}:${f.mtime}`) await this.ingest(f.path)
    }
    for (const rel of [...this.seen.keys()]) if (!now.has(rel)) await this.ingest(rel)
  }

  /** Pushes a path's on-disk state into the shared doc. True if anything changed. */
  async ingest (rel) {
    if (!this.syncable(rel)) return false
    const disk = await this.readDisk(rel)
    if (disk && (disk.skip || disk.tooLarge)) {
      if (disk.tooLarge && !this.warnedLarge.has(rel)) { this.warnedLarge.add(rel); this.log(`skipping ${rel}: too large to sync`) }
      return false
    }
    if (rel === '.gitignore' || rel === '.elegyignore') await this.loadIgnore()
    const shared = this.sharedKey(rel)
    if (shared !== this.lastKnown.get(rel)) {
      // Someone else changed it and we haven't written that out yet. Writing
      // it out first keeps their edit; writeOut saves ours as a conflict copy.
      this.remoteQueue.add(rel)
      await this.flushRemote({ backup: true })
      return false
    }
    if (!disk) {
      this.seen.delete(rel)
      if (shared === undefined) { this.lastKnown.delete(rel); return false }
      this.doc.transact(() => {
        this.files.delete(rel)
        this.blobs.delete(rel)
        this.recordActivity(rel, 'deleted', '')
      }, LOCAL)
      this.lastKnown.delete(rel)
      this.noteMyEdit(rel)
      return true
    }
    this.seen.set(rel, disk.stamp)
    if (disk.key === shared) return false

    let detail = ''
    this.doc.transact(() => {
      const existed = this.files.has(rel) || this.blobs.has(rel)
      if (disk.binary) {
        this.files.delete(rel)
        this.blobs.set(rel, { hash: disk.hash, data: toBase64(disk.bytes) })
        detail = `${disk.bytes.length} bytes`
      } else {
        this.blobs.delete(rel)
        let ytext = this.files.get(rel)
        if (!ytext) { ytext = new Y.Text(); this.files.set(rel, ytext) }
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
    if (kind === 'edited' && last && now - last < 20000) return
    this.lastActivityPush.set(rel, now)
    this.activity.push([{ by: this.name, path: rel, kind, detail, ts: now }])
    if (this.activity.length > 300) this.activity.delete(0, this.activity.length - 300)
  }

  noteMyEdit (rel) {
    this.myEdits.set(rel, Date.now())
    this.emit('file-changed', { path: rel, by: this.name })
    this.updatePresence()
  }

  // ------------------------------------------------------- shared -> local --

  async writeOut (rel, { backup = this.ready } = {}) {
    if (!this.syncable(rel)) return
    const disk = await this.readDisk(rel)
    if (disk && (disk.skip || disk.tooLarge)) return
    const known = this.lastKnown.get(rel)
    const shared = this.sharedKey(rel)

    if (backup && disk && disk.key !== known && disk.key !== shared) {
      // Changed here in the moment before their change arrived: keep a copy.
      const dest = `${STATE_DIR}/conflicts/${Date.now()}/${rel}`
      await this.folder.write(dest, disk.bytes)
      this.log(`simultaneous edit on ${rel}; your version saved to ${dest}`)
    }

    if (shared === undefined) {
      if (disk) await this.folder.remove(rel)
      this.lastKnown.delete(rel)
      this.seen.delete(rel)
    } else {
      if (!disk || disk.key !== shared) {
        const t = this.files.get(rel)
        const now = this.sharedKey(rel) // may have moved on while we read the disk
        await this.folder.write(rel, t ? enc.encode(t.toString()) : fromBase64(this.blobs.get(rel).data))
        const st = await this.folder.stat(rel)
        if (st) this.seen.set(rel, `${st.size}:${st.mtime}`)
        this.lastKnown.set(rel, now)
      } else {
        this.lastKnown.set(rel, shared)
        this.seen.set(rel, disk.stamp)
      }
    }
    if (rel === '.gitignore' || rel === '.elegyignore') await this.loadIgnore()
    if (this.ready) this.emit('file-changed', { path: rel, by: this.lastEditorOf(rel) || 'partner' })
  }

  lastEditorOf (rel) {
    for (let i = this.activity.length - 1; i >= 0; i--) {
      const a = this.activity.get(i)
      if (a && a.path === rel) return a.by === this.name ? null : a.by
    }
    return null
  }

  // ----------------------------------------------------- presence & social --

  setupPresence () {
    const color = COLORS[Math.abs(hashCode(this.name)) % COLORS.length]
    this.conn.awareness.setLocalState({
      name: this.name, tool: this.tool, color, focus: '', editing: {}, agents: [], kind: 'human', via: 'web',
      agent: { tool: null, status: 'idle', sharing: false }
    })
    this.conn.awareness.on('change', () => this.emit('change'))
  }

  updatePresence () {
    if (this.presenceTimer) return
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null
      const now = Date.now()
      const editing = {}
      for (const [p, ts] of this.myEdits) {
        if (now - ts < RECENT_MS * 2) editing[p] = ts
        else this.myEdits.delete(p)
      }
      if (this.conn && !this.stopped) this.conn.awareness.setLocalStateField('editing', editing)
    }, 500)
  }

  markAiActive (tool) {
    this.aiTool = tool
    const set = (status) => { if (this.conn && !this.stopped) this.conn.awareness.setLocalStateField('agent', { tool, status, sharing: true }) }
    set('working')
    clearTimeout(this.aiIdleTimer)
    this.aiIdleTimer = setTimeout(() => set('idle'), 2 * 60 * 1000)
    this.emit('ai-active', tool)
  }

  setFocus (text) {
    this.conn.awareness.setLocalStateField('focus', String(text || '').slice(0, 500))
    this.emit('change')
  }

  say (text) {
    text = String(text || '').slice(0, 4000).trim()
    if (!text) return null
    const msg = { id: randomHex(8), by: this.name, to: null, text, ts: Date.now() }
    this.doc.transact(() => {
      this.chat.push([msg])
      if (this.chat.length > 500) this.chat.delete(0, this.chat.length - 500)
    }, LOCAL)
    return msg
  }

  claimFor (rel) {
    for (const c of this.claims.values()) if (globMatcher(c.pattern)(rel)) return c
    return null
  }

  /** Everything the UI shows. */
  status () {
    const states = this.conn ? this.conn.awareness.getStates() : new Map()
    const peers = []
    for (const [id, s] of states) {
      if (id === this.doc.clientID || !s || !s.name) continue
      peers.push({ name: s.name, tool: s.tool, color: s.color, kind: s.kind || 'human', via: s.via || 'app', focus: s.focus || '', agent: s.agent || null, editing: Object.keys(s.editing || {}) })
    }
    return {
      room: this.room,
      connected: !!(this.conn && this.conn.connected),
      me: { name: this.name, tool: this.tool, color: this.conn?.awareness.getLocalState()?.color },
      peers,
      activity: this.activity.toArray().filter(Boolean).slice(-50),
      chat: this.chat.toArray().filter((m) => m && m.id && (!m.to || m.to === this.name || m.by === this.name)).slice(-100),
      feed: this.agentFeed.toArray().filter((e) => e && e.by !== this.name).slice(-200),
      claims: [...this.claims.values()],
      fileCount: this.files.size + this.blobs.size
    }
  }

  async stop () {
    if (this.stopped) return
    clearTimeout(this.pollTimer)
    clearTimeout(this.presenceTimer)
    clearTimeout(this.stateTimer)
    clearTimeout(this.aiIdleTimer)
    await this.run(() => this.saveState()).catch(() => {})
    this.stopped = true
    this.ready = false
    if (this.conn) this.conn.close()
    await new Promise((r) => setTimeout(r, 100))
  }
}

// ------------------------------------------------------------- helpers --

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The file as text, or null if it's binary (a NUL byte, or not valid UTF-8). Same rule as the CLI. */
export function decodeText (bytes) {
  const n = Math.min(bytes.length, 8000)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return null
  try { return utf8.decode(bytes) } catch { return null }
}

async function sha1 (bytes) {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', bytes))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function toBase64 (bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64 (b64) {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function randomHex (n) {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(n))
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function hashCode (s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}
