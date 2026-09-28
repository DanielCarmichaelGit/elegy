// Local web UI: start/join sessions, chat, share files, see collaborators.
// Listens on 127.0.0.1 only and requires a per-launch token, so web pages you
// visit can't drive it.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runSession, decodeInvite, newConn, readConfig, recentSessions, forgetRecent } from './runner.js'
import { startServer } from './server.js'
import { MAX_SHARED_FILE_BYTES } from './protocol.js'
import { getSettings, saveSettings, normalizeRelay, keyFor, checkRelay } from './settings.js'

// The saved default relay, without its key.
const savedRelay = () => {
  const s = getSettings()
  return s.relay ? { url: s.relay, hasKey: !!s.relayKey } : null
}

const TOOL_NAMES = ['Claude Code', 'Cursor', 'Codex', 'Windsurf', 'GitHub Copilot', 'Zed', 'Aider', 'Other']
const COLOR_RE = /^#[0-9a-f]{6}$/i

/** Your profile and preferences, from ~/.cowove/settings.json with sensible defaults. Never includes the relay key. */
function profile () {
  const s = getSettings()
  return {
    name: s.name || os.userInfo().username,
    tool: s.tool || detectTool(),
    color: s.color || null,
    joinDir: s.joinDir || '~/cowove',
    shareAgent: s.shareAgent !== false,
    preferLocal: !!s.preferLocal,
    relayMode: s.relayMode === 'local' || !s.relay ? 'local' : 'hosted',
    publicUrl: s.publicUrl || '',
    relay: savedRelay()
  }
}

/** Checks and saves profile/preference changes. Returns the new profile. */
function updateProfile (b) {
  const patch = {}
  if ('name' in b) {
    const name = String(b.name || '').trim()
    if (!name) throw httpError(400, 'Your name can\'t be empty.')
    if (name.length > 64) throw httpError(400, 'Keep your name under 64 characters.')
    patch.name = name
  }
  if ('tool' in b) {
    if (!TOOL_NAMES.includes(b.tool)) throw httpError(400, 'Pick an AI tool from the list.')
    patch.tool = b.tool
  }
  if ('color' in b) {
    if (b.color && !COLOR_RE.test(b.color)) throw httpError(400, 'That color isn\'t valid.')
    patch.color = b.color || undefined
  }
  if ('joinDir' in b) patch.joinDir = String(b.joinDir || '').trim() || undefined
  if ('shareAgent' in b) patch.shareAgent = b.shareAgent ? undefined : false
  if ('preferLocal' in b) patch.preferLocal = b.preferLocal ? true : undefined
  if ('relayMode' in b) patch.relayMode = b.relayMode === 'local' ? 'local' : undefined
  if ('publicUrl' in b) patch.publicUrl = String(b.publicUrl || '').trim() || undefined
  if ('relay' in b) {
    const prev = getSettings()
    if (!b.relay) { patch.relay = undefined; patch.relayKey = undefined } else {
      patch.relay = normalizeRelay(b.relay)
      if (patch.relay !== prev.relay) patch.relayKey = undefined
    }
  }
  if (b.relayKey) patch.relayKey = String(b.relayKey)
  saveSettings(patch) // undefined values clear a setting
  return profile()
}

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui')
const LOGO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'logo.svg')
// Fonts are bundled from npm so the app works offline and never calls a font CDN.
const FONT_PACKAGES = ['newsreader', 'ibm-plex-sans', 'ibm-plex-mono']
const require = createRequire(import.meta.url)
const fontFile = (pkg, file) => {
  if (!FONT_PACKAGES.includes(pkg) || !/^[a-z0-9-]+\.woff2$/.test(file)) return null
  const f = path.join(path.dirname(require.resolve(`@fontsource/${pkg}/package.json`)), 'files', file)
  return fs.existsSync(f) ? f : null
}
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/common.js': ['common.js', 'text/javascript; charset=utf-8'],
  '/session.js': ['session.js', 'text/javascript; charset=utf-8'],
  '/feed.js': ['feed.js', 'text/javascript; charset=utf-8'],
  '/tree.js': ['tree.js', 'text/javascript; charset=utf-8'],
  '/fileview.js': ['fileview.js', 'text/javascript; charset=utf-8'],
  '/home.js': ['home.js', 'text/javascript; charset=utf-8']
}

