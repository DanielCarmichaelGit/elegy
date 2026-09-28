// Relay server: holds one shared Yjs document per room, relays updates and
// presence between clients, and persists room state to disk. It also checks
// who each client is (see identity.js) and owns the room's claims, so only
// the person who made a claim can release it.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import {
  MSG_SYNC, MSG_AWARENESS, MSG_QUERY_AWARENESS, MSG_AUTH, MSG_CLAIM, MSG_CLAIMS, MAX_SHARED_FILE_BYTES,
  CLOSE_AUTH_FAILED, CLOSE_NAME_TAKEN,
  encoding, decoding, syncProtocol, awarenessProtocol,
  syncStep1Message, updateMessage, awarenessMessage, bytesMessage, jsonMessage
} from './protocol.js'
import { parsePublicKey, verifyChallenge } from './identity.js'
import { patternsOverlap } from './fsutil.js'

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_NAME = 64
const MAX_PATTERN = 500
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

class Room {
  constructor (name, dataDir, log) {
    this.name = name
    this.log = log
    this.doc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.awareness.setLocalState(null)
    this.conns = new Map() // ws -> Set<awareness clientID>
    this.names = new Map() // ws -> verified name
    this.docFile = dataDir && path.join(dataDir, `${name}.ydoc`)
    this.metaFile = dataDir && path.join(dataDir, `${name}.json`)
    this.meta = {}
    if (dataDir) {
      if (fs.existsSync(this.docFile)) Y.applyUpdate(this.doc, fs.readFileSync(this.docFile))
      if (fs.existsSync(this.metaFile)) this.meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'))
    }
    this.meta.identities = this.meta.identities || {} // name -> public key
    this.meta.claims = this.meta.claims || {} // pattern -> { by, pattern, note, ts }
    this.saveTimer = null

    this.doc.on('update', (update, origin) => {
      const msg = updateMessage(update)
      for (const ws of this.conns.keys()) if (ws !== origin) send(ws, msg)
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

  // First client to open a room sets its secret; later clients must match.
  authorize (secret) {
    if (!this.meta.secretHash) {
      this.meta.secretHash = hash(secret || '')
      this.saveMeta()
      return true
    }
    return this.meta.secretHash === hash(secret || '')
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
    if (!this.docFile) return
    const tmp = this.docFile + '.tmp'
    fs.writeFileSync(tmp, Y.encodeStateAsUpdate(this.doc))
    fs.renameSync(tmp, this.docFile)
  }

  /**
   * Challenges the client to prove it holds the key for its name, then lets
   * it into the room. Nothing else is accepted until then.
   */
  admit (ws, name, publicKey, key, onJoin) {
    const nonce = crypto.randomBytes(32)
    let joined = false
    ws.on('message', (data) => {
      const buf = new Uint8Array(data)
      if (joined) {
        try { this.handle(ws, buf) } catch (err) { this.log(`[${this.name}] bad message: ${err.message}`) }
        return
      }
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
      joined = true
      this.join(ws, name)
      onJoin()
    })
    ws.on('close', () => { if (joined) this.leave(ws) })
    send(ws, bytesMessage(MSG_AUTH, nonce))
  }

  join (ws, name) {
    this.conns.set(ws, new Set())
    this.names.set(ws, name)
    send(ws, syncStep1Message(this.doc))
    const states = [...this.awareness.getStates().keys()]
    if (states.length) send(ws, awarenessMessage(this.awareness, states))
    send(ws, jsonMessage(MSG_CLAIMS, { claims: this.claimList() }))
  }

  leave (ws) {
    const ids = this.conns.get(ws)
    this.conns.delete(ws)
    this.names.delete(ws)
    if (ids && ids.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null)
    if (this.conns.size === 0) this.save()
  }

  handle (ws, buf) {
    const dec = decoding.createDecoder(buf)
    const type = decoding.readVarUint(dec)
    if (type === MSG_SYNC) {
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
    }
  }
}

const nameTaken = (name) => `The name "${name}" belongs to someone else in this room; pick another name`

function send (ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(msg, (err) => { if (err) ws.terminate() })
}

export function startServer ({ port = 4321, host = '0.0.0.0', dataDir = null, log = console.log } = {}) {
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true })
  const rooms = new Map()
  const getRoom = (name) => {
    if (!rooms.has(name)) rooms.set(name, new Room(name, dataDir, log))
    return rooms.get(name)
  }

  // Files shared in chat are stored on the relay, not in the synced project.
  const filesDir = path.join(dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'cowove-relay-')), 'files')
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const m = url.pathname.match(/^\/files\/([A-Za-z0-9_-]{1,64})(?:\/([a-f0-9]{32}))?$/)
    if (!m) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end('cowove relay ok\n')
    }
    const [, name, id] = m
    const text = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(msg) }
    if (!getRoom(name).authorize(req.headers['x-cowove-secret'] || '')) return text(401, 'wrong room secret')
    const dir = path.join(filesDir, name)
    if (req.method === 'POST' && !id) return receiveFile(req, dir, (err, newId) => err ? text(err.code || 500, err.message) : text(201, newId))
    if (req.method === 'GET' && id) {
      const file = path.join(dir, id)
      if (!fs.existsSync(file)) return text(404, 'no such file')
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(file).size })
      return fs.createReadStream(file).pipe(res)
    }
    text(405, 'method not allowed')
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    const name = decodeURIComponent(url.pathname.slice(1))
    const secret = url.searchParams.get('secret') || ''
    const person = (url.searchParams.get('name') || '').trim()
    const publicKey = url.searchParams.get('key') || ''
    if (!ROOM_RE.test(name)) return reject(socket, 400, 'Bad room name')
    const room = getRoom(name)
    if (!room.authorize(secret)) return reject(socket, 401, 'Wrong room secret')
    if (!publicKey) return reject(socket, 400, 'This relay needs a newer cowove; please update')
    const key = parsePublicKey(publicKey)
    if (!person || person.length > MAX_NAME || !key) return reject(socket, 400, 'Bad name or identity key')
    if (!room.keyMatches(person, publicKey)) return reject(socket, 403, nameTaken(person))
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true
      ws.on('pong', () => { ws.isAlive = true })
      room.admit(ws, person, publicKey, key, () => {
        log(`[${name}] ${person} connected (${room.conns.size} online)`)
        ws.on('close', () => log(`[${name}] ${person} left (${room.conns.size} online)`))
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

  return new Promise((resolve, reject) => {
    httpServer.once('error', (err) => { clearInterval(heartbeat); reject(err) })
    httpServer.listen(port, host, () => {
      const actualPort = httpServer.address().port
      resolve({
        port: actualPort,
        close: () => new Promise((resolve) => {
          clearInterval(heartbeat)
          for (const ws of wss.clients) ws.terminate()
          for (const room of rooms.values()) { room.save(); room.awareness.destroy() }
          wss.close()
          httpServer.close(() => resolve())
        })
      })
    })
  })
}

function receiveFile (req, dir, done) {
  fs.mkdirSync(dir, { recursive: true })
  const id = crypto.randomBytes(16).toString('hex')
  const file = path.join(dir, id)
  const out = fs.createWriteStream(file)
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
    if (size > MAX_SHARED_FILE_BYTES) { fail(413, 'file too large'); req.destroy() }
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
