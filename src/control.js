// Local control API (127.0.0.1 only) so the CLI and the MCP server can talk to
// a running session. Discovery info is written to .cowove/daemon.json.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { renderStatus } from './status.js'

export async function startControl (session, extras = {}) {
  const token = crypto.randomBytes(16).toString('hex')
  const routes = {
    'GET /status': () => ({ ...session.status(), markdown: renderStatus(session.status()) }),
    'POST /say': (b) => session.say(b.text, { to: b.to }),
    'POST /send': (b) => session.sendFile(b.path, { to: b.to, text: b.text }),
    'POST /messages': (b) => ({ messages: session.messages({ limit: b.limit || 50, unreadOnly: !!b.unreadOnly, withName: b.with || null }) }),
    'POST /get': async (b) => ({ path: await session.fetchFile(b.id, b.dest) }),
    'POST /focus': (b) => { session.setFocus(b.text); return { ok: true } },
    'POST /claim': (b) => session.claim(b.pattern, b.note),
    'POST /release': async (b) => ({ released: await session.release(b.pattern) }),
    'POST /agent': (b) => { session.addAgent(b.client); return { ok: true } },
    'POST /feed': (b) => ({ entries: session.agentFeedFor(b.who, { limit: Math.min(Number(b.limit) || 40, 300) }) }),
    'GET /tree': () => session.tree(),
    'POST /sharing': (b) => ({ on: session.setAgentSharing(b.on !== false) }),
    'GET /info': () => ({ room: session.room, dir: session.root, name: session.name, kind: session.kind, invite: extras.invite || null, pid: process.pid })
  }
  const server = http.createServer(async (req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' })
    if (req.method === 'GET' && req.url === '/events') return streamEvents(session, req, res)
    const route = routes[`${req.method} ${req.url.split('?')[0]}`]
    if (!route) return reply(404, { error: 'not found' })
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      reply(200, await route(raw ? JSON.parse(raw) : {}))
    } catch (err) {
      reply(400, { error: err.message })
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const file = path.join(session.stateDir, 'daemon.json')
  fs.writeFileSync(file, JSON.stringify({ port: server.address().port, token, pid: process.pid }), { mode: 0o600 })
  return {
    close: () => {
      try { fs.rmSync(file) } catch {}
      return new Promise((r) => server.close(r))
    }
  }
}

// Server-sent events: pushes each new message as it arrives (used by `cowove chat`).
function streamEvents (session, req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.write(': connected\n\n')
  const onMessage = (msg) => {
    res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`)
    if (msg.by !== session.name) session.markRead([msg.id])
  }
  const onLog = (line) => res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`)
  const ping = setInterval(() => res.write(': ping\n\n'), 15000)
  session.on('message', onMessage)
  session.on('log', onLog)
  req.on('close', () => {
    clearInterval(ping)
    session.off('message', onMessage)
    session.off('log', onLog)
  })
}

/** Finds the nearest folder (from `start` upward) with a running session. */
export function findDaemon (start = process.env.COWOVE_DIR || process.cwd()) {
  let dir = path.resolve(start)
  while (true) {
    const file = path.join(dir, '.cowove', 'daemon.json')
    if (fs.existsSync(file)) {
      const info = JSON.parse(fs.readFileSync(file, 'utf8'))
      try { process.kill(info.pid, 0) } catch { return null } // stale
      return { ...info, dir }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export async function call (daemon, method, route, body) {
  const res = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}
