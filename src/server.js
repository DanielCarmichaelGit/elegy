// Relay server: holds one shared Yjs document per room, relays updates and
// presence between clients, and persists room state to disk.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import {
  MSG_SYNC, MSG_AWARENESS, MSG_QUERY_AWARENESS, MAX_SHARED_FILE_BYTES,
  encoding, decoding, syncProtocol, awarenessProtocol,
  syncStep1Message, updateMessage, awarenessMessage
} from './protocol.js'

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

class Room {
  constructor (name, dataDir, log) {
    this.name = name
    this.log = log
    this.doc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.awareness.setLocalState(null)
    this.conns = new Map() // ws -> Set<awareness clientID>
    this.docFile = dataDir && path.join(dataDir, `${name}.ydoc`)
    this.metaFile = dataDir && path.join(dataDir, `${name}.json`)
    this.meta = {}
    if (dataDir) {
      if (fs.existsSync(this.docFile)) Y.applyUpdate(this.doc, fs.readFileSync(this.docFile))
      if (fs.existsSync(this.metaFile)) this.meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'))
    }
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

  join (ws) {
    this.conns.set(ws, new Set())
    ws.on('message', (data) => {
      try { this.handle(ws, new Uint8Array(data)) } catch (err) { this.log(`[${this.name}] bad message: ${err.message}`) }
    })
    ws.on('close', () => this.leave(ws))
    send(ws, syncStep1Message(this.doc))
    const states = [...this.awareness.getStates().keys()]
    if (states.length) send(ws, awarenessMessage(this.awareness, states))
  }

  leave (ws) {
    const ids = this.conns.get(ws)
    this.conns.delete(ws)
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
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), ws)
    } else if (type === MSG_QUERY_AWARENESS) {
      send(ws, awarenessMessage(this.awareness, [...this.awareness.getStates().keys()]))
    }
  }
}

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
  const filesDir = path.join(dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'elegy-relay-')), 'files')
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const m = url.pathname.match(/^\/files\/([A-Za-z0-9_-]{1,64})(?:\/([a-f0-9]{32}))?$/)
    if (!m) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end('elegy relay ok\n')
    }
    const [, name, id] = m
    const text = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(msg) }
    if (!getRoom(name).authorize(req.headers['x-elegy-secret'] || '')) return text(401, 'wrong room secret')
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
    if (!ROOM_RE.test(name)) return reject(socket, 400, 'Bad room name')
    const room = getRoom(name)
    if (!room.authorize(secret)) return reject(socket, 401, 'Wrong room secret')
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true
      ws.on('pong', () => { ws.isAlive = true })
      room.join(ws)
      log(`[${name}] client connected (${room.conns.size} online)`)
      ws.on('close', () => log(`[${name}] client left (${room.conns.size} online)`))
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
