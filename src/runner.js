// Starting and stopping a session for a folder. Shared by `elegy join` and
// `elegy ui` so both behave identically (config, STATUS.md, control API).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Session } from './session.js'
import { startControl } from './control.js'
import { renderStatus } from './status.js'
import { startAgentReaders } from './agents/index.js'
import { keyFor } from './settings.js'

export const encodeInvite = (c) => Buffer.from(JSON.stringify({ s: c.server, r: c.room, k: c.secret })).toString('base64url')

export function decodeInvite (code) {
  let j
  try {
    j = JSON.parse(Buffer.from(String(code).trim().replace(/^elegy join\s+/, '').replace(/^elegy:/, ''), 'base64url').toString('utf8'))
  } catch {
    throw new Error('That invite code is not valid.')
  }
  if (!j || !j.s || !j.r) throw new Error('That invite code is not valid.')
  return { server: j.s, room: j.r, secret: j.k || '' }
}

export function newConn (server, key = keyFor(server)) {
  return {
    server,
    ...(key ? { key } : {}),
    room: `room-${crypto.randomBytes(4).toString('hex')}`,
    secret: crypto.randomBytes(18).toString('base64url')
  }
}

export function readConfig (dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.elegy', 'config.json'), 'utf8')) } catch { return null }
}

/** True if another process is already syncing this exact folder. */
export function runningElsewhere (dir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, '.elegy', 'daemon.json'), 'utf8'))
    if (info.pid === process.pid) return false
    process.kill(info.pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Starts syncing `dir`. `conn` is { server, room, secret }; `inviteServer`
 * optionally overrides the relay address given out in invites (e.g. a public
 * tunnel URL when the relay runs on this machine).
 */
export async function runSession ({ dir, conn, name, tool, prefer = 'remote', inviteServer, onLog, onFatal, onDebug, kind = 'human', agentFeed = true, readerOptions = {} }) {
  dir = path.resolve(dir)
  if (!/^wss?:\/\//.test(conn.server)) throw new Error('The relay address must start with ws:// or wss://')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (!fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`)
  if (runningElsewhere(dir)) throw new Error('This folder is already being synced by another elegy process.')

  name = (name || os.userInfo().username).trim()
  tool = tool || 'unknown'
  const invite = encodeInvite({ ...conn, server: inviteServer || conn.server })
  const previous = readConfig(dir)
  // Sharing your AI chat is on by default; a pause is remembered for this folder.
  const shareAgent = !(previous && previous.room === conn.room && previous.shareAgent === false)
  fs.mkdirSync(path.join(dir, '.elegy'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.elegy', 'config.json'),
    JSON.stringify({ ...conn, name, tool, inviteServer: inviteServer || undefined, shareAgent }, null, 2), { mode: 0o600 })
  ensureGitExclude(dir)

  const session = new Session({ dir, ...conn, name, tool, prefer, kind, shareAgent })
  if (onLog) session.on('log', onLog)
  if (onDebug) session.on('debug', onDebug)
  session.on('fatal', (err) => onFatal && onFatal(err))
  const statusFile = path.join(dir, '.elegy', 'STATUS.md')
  session.on('status-changed', () => {
    try { fs.writeFileSync(statusFile, renderStatus(session.status())) } catch {}
  })

  try {
    await session.start({ waitTimeoutMs: 15000 })
  } catch (err) {
    await session.stop().catch(() => {})
    throw err
  }
  const control = await startControl(session, { invite })
  remember({ dir, room: conn.room, server: conn.server, name, tool })

  // Share this person's AI chat (Claude Code, Cursor) with the room.
  const readers = agentFeed
    ? startAgentReaders({
      dir,
      ...readerOptions,
      onEntries: (entries) => session.pushAgentEntries(entries),
      onState: (state) => session.setAgentState(state),
      onLog: (line) => onLog && onLog(line)
    })
    : null

  let stopped = false
  return {
    session,
    invite,
    dir,
    stop: async () => {
      if (stopped) return
      stopped = true
      if (readers) readers.stop()
      await control.close()
      await session.stop()
    }
  }
}

/** Keep .elegy/ out of git without editing the (synced) .gitignore. */
function ensureGitExclude (dir) {
  const exclude = path.join(dir, '.git', 'info', 'exclude')
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return
    const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
    if (!text.split('\n').includes('.elegy/')) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true })
      fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}.elegy/\n`)
    }
  } catch {}
}

// Recently used folders, for the UI's "rejoin" list.
const recentFile = () => path.join(os.homedir(), '.elegy', 'recent.json')

export function recentSessions () {
  try {
    return JSON.parse(fs.readFileSync(recentFile(), 'utf8')).filter((r) => fs.existsSync(path.join(r.dir, '.elegy', 'config.json')))
  } catch {
    return []
  }
}

function remember (entry) {
  try {
    const list = recentSessions().filter((r) => r.dir !== entry.dir)
    list.unshift({ ...entry, lastUsed: Date.now() })
    fs.mkdirSync(path.dirname(recentFile()), { recursive: true })
    fs.writeFileSync(recentFile(), JSON.stringify(list.slice(0, 12), null, 2))
  } catch {}
}