export async function startUi ({ port = 7420, relayPort = 4321, onShutdown } = {}) {
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

  async function start ({ mode, dir, name, tool, server, invite, prefer, hostRelay, publicUrl, relayKey, saveDefault }) {
    const me = profile()
    name = name || me.name
    tool = tool || me.tool
    prefer = prefer || (me.preferLocal ? 'local' : 'remote')
    if (mode === 'join' && !dir) {
      const inv = decodeInvite(invite || '')
      dir = path.join(expandHome(me.joinDir), inv.room)
    }
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
      conn = { server: saved.server, room: saved.room, secret: saved.secret, ...(saved.key ? { key: saved.key } : {}) }
      inviteServer = saved.inviteServer
      name = name || saved.name
      tool = tool || saved.tool
      if (saved.server.startsWith(`ws://127.0.0.1:${relayPort}`)) await ensureRelay()
    } else {
      // An explicit relay address wins; otherwise use what Settings says.
      if (hostRelay === undefined) hostRelay = !server && me.relayMode === 'local'
      if (hostRelay) {
        publicUrl = publicUrl ?? me.publicUrl
        await ensureRelay()
        conn = newConn(`ws://127.0.0.1:${relay.port}`)
        inviteServer = (publicUrl || '').trim() || `ws://${lanAddress()}:${relay.port}`
        if (!/^wss?:\/\//.test(inviteServer)) inviteServer = inviteServer.replace(/^http/, 'ws')
      } else {
        server = server || me.relay?.url
        if (!server) throw new Error('Set up a relay in Settings, or host one on this computer.')
        const url = normalizeRelay(server)
        conn = newConn(url, relayKey || keyFor(url))
        if (saveDefault) {
          const prev = getSettings()
          saveSettings({ relay: url, relayKey: relayKey || (prev.relay === url ? prev.relayKey : undefined), relayMode: undefined })
        }
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
      color: me.color,
      shareByDefault: me.shareAgent,
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
    s.on('agent-feed', (entries) => broadcast('feed', { id, entries }))
    s.on('file-changed', (e) => broadcast('file-changed', { id, ...e }))
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
      relay = await startServer({ port: relayPort, dataDir: path.join(os.homedir(), '.cowove', 'relay-data'), log: () => {} })
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        // Probably an `cowove serve` already running here; use it.
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
      defaults: { home: os.homedir(), cwd: process.cwd(), tools: TOOL_NAMES },
      profile: profile(),
      relay: relay ? { port: relay.port, lan: `ws://${lanAddress()}:${relay.port}` } : null,
      maxFileBytes: MAX_SHARED_FILE_BYTES
    }),
    'POST /api/sessions': (b) => start(b),
    'POST /api/sessions/:id/stop': (b, id) => stop(id).then(() => ({ ok: true })),
    'POST /api/sessions/:id/say': (b, id) => get(id).say(b.text, { to: b.to || null }),
    'POST /api/sessions/:id/focus': (b, id) => { get(id).setFocus(b.text); return { ok: true } },
    'POST /api/sessions/:id/claim': (b, id) => get(id).claim(b.pattern, b.note),
    'POST /api/sessions/:id/release': async (b, id) => ({ released: await get(id).release(b.pattern) }),
    'POST /api/sessions/:id/read': (b, id) => { get(id).messages({ limit: 500 }); pushStatus(id); return { ok: true } },
    'GET /api/sessions/:id/messages': (b, id) => ({ messages: get(id).messages({ limit: 200, markRead: false }) }),
    'GET /api/sessions/:id/feed': (b, id, url) => {
      const s = get(id)
      return { entries: s.agentFeedFor(url.searchParams.get('who') || s.name) }
    },
    'GET /api/sessions/:id/tree': (b, id) => get(id).tree(),
    'GET /api/sessions/:id/file': (b, id, url) => {
      const f = get(id).readShared(url.searchParams.get('path'))
      if (!f) throw httpError(404, 'That file is not in this session.')
      return f
    },
    'POST /api/sessions/:id/sharing': (b, id) => ({ on: get(id).setAgentSharing(b.on !== false) }),
    'POST /api/recent/forget': (b) => { forgetRecent(path.resolve(expandHome(String(b.dir || '')))); return { recent: recentSessions().filter((r) => !runs.has(idFor(r.dir))) } },
    'GET /api/settings': () => profile(),
    'POST /api/settings': (b) => updateProfile(b),
    'POST /api/relay/check': async (b) => {
      try { return await checkRelay(b.url) } catch (err) { throw httpError(400, err.message) }
    },
    'GET /api/fs': (b, id, url) => listDir(url.searchParams.get('path') || os.homedir()),
    // Reply first, then shut down, so the page hears back before we exit.
    'POST /api/shutdown': () => {
      if (!onShutdown) throw httpError(501, 'Shut down is not available here.')
      setTimeout(onShutdown, 100)
      return { ok: true }
    }
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
    const font = req.method === 'GET' && url.pathname.match(/^\/fonts\/([a-z-]+)\/([^/]+)$/)
    if (font) {
      const f = fontFile(font[1], font[2])
      if (!f) return json(404, { error: 'not found' })
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=31536000, immutable' })
      return res.end(fs.readFileSync(f))
    }
    if (req.method === 'GET' && (url.pathname === '/logo.svg' || url.pathname === '/favicon.svg')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml' })
      return res.end(fs.readFileSync(LOGO))
    }

    const supplied = req.headers['x-cowove-token'] || url.searchParams.get('t')
    if (supplied !== token) return json(401, { error: 'Open cowove from the link printed by `cowove ui`.' })

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowove-up-'))
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
    hasSession: fs.existsSync(path.join(dir, '.cowove', 'config.json')),
    isEmpty: entries.filter((e) => e.name !== '.DS_Store').length === 0
  }
}

/** The AI coding tool this person most likely uses, from what it has left in their home folder. */
function detectTool () {
  const home = os.homedir()
  const found = [['.claude', 'Claude Code'], ['.cursor', 'Cursor'], ['.codex', 'Codex'], ['.codeium/windsurf', 'Windsurf']]
    .map(([dir, tool]) => {
      try { return { tool, used: fs.statSync(path.join(home, dir)).mtimeMs } } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => b.used - a.used)
  return found[0]?.tool || 'Claude Code'
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
