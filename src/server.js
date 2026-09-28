// Relay server: holds one shared Yjs document per room, relays updates and
// presence between clients, stores files shared in chat, and persists rooms
// to disk. It checks who each client is (see identity.js) and owns the
// room's claims, so only the person who made a claim can release it. Safe to
// run on the public internet: rooms need their secret, creating rooms can
// require a relay key, and rooms have size quotas.
//
// Access: a room created with a view-only secret has an owner (the first
// person to sign in) who approves everyone else and gives them a role:
// editors change files, viewers only watch and chat, and agents can be
// limited to some folders. The relay enforces it by undoing file changes a
// member isn't allowed to make, before anyone else sees them.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import {
  MSG_SYNC, MSG_AWARENESS, MSG_QUERY_AWARENESS, MSG_AUTH, MSG_CLAIM, MSG_CLAIMS, MAX_SHARED_FILE_BYTES,
  MSG_ACCESS, MSG_ADMIN, MSG_MEMBERS,
  CLOSE_AUTH_FAILED, CLOSE_NAME_TAKEN, CLOSE_ROOM_FULL, CLOSE_DENIED,
  encoding, decoding, syncProtocol, awarenessProtocol,
  syncStep1Message, updateMessage, awarenessMessage, bytesMessage, jsonMessage
} from './protocol.js'
import { parsePublicKey, verifyChallenge } from './identity.js'
import { patternsOverlap, globMatcher } from './fsutil.js'

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_NAME = 64
const MAX_PATTERN = 500
const MAX_SCOPES = 20
const ROLES = ['editor', 'viewer']
const MB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000
const LOGO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'logo.svg')
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest()
const sameSecret = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b)

/** Relay settings, from options or environment variables. */
export function relayConfig (opts = {}) {
  const env = process.env
  const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v))
  return {
    relayKey: opts.relayKey ?? env.COWOVE_RELAY_KEY ?? '',
    maxRoomBytes: num(opts.maxRoomBytes ?? env.COWOVE_MAX_ROOM_MB, 256) * (opts.maxRoomBytes !== undefined ? 1 : MB),
    maxRoomFileBytes: num(opts.maxRoomFileBytes ?? env.COWOVE_MAX_ROOM_FILES_MB, 2048) * (opts.maxRoomFileBytes !== undefined ? 1 : MB),
    maxConnsPerIp: num(opts.maxConnsPerIp ?? env.COWOVE_MAX_CONNS_PER_IP, 50),
    roomTtlDays: num(opts.roomTtlDays ?? env.COWOVE_ROOM_TTL_DAYS, 30),
    idleUnloadMs: num(opts.idleUnloadMs, 60 * 1000),
    trustProxy: opts.trustProxy ?? /^(1|true|yes)$/i.test(env.COWOVE_TRUST_PROXY || '')
  }
}

