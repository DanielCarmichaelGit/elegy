// Relay server: holds one shared Yjs document per room, relays updates and
// presence between clients, stores files shared in chat, and persists rooms
// to disk. Safe to run on the public internet: rooms need their secret,
// creating rooms can require a relay key, and rooms have size quotas.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import { handleAgentMcp } from './relay-mcp.js'
import {
  MSG_SYNC, MSG_AWARENESS, MSG_QUERY_AWARENESS, MAX_SHARED_FILE_BYTES, CLOSE_ROOM_FULL,
  encoding, decoding, syncProtocol, awarenessProtocol,
  syncStep1Message, updateMessage, awarenessMessage
} from './protocol.js'

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/
const MB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOGO = path.join(ROOT, 'assets', 'logo.svg')
// The website: share a folder or join from an invite link, right in the browser.
const WEB = {
  '/': ['web/index.html', 'text/html; charset=utf-8'],
  '/app.css': ['web/app.css', 'text/css; charset=utf-8'],
  '/app.js': ['web/dist/app.js', 'text/javascript; charset=utf-8'],
  '/app.js.map': ['web/dist/app.js.map', 'application/json']
}
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest()
const sameSecret = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b)

/** Relay settings, from options or environment variables. */
export function relayConfig (opts = {}) {
  const env = process.env
  const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v))
  return {
    relayKey: opts.relayKey ?? env.ELEGY_RELAY_KEY ?? '',
    maxRoomBytes: num(opts.maxRoomBytes ?? env.ELEGY_MAX_ROOM_MB, 256) * (opts.maxRoomBytes !== undefined ? 1 : MB),
    maxRoomFileBytes: num(opts.maxRoomFileBytes ?? env.ELEGY_MAX_ROOM_FILES_MB, 2048) * (opts.maxRoomFileBytes !== undefined ? 1 : MB),
    maxConnsPerIp: num(opts.maxConnsPerIp ?? env.ELEGY_MAX_CONNS_PER_IP, 50),
    roomTtlDays: num(opts.roomTtlDays ?? env.ELEGY_ROOM_TTL_DAYS, 30),
    idleUnloadMs: num(opts.idleUnloadMs, 60 * 1000),
    trustProxy: opts.trustProxy ?? /^(1|true|yes)$/i.test(env.ELEGY_TRUST_PROXY || '')
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
    this.full = this.bytes > cfg.maxRoomBytes
    this.saveTimer = null
    this.unloadTimer = null

    this.doc.on('update', (update, origin) => {
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

  /**
   * First client to open a room sets its secret; later clients must match.
   * Returns 'ok', 'bad-secret' or 'need-key' (creating rooms needs the relay key).
   */
  authorize (secret, key) {
    if (!this.meta.secretHash) {
      if (this.cfg.relayKey && !sameSecret(hash(key || ''), hash(this.cfg.relayKey))) return 'need-key'
      this.meta.secretHash = hash(secret || '').toString('hex')
      this.meta.createdAt = Date.now()
      this.touch()
      return 'ok'
    }
    return sameSecret(hash(secret || ''), Buffer.from(this.meta.secretHash, 'hex')) ? 'ok' : 'bad-secret'
  }

  touch () {
    this.meta.lastActive = Date.now()
    this.saveMeta()
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

  join (ws) {
    clearTimeout(this.unloadTimer)
    this.conns.set(ws, new Set())
    ws.on('message', (data) => {
      try { this.handle(ws, new Uint8Array(data)) } catch (err) { this.log(`[${this.name}] bad message: ${err.message}`) }
    })
    ws.on('close', () => this.leave(ws))
    send(ws, syncStep1Message(this.doc))
    const states = [...this.awareness.getStates().keys()]
    if (states.length) send(ws, awarenessMessage(this.awareness, states))
    this.touch()
  }

  leave (ws) {
    const ids = this.conns.get(ws)
    this.conns.delete(ws)
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
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), ws)
    } else if (type === MSG_QUERY_AWARENESS) {
      send(ws, awarenessMessage(this.awareness, [...this.awareness.getStates().keys()]))
    }
  }

  destroy () {
    clearTimeout(this.unloadTimer)
    this.save()
    this.awareness.destroy()
    this.doc.destroy()
  }
}

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

  // AI links: a browser's token -> the session and name that browser is in now,
  // so the person's AI can use /mcp/<token> (see relay-mcp.js). Tokens are stored hashed.
  const linksFile = dataDir && path.join(dataDir, 'agent-links.json')
  const links = new Map()
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(linksFile, 'utf8')))) links.set(k, v) } catch {}
  let linksTimer = null
  const saveLinks = () => {
    if (!linksFile || linksTimer) return
    linksTimer = setTimeout(() => {
      linksTimer = null
      const cutoff = Date.now() - 30 * DAY
      for (const [k, v] of links) if ((v.tabSeenAt || 0) < cutoff) links.delete(k)
      try { fs.writeFileSync(linksFile, JSON.stringify(Object.fromEntries(links))) } catch {}
    }, 2000)
    linksTimer.unref()
  }
  const tokenKey = (t) => hash(t).toString('hex')
  const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/

  // Files shared in chat are stored on the relay, not in the synced project.
  const filesDir = path.join(dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'elegy-relay-')), 'files')

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
    if (url.pathname === '/status') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(statusPage(stats()))
    }
    if (WEB[url.pathname] && req.method === 'GET') {
      const [file, type] = WEB[url.pathname]
      let body
      try { body = fs.readFileSync(path.join(ROOT, file)) } catch {
        // Not built (a git checkout without `npm run build`): the relay still works.
        if (url.pathname !== '/') return text(404, 'not found')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(statusPage(stats()))
      }
      res.writeHead(200, {
        'content-type': type,
        'cache-control': url.pathname === '/' ? 'no-cache' : 'public, max-age=300',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        ...(url.pathname === '/' ? { 'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'" } : {})
      })
      return res.end(body)
    }
    if (url.pathname === '/agent/link' && req.method === 'POST') {
      return readJson(req, 4096, (err, body) => {
        if (err) return text(400, err.message)
        const { token, room: roomName, secret, name, tool } = body || {}
        if (!TOKEN_RE.test(String(token)) || !ROOM_RE.test(String(roomName)) || typeof name !== 'string' || !name.trim()) return text(400, 'bad link')
        const room = getRoom(roomName)
        if (!room.exists || room.authorize(String(secret || ''), '') !== 'ok') { dropIfUnused(room); return text(403, 'wrong room secret') }
        if (!room.conns.size) room.onEmpty && room.onEmpty()
        const k = tokenKey(token)
        const prev = links.get(k) || {}
        links.set(k, { room: roomName, name: name.trim().slice(0, 60), tool: String(tool || '').slice(0, 40), tabSeenAt: Date.now(), aiSeenAt: prev.aiSeenAt || 0 })
        saveLinks()
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, aiSeenAt: prev.aiSeenAt || 0 }))
      })
    }
    const mm = url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]{20,64})$/)
    if (mm) {
      const k = tokenKey(mm[1])
      const link = links.get(k) || null
      let room = null
      if (link) {
        room = getRoom(link.room)
        if (!room.exists) { dropIfUnused(room); room = null } else {
          link.aiSeenAt = Date.now()
          saveLinks()
        }
      }
      handleAgentMcp({ req, res, room, link: room ? link : null, toolHint: url.searchParams.get('tool') || '' })
        .catch((err) => { log(`mcp error: ${err.message}`); if (!res.headersSent) text(500, 'mcp error') })
        .finally(() => { if (room && !room.conns.size && room.onEmpty) room.onEmpty() })
      return
    }
    const m = url.pathname.match(/^\/files\/([A-Za-z0-9_-]{1,64})(?:\/([a-f0-9]{32}))?$/)
    if (!m) return text(404, 'not found')

    const [, name, id] = m
    const room = getRoom(name)
    const auth = room.authorize(req.headers['x-elegy-secret'] || '', req.headers['x-elegy-key'] || '')
    if (auth !== 'ok') {
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
    if (!ROOM_RE.test(name)) return reject(socket, 400, 'Bad room name')
    const ip = clientIp(req)
    if ((ipConns.get(ip) || 0) >= cfg.maxConnsPerIp) return reject(socket, 429, 'Too many connections')
    const room = getRoom(name)
    const auth = room.authorize(url.searchParams.get('secret') || '', url.searchParams.get('key') || req.headers['x-elegy-key'] || '')
    if (auth !== 'ok') {
      dropIfUnused(room)
      return reject(socket, auth === 'need-key' ? 403 : 401, auth === 'need-key' ? 'Relay key required to create rooms' : 'Wrong room secret')
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ipConns.set(ip, (ipConns.get(ip) || 0) + 1)
      ws.isAlive = true
      ws.on('pong', () => { ws.isAlive = true })
      room.join(ws)
      log(`[${name}] client connected (${room.conns.size} online)`)
      ws.on('close', () => {
        const n = (ipConns.get(ip) || 1) - 1
        if (n) ipConns.set(ip, n)
        else ipConns.delete(ip)
        log(`[${name}] client left (${room.conns.size} online)`)
      })
      if (room.full) log(`[${name}] joined while over quota (read-only)`)
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

function readJson (req, limit, done) {
  let size = 0
  const chunks = []
  req.on('data', (c) => {
    size += c.length
    if (size > limit) { req.destroy(); done(new Error('too large')) } else chunks.push(c)
  })
  req.on('end', () => {
    if (size > limit) return
    try { done(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { done(new Error('bad json')) }
  })
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

function statusPage (s) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>elegy relay</title><link rel="icon" href="/logo.svg">
<style>
:root{--bg:#f6f4f0;--card:#fff;--text:#1c1929;--muted:#6d6882;--ok:#22a06b;--border:#e7e2da}
@media (prefers-color-scheme:dark){:root{--bg:#0e0c17;--card:#161327;--text:#f0edf8;--muted:#a09ab8;--border:#2a2542}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:32px;max-width:440px;text-align:center}
img{width:64px;height:64px}h1{margin:12px 0 4px;font-size:22px;letter-spacing:-.02em}
.ok{display:inline-flex;align-items:center;gap:8px;color:var(--ok);font-weight:650}.ok i{width:9px;height:9px;border-radius:50%;background:var(--ok)}
p{color:var(--muted);margin:12px 0 0}code{font-size:13px}
</style></head><body><div class="card"><img src="/logo.svg" alt=""><h1>elegy relay</h1>
<div class="ok"><i></i>Running</div>
<p>${s.connections} connection${s.connections === 1 ? '' : 's'} · ${s.roomsLoaded} active room${s.roomsLoaded === 1 ? '' : 's'}${s.requiresKey ? ' · starting sessions needs a relay key' : ''}</p>
<p>Point elegy at this relay with<br><code>elegy relay set wss://&lt;this address&gt;</code></p></div></body></html>`
}
