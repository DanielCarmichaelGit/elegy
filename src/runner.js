// Starting and stopping a session for a folder. Shared by `cowove join` and
// `cowove ui` so both behave identically (config, STATUS.md, control API).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Session } from './session.js'
import { startControl } from './control.js'
import { renderStatus } from './status.js'
import { startAgentReaders } from './agents/index.js'
import { keyFor } from './settings.js'
import { createSummarizer } from './summarize.js'

/**
 * An invite is a link to the relay's join page: https://<relay>/join/<room>#<secret>.
 * The secret sits after `#`, so browsers never send it to the relay.
 */
export function encodeInvite (c) {
  const base = String(c.server).replace(/\/+$/, '').replace(/^ws(s?):\/\//, 'http$1://')
  return `${base}/join/${encodeURIComponent(c.room)}#${encodeURIComponent(c.secret || '')}`
}

/** Reads an invite link (or an older base64 invite code), with or without "cowove join" in front. */
export function decodeInvite (code) {
  const raw = String(code).trim().replace(/^cowove join\s+/, '').replace(/^cowove:/, '').split(/\s/)[0].replace(/^["']|["']$/g, '')
  const m = raw.match(/^(https?):\/\/(.+)\/join\/([^/#?]+)\/?(?:#(.*))?$/)
  if (m) {
    try {
      return { server: `${m[1] === 'https' ? 'wss' : 'ws'}://${m[2]}`, room: decodeURIComponent(m[3]), secret: decodeURIComponent(m[4] || '') }
    } catch {}
  }
  let j
  try {
    // A website invite link carries the code after "#": https://host/#<code>
    j = JSON.parse(Buffer.from(raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : raw, 'base64url').toString('utf8'))
  } catch {}
  if (!j || !j.s || !j.r) throw new Error('That invite link is not valid. Copy the whole link they sent.')
  return { server: j.s, room: j.r, secret: j.k || '' }
}

/** A new room: `secret` invites people to edit, `viewSecret` to only watch. */
export function newConn (server, key = keyFor(server)) {
  return {
    server,
    ...(key ? { key } : {}),
    room: `room-${crypto.randomBytes(4).toString('hex')}`,
    secret: crypto.randomBytes(18).toString('base64url'),
    viewSecret: crypto.randomBytes(18).toString('base64url')
  }
}

export function readConfig (dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.cowove', 'config.json'), 'utf8')) } catch { return null }
}

/** True if another process is already syncing this exact folder. */
export function runningElsewhere (dir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, '.cowove', 'daemon.json'), 'utf8'))
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
export async function runSession ({ dir, conn, name, tool, color = null, shareByDefault = true, summarizeByDefault = false, joined = false, prefer = 'remote', inviteServer, onLog, onFatal, onDebug, kind = 'human', agentFeed = true, readerOptions = {} }) {
  dir = path.resolve(dir)
  if (!/^wss?:\/\//.test(conn.server)) throw new Error('The relay address must start with ws:// or wss://')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (!fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`)
  if (runningElsewhere(dir)) throw new Error('This folder is already being synced by another cowove process.')

  name = (name || os.userInfo().username).trim()
  tool = tool || 'unknown'
  const invite = encodeInvite({ ...conn, server: inviteServer || conn.server })
  // Only the person who made the room has the view-only secret.
  const viewInvite = conn.viewSecret ? encodeInvite({ ...conn, secret: conn.viewSecret, server: inviteServer || conn.server }) : null
  const previous = readConfig(dir)
  // Sharing your AI chat follows your setting; a pause or resume is remembered for this folder.
  const shareAgent = previous && previous.room === conn.room && typeof previous.shareAgent === 'boolean' ? previous.shareAgent : shareByDefault !== false
  const summarize = previous && previous.room === conn.room && typeof previous.summarize === 'boolean' ? previous.summarize : !!summarizeByDefault
  fs.mkdirSync(path.join(dir, '.cowove'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.cowove', 'config.json'),
    JSON.stringify({ ...conn, name, tool, inviteServer: inviteServer || undefined, shareAgent, summarize }, null, 2), { mode: 0o600 })
  ensureGitExclude(dir)

  const session = new Session({ dir, ...conn, name, tool, color, prefer, kind, shareAgent })
  const summarizer = () => createSummarizer({ onWarn: (msg) => session.log(`✂️  ${msg}`) })
  if (summarize) session.summarizer = summarizer()
  if (onLog) session.on('log', onLog)
  if (onDebug) session.on('debug', onDebug)
  session.on('fatal', (err) => onFatal && onFatal(err))
  const statusFile = path.join(dir, '.cowove', 'STATUS.md')
  session.on('status-changed', () => {
    try { fs.writeFileSync(statusFile, renderStatus(session.status())) } catch {}
  })

  try {
    await session.start({ waitTimeoutMs: 15000 })
  } catch (err) {
    await session.stop().catch(() => {})
    throw err
  }
  const control = await startControl(session, { invite, viewInvite, joined })
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
    viewInvite,
    summarizer,
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

/** Keep .cowove/ out of git without editing the (synced) .gitignore. */
function ensureGitExclude (dir) {
  const exclude = path.join(dir, '.git', 'info', 'exclude')
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return
    const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
    if (!text.split('\n').includes('.cowove/')) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true })
      fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}.cowove/\n`)
    }
  } catch {}
}

// Recently used folders, for the UI's "rejoin" list.
const recentFile = () => path.join(os.homedir(), '.cowove', 'recent.json')

export function recentSessions () {
  try {
    return JSON.parse(fs.readFileSync(recentFile(), 'utf8')).filter((r) => fs.existsSync(path.join(r.dir, '.cowove', 'config.json')))
  } catch {
    return []
  }
}

/** Drops a folder from the recent list (its files and settings stay). */
export function forgetRecent (dir) {
  try {
    const list = JSON.parse(fs.readFileSync(recentFile(), 'utf8')).filter((r) => r.dir !== dir)
    fs.writeFileSync(recentFile(), JSON.stringify(list, null, 2))
  } catch {}
}

function remember (entry) {
  try {
    const list = recentSessions().filter((r) => r.dir !== entry.dir)
    list.unshift({ ...entry, lastUsed: Date.now() })
    fs.mkdirSync(path.dirname(recentFile()), { recursive: true })
    fs.writeFileSync(recentFile(), JSON.stringify(list.slice(0, 12), null, 2))
  } catch {}
}