class Room {
  constructor (name, dataDir, cfg, log) {
    this.name = name
    this.cfg = cfg
    this.log = log
    this.doc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.awareness.setLocalState(null)
    this.conns = new Map() // ws -> Set<awareness clientID>
    this.names = new Map() // ws -> verified name
    this.docFile = dataDir && path.join(dataDir, `${name}.ydoc`)
    this.metaFile = dataDir && path.join(dataDir, `${name}.json`)
    this.meta = {}
    this.bytes = 0
    this.full = false
    if (dataDir) {
      if (fs.existsSync(this.docFile)) {
        const buf = fs.readFileSync(this.docFile)
        Y.applyUpdate(this.doc, buf)
        this.bytes = buf.length
      }
      if (fs.existsSync(this.metaFile)) this.meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'))
    }
    this.meta.identities = this.meta.identities || {} // name -> public key
    this.meta.claims = this.meta.claims || {} // pattern -> { by, pattern, note, ts }
    this.meta.members = this.meta.members || {} // public key -> { name, kind, role, scopes, since }
    this.access = new Map() // ws -> { key, name, kind, role, scopes, owner } for people in the room
    this.pending = new Map() // ws -> { key, name, kind, invitedAs, since } waiting for the owner
    this.files = this.doc.getMap('files')
    this.blobs = this.doc.getMap('blobs')
    // Undoes file changes from people who may not make them (viewers, and
    // agents outside their folders). Only their connections are tracked.
    this.guard = new Y.UndoManager([this.files, this.blobs], { trackedOrigins: new Set(), captureTimeout: 0 })
    this.undoing = null
    this.full = this.bytes > cfg.maxRoomBytes
    this.saveTimer = null
    this.unloadTimer = null

    this.doc.on('update', (update, origin, doc, tr) => {
      if (origin === this.guard && this.undoing) { this.undoing.push(update); return } // sent merged, below
      if (origin && origin !== this.guard && this.guard.trackedOrigins.has(origin) && !this.checkChange(origin, update, tr)) return
      const msg = updateMessage(update)
      for (const ws of this.conns.keys()) if (ws !== origin) send(ws, msg)
      this.bytes += update.length
      if (!this.full && this.bytes > cfg.maxRoomBytes) {
        this.full = true
        this.log(`[${name}] over the size limit; further edits are refused`)
      }
      this.scheduleSave()
    })
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed)
      if (origin && this.conns.has(origin)) {
        const ids = this.conns.get(origin)
        for (const id of added) ids.add(id)
        for (const id of removed) ids.delete(id)
      }
      const msg = awarenessMessage(this.awareness, changed)
      for (const ws of this.conns.keys()) send(ws, msg)
    })
  }

  get exists () { return !!this.meta.secretHash }

  /** Rooms made by newer clients have an owner who approves people. Older rooms let everyone edit. */
  get controlled () { return !!this.meta.viewSecretHash }

  /**
   * First client to open a room sets its secrets; later clients must match one.
   * Returns 'editor' or 'viewer' (what the secret invites you as), 'bad-secret'
   * or 'need-key' (creating rooms needs the relay key).
   */
  authorize (secret, key, viewSecret = '') {
    if (!this.meta.secretHash) {
      if (this.cfg.relayKey && !sameSecret(hash(key || ''), hash(this.cfg.relayKey))) return 'need-key'
      this.meta.secretHash = hash(secret || '').toString('hex')
      if (viewSecret) this.meta.viewSecretHash = hash(viewSecret).toString('hex')
      this.meta.createdAt = Date.now()
      this.touch()
      return 'editor'
    }
    if (sameSecret(hash(secret || ''), Buffer.from(this.meta.secretHash, 'hex'))) return 'editor'
    if (this.controlled && sameSecret(hash(secret || ''), Buffer.from(this.meta.viewSecretHash, 'hex'))) return 'viewer'
    return 'bad-secret'
  }

  /** Where someone stands when they sign in: let in now (with a role), or wait for the owner. */
  accessFor (key, name, kind, invitedAs) {
    if (!this.controlled) return { state: 'approved', role: 'editor', scopes: [], owner: false }
    if (!this.meta.owner) { this.meta.owner = key; this.saveMeta() } // the room's creator signs in first
    if (this.meta.owner === key) return { state: 'approved', role: 'editor', scopes: [], owner: true }
    const m = this.meta.members[key]
    if (m) {
      if (m.name !== name || m.kind !== kind) { m.name = name; m.kind = kind; this.saveMeta() }
      return { state: 'approved', role: m.role, scopes: m.scopes || [], owner: false }
    }
    return { state: 'pending', invitedAs }
  }

  /** May this connection change this file? */
  mayWrite (a, rel) {
    if (!a || a.role === 'viewer') return false
    return !a.scopes || !a.scopes.length || a.scopes.some((s) => globMatcher(s)(rel))
  }

  /**
   * A restricted member (viewer, or agent limited to folders) changed the doc.
   * Returns true to pass it on, or false after scheduling an undo because it
   * touched files they may not change. The undo runs once the guard has
   * recorded the change, whichever order Yjs fires its events in.
   */
  checkChange (ws, update, tr) {
    const a = this.access.get(ws)
    const touched = new Set()
    for (const [type, events] of tr.changedParentTypes) {
      if (type !== this.files && type !== this.blobs) continue
      for (const e of events) {
        if (e.target === type) for (const k of e.changes.keys.keys()) touched.add(k)
        else {
          // A change inside a file's text: walk up to the entry in files.
          let t = e.target
          while (t && t._item && t._item.parent !== type) t = t._item.parent
          if (t && t._item && t._item.parentSub) touched.add(t._item.parentSub)
        }
      }
    }
    const refused = [...touched].filter((rel) => !this.mayWrite(a, rel))
    if (!refused.length) { queueMicrotask(() => this.guard.clear()); return true }
    this.log(`[${this.name}] undid ${a ? a.name : 'someone'}'s change to ${refused.slice(0, 3).join(', ')}${refused.length > 3 ? '…' : ''} (not allowed)`)
    queueMicrotask(() => {
      // Send the change and its undo as one update: nobody sees the change,
      // and nobody is left missing part of this person's history.
      this.undoing = []
      try { this.guard.undo() } finally {
        const merged = Y.mergeUpdates([update, ...this.undoing])
        this.undoing = null
        const msg = updateMessage(merged)
        for (const other of this.conns.keys()) send(other, msg)
      }
      this.guard.clear()
      const why = a && a.role === 'viewer' ? 'you can only view this session' : 'that is outside the folders you may change'
      send(ws, jsonMessage(MSG_ACCESS, { ...this.accessMessage(a), refused: refused.slice(0, 20), why }))
    })
    return false
  }

  accessMessage (a) {
    return { state: 'approved', role: a.role, scopes: a.scopes || [], owner: !!a.owner, controlled: this.controlled }
  }

  /** Tracks restricted connections so their file changes are checked. */
  setAccess (ws, a) {
    this.access.set(ws, a)
    const restricted = a.role === 'viewer' || (a.scopes && a.scopes.length)
    if (restricted) this.guard.trackedOrigins.add(ws)
    else this.guard.trackedOrigins.delete(ws)
  }

  memberList () {
    const online = new Map()
    for (const a of this.access.values()) online.set(a.key, true)
    const list = []
    if (this.meta.owner) {
      const ownerName = Object.entries(this.meta.identities).find(([, k]) => k === this.meta.owner)?.[0] || 'owner'
      list.push({ key: this.meta.owner, name: ownerName, kind: 'human', role: 'owner', scopes: [], online: online.has(this.meta.owner) })
    }
    for (const [key, m] of Object.entries(this.meta.members)) list.push({ key, name: m.name, kind: m.kind, role: m.role, scopes: m.scopes || [], online: online.has(key) })
    return list
  }

  pendingList () {
    return [...this.pending.values()].map((p) => ({ key: p.key, name: p.name, kind: p.kind, invitedAs: p.invitedAs, since: p.since }))
  }

  /** Sends everyone the member list; only the owner sees who's waiting. */
  broadcastMembers (replyTo = null, reply = null) {
    if (!this.controlled) return
    const members = this.memberList()
    const pending = this.pendingList()
    for (const [ws, a] of this.access) {
      const msg = { members, ...(a.owner ? { pending } : {}), ...(ws === replyTo && reply ? { reply } : {}) }
      send(ws, jsonMessage(MSG_MEMBERS, msg))
    }
  }

  /** Owner-only changes to who's in the room. Returns the reply fields. */
  adminRequest (ws, req) {
    const me = this.access.get(ws)
    if (!me || !me.owner) throw new Error('only the session owner can do that')
    const key = String(req.key || '')
    const role = ROLES.includes(req.role) ? req.role : null
    const scopes = Array.isArray(req.scopes)
      ? req.scopes.map((s) => String(s).trim().replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean).slice(0, MAX_SCOPES)
      : null
    if (scopes && scopes.some((s) => s.length > MAX_PATTERN || s.split('/').includes('..'))) throw new Error('bad folder')
    if (key === this.meta.owner) throw new Error('the owner always has full access')
    const waiting = [...this.pending].find(([, p]) => p.key === key)
    if (req.op === 'approve') {
      if (!waiting) throw new Error('nobody with that key is waiting')
      const [pws, p] = waiting
      this.pending.delete(pws)
      this.meta.members[key] = { name: p.name, kind: p.kind, role: role || p.invitedAs, scopes: scopes || [], since: Date.now() }
      this.saveMeta()
      this.log(`[${this.name}] ${p.name} approved as ${this.meta.members[key].role}`)
      this.enter(pws, { key, name: p.name, kind: p.kind, role: this.meta.members[key].role, scopes: this.meta.members[key].scopes, owner: false })
      return { ok: true }
    }
    if (req.op === 'deny') {
      if (!waiting) throw new Error('nobody with that key is waiting')
      this.pending.delete(waiting[0])
      waiting[0].close(CLOSE_DENIED, 'The session owner did not let you in')
      return { ok: true }
    }
    const m = this.meta.members[key]
    if (!m) throw new Error('no such member')
    if (req.op === 'set') {
      if (role) m.role = role
      if (scopes) m.scopes = scopes
      this.saveMeta()
      for (const [cws, a] of this.access) {
        if (a.key !== key) continue
        a.role = m.role
        a.scopes = m.scopes
        this.setAccess(cws, a)
        send(cws, jsonMessage(MSG_ACCESS, this.accessMessage(a)))
      }
      return { ok: true }
    }
    if (req.op === 'remove') {
      delete this.meta.members[key]
      this.saveMeta()
      for (const [cws, a] of this.access) if (a.key === key) cws.close(CLOSE_DENIED, 'The session owner removed you')
      return { ok: true }
    }
    throw new Error('unknown request')
  }

  touch () {
    this.meta.lastActive = Date.now()
    this.saveMeta()
  }

  /** A name belongs to the first key that signs in with it. */
  keyMatches (name, publicKey) {
    const known = this.meta.identities[name]
    return !known || known === publicKey
  }

  bindName (name, publicKey) {
    if (this.meta.identities[name]) return
    this.meta.identities[name] = publicKey
    this.saveMeta()
  }

  /** Presence may only describe the sender, under their verified name. */
  presenceAllowed (ws, update) {
    const name = this.names.get(ws)
    const dec = decoding.createDecoder(update)
    const n = decoding.readVarUint(dec)
    for (let i = 0; i < n; i++) {
      const id = decoding.readVarUint(dec)
      decoding.readVarUint(dec) // clock
      const state = JSON.parse(decoding.readVarString(dec))
      for (const [other, ids] of this.conns) if (other !== ws && ids.has(id)) return false
      if (state !== null && state.name !== name) return false
    }
    return true
  }

  claimList () {
    return Object.values(this.meta.claims).sort((a, b) => a.ts - b.ts)
  }

  /** Handles a claim/release request from a verified name. Returns the reply fields. */
  claimRequest (name, req) {
    const pattern = String(req.pattern ?? '').trim().replace(/^\.\//, '')
    if (req.op === 'claim') {
      if (!pattern) throw new Error('pattern required')
      if (pattern.length > MAX_PATTERN) throw new Error('pattern too long')
      const existing = this.meta.claims[pattern]
      if (existing && existing.by !== name) throw new Error(`${pattern} is already claimed by ${existing.by}`)
      const paths = [...this.doc.getMap('files').keys(), ...this.doc.getMap('blobs').keys()]
      const other = this.claimList().find((c) => c.by !== name && patternsOverlap(c.pattern, pattern, paths))
      if (other) throw new Error(`${pattern} overlaps ${other.by}'s claim on ${other.pattern}`)
      this.meta.claims[pattern] = { by: name, pattern, note: String(req.note ?? '').slice(0, 500), ts: Date.now() }
      return { ok: true }
    }
    if (req.op === 'release') {
      if (pattern === '*' || !pattern) {
        const mine = this.claimList().filter((c) => c.by === name)
        for (const c of mine) delete this.meta.claims[c.pattern]
        return { ok: true, released: mine.length }
      }
      const c = this.meta.claims[pattern]
      if (!c) return { ok: true, released: 0 }
      if (c.by !== name) throw new Error(`${pattern} is claimed by ${c.by}; only they can release it`)
      delete this.meta.claims[pattern]
      return { ok: true, released: 1 }
    }
    throw new Error('unknown claim operation')
  }

  saveMeta () {
    if (this.metaFile) fs.writeFileSync(this.metaFile, JSON.stringify(this.meta))
  }

  scheduleSave () {
    if (!this.docFile || this.saveTimer) return
    this.saveTimer = setTimeout(() => this.save(), 1000)
  }

  save () {
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (!this.docFile || !this.exists) return
    const state = Y.encodeStateAsUpdate(this.doc)
    this.bytes = state.length
    const tmp = this.docFile + '.tmp'
    fs.writeFileSync(tmp, state)
    fs.renameSync(tmp, this.docFile)
  }

  /**
   * Challenges the client to prove it holds the key for its name, then lets
   * it into the room. Nothing else is accepted until then.
   */
  admit (ws, name, publicKey, key, { kind = 'human', invitedAs = 'editor' } = {}, onJoin) {
    clearTimeout(this.unloadTimer)
    const nonce = crypto.randomBytes(32)
    let joined = false
    let waiting = false
    ws.on('message', (data) => {
      const buf = new Uint8Array(data)
      if (joined || this.access.has(ws)) {
        joined = true
        try { this.handle(ws, buf) } catch (err) { this.log(`[${this.name}] bad message: ${err.message}`) }
        return
      }
      if (waiting) return // nothing counts until the owner lets them in
      try {
        const dec = decoding.createDecoder(buf)
        if (decoding.readVarUint(dec) !== MSG_AUTH) throw new Error('not signed in')
        if (!verifyChallenge(key, this.name, nonce, decoding.readVarUint8Array(dec))) throw new Error('bad signature')
      } catch (err) {
        this.log(`[${this.name}] refused ${name}: ${err.message}`)
        return ws.close(CLOSE_AUTH_FAILED, 'Could not verify who you are')
      }
      // Re-check: someone else may have taken the name while we waited.
      if (!this.keyMatches(name, publicKey)) return ws.close(CLOSE_NAME_TAKEN, nameTaken(name))
      this.bindName(name, publicKey)
      const acc = this.accessFor(publicKey, name, kind, invitedAs)
      if (acc.state === 'pending') {
        waiting = true
        this.pending.set(ws, { key: publicKey, name, kind, invitedAs, since: Date.now() })
        this.log(`[${this.name}] ${name} is waiting to be let in`)
        send(ws, jsonMessage(MSG_ACCESS, { state: 'pending', invitedAs, controlled: true }))
        this.broadcastMembers()
        onJoin()
        return
      }
      joined = true
      this.enter(ws, { key: publicKey, name, kind, role: acc.role, scopes: acc.scopes, owner: acc.owner })
      onJoin()
    })
    ws.on('close', () => {
      if (this.pending.delete(ws)) this.broadcastMembers()
      if (this.access.has(ws) || this.conns.has(ws)) this.leave(ws)
    })
    send(ws, bytesMessage(MSG_AUTH, nonce))
  }

  /** Lets a signed-in (and, if needed, approved) person into the room. */
  enter (ws, a) {
    this.setAccess(ws, a)
    send(ws, jsonMessage(MSG_ACCESS, this.accessMessage(a)))
    this.join(ws, a.name)
    this.broadcastMembers()
  }

  join (ws, name) {
    this.conns.set(ws, new Set())
    this.names.set(ws, name)
    send(ws, syncStep1Message(this.doc))
    const states = [...this.awareness.getStates().keys()]
    if (states.length) send(ws, awarenessMessage(this.awareness, states))
    send(ws, jsonMessage(MSG_CLAIMS, { claims: this.claimList() }))
    this.touch()
  }

  leave (ws) {
    const ids = this.conns.get(ws)
    this.conns.delete(ws)
    this.names.delete(ws)
    if (this.access.delete(ws)) {
      this.guard.trackedOrigins.delete(ws)
      this.broadcastMembers()
    }
    if (ids && ids.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null)
    if (this.conns.size === 0) {
      this.save()
      this.touch()
      this.onEmpty && this.onEmpty()
    }
  }

  handle (ws, buf) {
    const dec = decoding.createDecoder(buf)
    const type = decoding.readVarUint(dec)
    if (type === MSG_SYNC) {
      if (this.full) {
        // Over quota: still answer "what do you have?" so people can read, but refuse new data.
        const sub = decoding.readVarUint(decoding.createDecoder(buf.subarray(1)))
        if (sub !== syncProtocol.messageYjsSyncStep1) {
          ws.close(CLOSE_ROOM_FULL, 'room is over the size limit')
          return
        }
      }
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      syncProtocol.readSyncMessage(dec, enc, this.doc, ws)
      if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc))
    } else if (type === MSG_AWARENESS) {
      const update = decoding.readVarUint8Array(dec)
      if (!this.presenceAllowed(ws, update)) return this.log(`[${this.name}] dropped presence from ${this.names.get(ws)} under another name`)
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, ws)
    } else if (type === MSG_QUERY_AWARENESS) {
      send(ws, awarenessMessage(this.awareness, [...this.awareness.getStates().keys()]))
    } else if (type === MSG_CLAIM) {
      let req = {}
      let reply
      try {
        req = JSON.parse(decoding.readVarString(dec))
        reply = { id: req.id, ...this.claimRequest(this.names.get(ws), req) }
      } catch (err) {
        return send(ws, jsonMessage(MSG_CLAIMS, { claims: this.claimList(), reply: { id: req.id, ok: false, error: err.message } }))
      }
      this.saveMeta()
      const claims = this.claimList()
      for (const other of this.conns.keys()) {
        send(other, jsonMessage(MSG_CLAIMS, other === ws ? { claims, reply } : { claims }))
      }
    } else if (type === MSG_ADMIN) {
      let req = {}
      let reply
      try {
        req = JSON.parse(decoding.readVarString(dec))
        reply = { id: req.id, ...this.adminRequest(ws, req) }
      } catch (err) {
        reply = { id: req.id, ok: false, error: err.message }
      }
      if (reply.ok) this.broadcastMembers(ws, reply)
      else send(ws, jsonMessage(MSG_MEMBERS, { members: this.memberList(), ...(this.access.get(ws)?.owner ? { pending: this.pendingList() } : {}), reply }))
    }
  }

  destroy () {
    clearTimeout(this.unloadTimer)
    this.save()
    this.guard.destroy()
    this.awareness.destroy()
    this.doc.destroy()
  }
}

