// Local web UI: start/join sessions, chat, share files, see collaborators.
// Listens on 127.0.0.1 only and requires a per-launch token, so web pages you
// visit can't drive it.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runSession, decodeInvite, newConn, readConfig, recentSessions } from './runner.js'
import { startServer } from './server.js'
import { MAX_SHARED_FILE_BYTES } from './protocol.js'

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui')
const LOGO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'logo.svg')
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8']
}

export async function startUi ({ port = 7420, relayPort = 4321 } = {}) {
  const token = crypto.randomBytes(18).toString('base64url')
  const runs = new Map() // id -> { run, logs: [] }
  const clients = new Set() // SSE responses
  let relay = null

  const idFor = (dir) => crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 10)
  const broadcast = (type, data) => {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) res.write(frame)
  }
  const summary = (id) => {
    const r = runs.get(id)
    return { id, dir: r.run.dir, invite: r.run.invite, status: r.run.session.status(), logs: r.logs.slice(-80) }
  }
  const pushStatus = (id) => runs.has(id) && broadcast('session', summary(id))

  async function start ({ mode, dir, name, tool, server, invite, prefer, hostRelay, publicUrl }) {
    if (!dir) throw new Error('Choose a project folder.')
    dir = path.resolve(expandHome(dir))
    const id = idFor(dir)
    if (runs.has(id)) return summary(id)

    let conn
    let inviteServer
    if (mode === 'join') {
      conn = decodeInvite(invite || '')
    } else if (mode === 'rejoin') {
      const saved = readConfig(dir)
      if (!saved) throw new Error('No previous session in that folder.')
      conn = { server: saved.server, room: saved.room, secret: saved.secret }
      inviteServer = saved.inviteServer
      name = name || saved.name
      tool = tool || saved.tool
      if (saved.server.startsWith(`ws://127.0.0.1:${relayPort}`)) await ensureRelay()
    } else {
      if (hostRelay) {
        await ensureRelay()
        conn = newConn(`ws://127.0.0.1:${relay.port}`)
        inviteServer = (publicUrl || '').trim() || `ws://${lanAddress()}:${relay.port}`
        if (!/^wss?:\/\//.test(inviteServer)) inviteServer = inviteServer.replace(/^http/, 'ws')
      } else {
        if (!server) throw new Error('Enter the relay address, or host one on this computer.')
        conn = newConn(server.trim())
      }
    }

    const entry = { logs: [] }
    const log = (line) => {
      entry.logs.push({ ts: Date.now(), line })
      if (entry.logs.length > 200) entry.logs.shift()
      broadcast('log', { id, ts: Date.now(), line })
    }
    entry.run = await runSession({
      dir,
      conn,
      name,
      tool,
      prefer: prefer === 'local' ? 'local' : 'remote',
      inviteServer,
      onLog: log,
      onFatal: async (err) => {
        log(`stopped: ${err.message}`)
        await stop(id)
      }
    })
    runs.set(id, entry)
    const s = entry.run.session
    s.on('status-changed', () => pushStatus(id))
    s.on('message', (m) => broadcast('message', { id, message: m }))
    // Presence changes (e.g. focus, recently edited files) also refresh the view.
    s.conn.awareness.on('change', () => pushStatus(id))
    return summary(id)
  }

  async function stop (id) {
    const r = runs.get(id)
    if (!r) return
    runs.delete(id)
    await r.run.stop()
    broadcast('stopped', { id })
  }

  async function ensureRelay () {
    if (relay) return relay
    try {
      relay = await startServer({ port: relayPort, dataDir: path.join(os.homedir(), '.elegy', 'relay-data'), log: () => {} })
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        // Probably an `elegy serve` already running here; use it.
        relay = { port: relayPort, external: true }
      } else throw err
    }
    return relay
  }

  const get = (id) => {
    const r = runs.get(id)
    if (!r) throw httpError(404, 'That session is not running.')
    return r.run.session
  }

  const api = {
    'GET /api/state': () => ({
      sessions: [...runs.keys()].map(summary),
      recent: recentSessions().filter((r) => !runs.has(idFor(r.dir))),
      defaults: { name: os.userInfo().username, home: os.homedir(), cwd: process.cwd() },
      relay: relay ? { port: relay.port, lan: `ws://${lanAddress()}:${relay.port}` } : null,
      maxFileBytes: MAX_SHARED_FILE_BYTES
    }),
    'POST /api/sessions': (b) => start(b),
    'POST /api/sessions/:id/stop': (b, id) => stop(id).then(() => ({ ok: true })),
    'POST /api/sessions/:id/say': (b, id) => get(id).say(b.text, { to: b.to || null }),
    'POST /api/sessions/:id/focus': (b, id) => { get(id).setFocus(b.text); return { ok: true } },
    'POST /api/sessions/:id/claim': (b, id) => get(id).claim(b.pattern, b.note),
    'POST /api/sessions/:id/release': (b, id) => ({ released: get(id).release(b.pattern) }),
    'POST /api/sessions/:id/read': (b, id) => { get(id).messages({ limit: 500 }); pushStatus(id); return { ok: true } },
    'GET /api/sessions/:id/messages': (b, id) => ({ messages: get(id).messages({ limit: 200, markRead: false }) }),
    'GET /api/fs': (b, id, url) => listDir(url.searchParams.get('path') || os.homedir())
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }

    // DNS-rebinding guard: only answer requests addressed to localhost.
    const host = (req.headers.host || '').replace(/:\d+$/, '')
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return json(403, { error: 'forbidden host' })

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname]
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      return res.end(fs.readFileSync(path.join(UI_DIR, file)))
    }
    if (req.method === 'GET' && (url.pathname === '/logo.svg' || url.pathname === '/favicon.svg')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml' })
      return res.end(fs.readFileSync(LOGO))
    }

    const supplied = req.headers['x-elegy-token'] || url.searchParams.get('t')
    if (supplied !== token) return json(401, { error: 'Open elegy from the link printed by `elegy ui`.' })

    try {
      if (req.method === 'GET' && url.pathname === '/api/events') return events(req, res)

      let m = url.pathname.match(/^\/api\/sessions\/([a-f0-9]+)\/send$/)
      if (req.method === 'POST' && m) return json(200, await receiveUpload(req, get(m[1])))
      m = url.pathname.match(/^\/api\/sessions\/([a-f0-9]+)\/files\/([a-f0-9]+)$/)
      if (req.method === 'GET' && m) return await serveFile(res, get(m[1]), m[2])

      const pathKey = url.pathname.replace(/^\/api\/sessions\/[a-f0-9]+/, '/api/sessions/:id')
      const sid = (url.pathname.match(/^\/api\/sessions\/([a-f0-9]+)/) || [])[1]
      const handler = api[`${req.method} ${pathKey}`]
      if (!handler) return json(404, { error: 'not found' })
      let raw = ''
      for await (const chunk of req) raw += chunk
      return json(200, await handler(raw ? JSON.parse(raw) : {}, sid, url))
    } catch (err) {
      return json(err.status || 400, { error: err.message })
    }
  })

  function events (req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': hi\n\n')
    clients.add(res)
    const ping = setInterval(() => res.write(': ping\n\n'), 15000)
    req.on('close', () => { clearInterval(ping); clients.delete(res) })
  }

  async function receiveUpload (req, session) {
    const name = path.basename(decodeURIComponent(req.headers['x-filename'] || 'file')) || 'file'
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elegy-up-'))
    const file = path.join(dir, name)
    try {
      let size = 0
      const out = fs.createWriteStream(file)
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_SHARED_FILE_BYTES) { out.destroy(); throw httpError(413, 'File is too large.') }
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
      const to = req.headers['x-to'] ? decodeURIComponent(req.headers['x-to']) : null
      const text = req.headers['x-text'] ? decodeURIComponent(req.headers['x-text']) : ''
      return await session.sendFile(file, { to, text })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  async function serveFile (res, session, msgId) {
    const msg = session.messages({ limit: 500, markRead: false }).find((m) => m.id === msgId)
    if (!msg || !msg.file) throw httpError(404, 'No such file.')
    const local = msg.file.localPath ? path.join(session.root, msg.file.localPath) : await session.fetchFile(msgId)
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${msg.file.name.replace(/[^\w.\- ]/g, '_')}"`
    })
    fs.createReadStream(local).pipe(res)
  }

  const listen = (p) => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(p, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  try { await listen(port) } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err
    await listen(0)
  }
  const actualPort = server.address().port

  return {
    url: `http://127.0.0.1:${actualPort}/?t=${token}`,
    port: actualPort,
    token,
    close: async () => {
      for (const id of [...runs.keys()]) await stop(id)
      for (const res of clients) res.end()
      if (relay && !relay.external) await relay.close()
      await new Promise((r) => server.close(r))
    }
  }
}

function listDir (p) {
  const dir = path.resolve(expandHome(p))
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
  return {
    path: dir,
    parent: path.dirname(dir) !== dir ? path.dirname(dir) : null,
    dirs,
    hasSession: fs.existsSync(path.join(dir, '.elegy', 'config.json')),
    isEmpty: entries.filter((e) => e.name !== '.DS_Store').length === 0
  }
}

function expandHome (p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

function lanAddress () {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return '127.0.0.1'
}

function httpError (status, message) {
  return Object.assign(new Error(message), { status })
}