const nameTaken = (name) => `The name "${name}" belongs to someone else in this room; pick another name`

function send (ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(msg, (err) => { if (err) ws.terminate() })
}

export function startServer ({ port = 4321, host = '0.0.0.0', dataDir = null, log = console.log, ...opts } = {}) {
  const cfg = relayConfig(opts)
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true })
  const startedAt = Date.now()
  const rooms = new Map() // loaded rooms only
  const ipConns = new Map()

  const getRoom = (name) => {
    let room = rooms.get(name)
    if (!room) {
      room = new Room(name, dataDir, cfg, log)
      rooms.set(name, room)
      // Idle rooms are saved and dropped from memory (only when they're on disk).
      room.onEmpty = () => {
        if (!dataDir) return
        clearTimeout(room.unloadTimer)
        room.unloadTimer = setTimeout(() => {
          if (room.conns.size || rooms.get(name) !== room) return
          room.destroy()
          rooms.delete(name)
        }, cfg.idleUnloadMs)
      }
    }
    return room
  }
  // A room that was probed but never created (bad secret / no key) shouldn't linger.
  const dropIfUnused = (room) => {
    if (!room.exists && !room.conns.size) { room.destroy(); rooms.delete(room.name) }
  }

  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      if (fwd) return fwd
    }
    return req.socket.remoteAddress || 'unknown'
  }

  // Files shared in chat are stored on the relay, not in the synced project.
  const filesDir = path.join(dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'cowove-relay-')), 'files')

  const stats = () => {
    let connections = 0
    for (const r of rooms.values()) connections += r.conns.size
    return { ok: true, version: 1, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), roomsLoaded: rooms.size, connections, requiresKey: !!cfg.relayKey }
  }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const text = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(msg) }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(stats()))
    }
    if (url.pathname === '/logo.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' })
      return res.end(fs.readFileSync(LOGO))
    }
    const j = url.pathname.match(/^\/join\/([A-Za-z0-9_-]{1,64})\/?$/)
    if (j) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      return res.end(joinPage(j[1]))
    }
    const m = url.pathname.match(/^\/files\/([A-Za-z0-9_-]{1,64})(?:\/([a-f0-9]{32}))?$/)
    if (!m) {
      if (url.pathname !== '/') return text(404, 'not found')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(statusPage(stats()))
    }

    const [, name, id] = m
    const room = getRoom(name)
    const auth = room.authorize(req.headers['x-cowove-secret'] || '', req.headers['x-cowove-key'] || '')
    if (auth === 'need-key' || auth === 'bad-secret') {
      dropIfUnused(room)
      return text(auth === 'need-key' ? 403 : 401, auth === 'need-key' ? 'this relay needs a key to create rooms' : 'wrong room secret')
    }
    const dir = path.join(filesDir, name)
    if (req.method === 'POST' && !id) {
      const used = dirSize(dir)
      const incoming = Number(req.headers['content-length'] || 0)
      if (used + incoming > cfg.maxRoomFileBytes) return text(413, 'this room has used its file storage quota')
      return receiveFile(req, dir, cfg.maxRoomFileBytes - used, (err, newId) => err ? text(err.code || 500, err.message) : text(201, newId))
    }
    if (req.method === 'GET' && id) {
      const file = path.join(dir, id)
      if (!fs.existsSync(file)) return text(404, 'no such file')
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(file).size })
      return fs.createReadStream(file).pipe(res)
    }
    text(405, 'method not allowed')
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * MB })

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    const name = decodeURIComponent(url.pathname.slice(1))
    const secret = url.searchParams.get('secret') || ''
    const person = (url.searchParams.get('name') || '').trim()
    const publicKey = url.searchParams.get('key') || ''
    const relayKey = url.searchParams.get('relayKey') || req.headers['x-cowove-key'] || ''
    const viewSecret = url.searchParams.get('viewSecret') || ''
    const kind = url.searchParams.get('kind') === 'agent' ? 'agent' : 'human'
    if (!ROOM_RE.test(name)) return reject(socket, 400, 'Bad room name')
    const ip = clientIp(req)
    if ((ipConns.get(ip) || 0) >= cfg.maxConnsPerIp) return reject(socket, 429, 'Too many connections')
    const room = getRoom(name)
    const auth = room.authorize(secret, relayKey, viewSecret)
    if (auth === 'need-key' || auth === 'bad-secret') {
      dropIfUnused(room)
      return reject(socket, auth === 'need-key' ? 403 : 401, auth === 'need-key' ? 'Relay key required to create rooms' : 'Wrong room secret')
    }
    if (!publicKey) return reject(socket, 400, 'This relay needs a newer cowove; please update')
    const key = parsePublicKey(publicKey)
    if (!person || person.length > MAX_NAME || !key) return reject(socket, 400, 'Bad name or identity key')
    if (!room.keyMatches(person, publicKey)) return reject(socket, 403, nameTaken(person))
    wss.handleUpgrade(req, socket, head, (ws) => {
      ipConns.set(ip, (ipConns.get(ip) || 0) + 1)
      ws.isAlive = true
      ws.on('pong', () => { ws.isAlive = true })
      ws.on('close', () => {
        const n = (ipConns.get(ip) || 1) - 1
        if (n) ipConns.set(ip, n)
        else ipConns.delete(ip)
      })
      room.admit(ws, person, publicKey, key, { kind, invitedAs: auth }, () => {
        log(`[${name}] ${person} connected (${room.conns.size} online)`)
        ws.on('close', () => log(`[${name}] ${person} left (${room.conns.size} online)`))
        if (room.full) log(`[${name}] ${person} joined while over quota (read-only)`)
      })
    })
  })

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue }
      ws.isAlive = false
      ws.ping()
    }
  }, 30000)

  // Delete rooms nobody has opened for a while (hosted relays shouldn't grow forever).
  const sweep = () => {
    if (!dataDir || !cfg.roomTtlDays) return
    const cutoff = Date.now() - cfg.roomTtlDays * DAY
    let removed = 0
    for (const f of fs.readdirSync(dataDir)) {
      if (!f.endsWith('.json')) continue
      const name = f.slice(0, -5)
      if (rooms.has(name)) continue
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'))
        if ((meta.lastActive || meta.createdAt || 0) > cutoff) continue
      } catch {}
      fs.rmSync(path.join(dataDir, `${name}.ydoc`), { force: true })
      fs.rmSync(path.join(dataDir, f), { force: true })
      fs.rmSync(path.join(filesDir, name), { recursive: true, force: true })
      removed++
    }
    if (removed) log(`removed ${removed} room(s) idle for more than ${cfg.roomTtlDays} days`)
  }
  sweep()
  const sweeper = setInterval(sweep, 6 * 60 * 60 * 1000)
  sweeper.unref()

  return new Promise((resolve, reject) => {
    httpServer.once('error', (err) => { clearInterval(heartbeat); clearInterval(sweeper); reject(err) })
    httpServer.listen(port, host, () => {
      const actualPort = httpServer.address().port
      resolve({
        port: actualPort,
        config: cfg,
        rooms, // exposed for tests
        sweep,
        close: () => new Promise((resolve) => {
          clearInterval(heartbeat)
          clearInterval(sweeper)
          for (const ws of wss.clients) ws.terminate()
          for (const room of rooms.values()) room.destroy()
          rooms.clear()
          wss.close()
          httpServer.close(() => resolve())
        })
      })
    })
  })
}

function dirSize (dir) {
  let total = 0
  try { for (const f of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, f)).size } catch {}
  return total
}

function receiveFile (req, dir, room, done) {
  fs.mkdirSync(dir, { recursive: true })
  const id = crypto.randomBytes(16).toString('hex')
  const file = path.join(dir, id)
  const out = fs.createWriteStream(file)
  const limit = Math.min(MAX_SHARED_FILE_BYTES, room)
  let size = 0
  let failed = false
  const fail = (code, message) => {
    if (failed) return
    failed = true
    out.destroy()
    fs.rm(file, { force: true }, () => {})
    done(Object.assign(new Error(message), { code }))
  }
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > limit) { fail(413, limit < MAX_SHARED_FILE_BYTES ? 'this room has used its file storage quota' : 'file too large'); req.destroy() }
  })
  req.on('error', () => fail(400, 'upload interrupted'))
  req.pipe(out)
  out.on('finish', () => { if (!failed) done(null, id) })
  out.on('error', (err) => fail(500, err.message))
}

function reject (socket, code, message) {
  socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

const PAGE_STYLE = `
:root{--bg:#f6f4f0;--card:#fff;--text:#1c1929;--muted:#6d6882;--ok:#22a06b;--border:#e7e2da;--code:#f1eee8;--accent:#1c1929;--on-accent:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0e0c17;--card:#161327;--text:#f0edf8;--muted:#a09ab8;--border:#2a2542;--code:#221e38;--accent:#f0edf8;--on-accent:#0e0c17}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:32px;max-width:440px;width:100%;text-align:center}
img{width:64px;height:64px}h1{margin:12px 0 4px;font-size:22px;letter-spacing:-.02em}
.ok{display:inline-flex;align-items:center;gap:8px;color:var(--ok);font-weight:650}.ok i{width:9px;height:9px;border-radius:50%;background:var(--ok)}
p{color:var(--muted);margin:12px 0 0}code{font-size:13px}a{color:inherit}`

/** Where an invite link lands in a browser: says how to open it in cowove. */
function joinPage (room) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Join on cowove</title><link rel="icon" href="/logo.svg">
<style>${PAGE_STYLE}
ol{text-align:left;color:var(--muted);margin:20px 0 0;padding-left:20px}li{margin:8px 0}li b{color:var(--text)}
.box{display:flex;gap:8px;align-items:center;background:var(--code);border-radius:10px;padding:8px 8px 8px 12px;margin-top:18px;text-align:left}
.box code{flex:1;min-width:0;overflow-wrap:anywhere;font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
button{border:0;border-radius:8px;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:600;padding:8px 14px;cursor:pointer}
</style></head><body><div class="card"><img src="/logo.svg" alt=""><h1>You're invited to code together</h1>
<p>Someone invited you to the cowove session <b>${room}</b>.</p>
<div class="box"><code id="link"></code><button id="copy">Copy</button></div>
<ol>
<li>Open cowove (run <code>cowove ui</code>), choose <b>Join a session</b> and paste this link.</li>
<li>Or in a terminal, in the folder you want the project in: <code id="cmd">cowove join &lt;this link&gt;</code></li>
</ol>
<p>New to cowove? <a href="https://github.com/DanielCarmichaelGit/elegy#quick-start">Install it</a> (takes a minute), then come back to this page.</p>
</div><script>
const link = location.href
document.getElementById('link').textContent = link
document.getElementById('cmd').textContent = 'cowove join ' + link
if (!location.hash) document.getElementById('link').textContent = link + '  (this link is missing its secret; ask for the full link)'
document.getElementById('copy').onclick = async (e) => {
  try { await navigator.clipboard.writeText(link); e.target.textContent = 'Copied' } catch {
    const r = document.createRange(); r.selectNodeContents(document.getElementById('link')); getSelection().removeAllRanges(); getSelection().addRange(r)
  }
}
</script></body></html>`
}

function statusPage (s) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>cowove relay</title><link rel="icon" href="/logo.svg">
<style>${PAGE_STYLE}</style></head><body><div class="card"><img src="/logo.svg" alt=""><h1>cowove relay</h1>
<div class="ok"><i></i>Running</div>
<p>${s.connections} connection${s.connections === 1 ? '' : 's'} · ${s.roomsLoaded} active room${s.roomsLoaded === 1 ? '' : 's'}${s.requiresKey ? ' · starting sessions needs a relay key' : ''}</p>
<p>Point cowove at this relay with<br><code>cowove relay set wss://&lt;this address&gt;</code></p></div></body></html>`
}
