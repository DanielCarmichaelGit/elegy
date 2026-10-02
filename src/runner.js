// Starting and stopping a session for a folder. Shared by `quilt join` and
// `quilt ui` so both behave identically (config, STATUS.md, control API).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Session } from './session.js'
import { startControl } from './control.js'
import { renderStatus } from './status.js'
import { startAgentReaders } from './agents/index.js'
import { relayUrl, isHostedRelay } from './settings.js'
import { createSummarizer } from './summarize.js'
import { quiltHome, migrateDir } from './legacy.js'
import { writePrivateJson } from './private-file.js'
import { listProcesses } from './procs.js'
import { JOIN_HOST, buildInvite, parseInvite } from './ui/invite.js'

export { JOIN_HOST }

/**
 * An invite link: https://join.heyquilt.com/<room>#<secret> for sessions on Quilt's relay,
 * or https://<relay>/join/<room>#<secret> for any other relay (development relays).
 */
export function encodeInvite (c) {
  return buildInvite(c, isHostedRelay)
}

/**
 * Reads an invite link (or an older base64 code), with or without "quilt join" or "quilt:" in front.
 * A link naming its own relay is accepted only for Quilt's relay or the one this computer already
 * uses (QUILT_SERVER), so a crafted link can't hand this computer's pass and files to another relay.
 */
export function decodeInvite (code) {
  const r = parseInvite(code, { allowRelay: (s) => isHostedRelay(s) || s === relayUrl() })
  return { server: r.relay || relayUrl(), room: r.room, secret: r.secret }
}

/** A new room on Quilt's relay: `secret` invites people to edit, `viewSecret` to only watch. */
export function newConn (server = relayUrl()) {
  return {
    server,
    room: `room-${crypto.randomBytes(4).toString('hex')}`,
    secret: crypto.randomBytes(18).toString('base64url'),
    viewSecret: crypto.randomBytes(18).toString('base64url')
  }
}

export function readConfig (dir) {
  try { return JSON.parse(fs.readFileSync(path.join(migrateDir(dir), 'config.json'), 'utf8')) } catch { return null }
}

/** The other process syncing this exact folder ({ pid, port, token } from its daemon.json), or null. */
function otherSync (dir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, '.quilt', 'daemon.json'), 'utf8'))
    if (info.pid === process.pid) return null
    process.kill(info.pid, 0)
    return info
  } catch {
    return null
  }
}

/** True if another process is already syncing this exact folder. */
export function runningElsewhere (dir) {
  return !!otherSync(dir)
}

/**
 * Says what is already syncing `dir`, so the person can stop it rather than guess: an AI
 * agent that joined from its tool's quilt MCP server, a `quilt join` in a terminal, another
 * copy of the app. Null when nothing else is.
 */
export async function describeOtherSync (dir) {
  const other = otherSync(dir)
  if (!other) return null
  let info = null
  try {
    const res = await fetch(`http://127.0.0.1:${other.port}/info`, { headers: { authorization: `Bearer ${other.token}` }, signal: AbortSignal.timeout(1500) })
    if (res.ok) info = await res.json()
  } catch {}
  const proc = listProcesses().find((p) => p.pid === other.pid)
  const who = info && info.kind === 'agent'
    ? `your AI agent "${info.name}" joined it from its tool's quilt MCP server (process ${other.pid}). Ask the agent to leave with quilt_leave_session, or close that tool`
    : proc && proc.kind === 'app'
      ? `another copy of the Quilt app (process ${other.pid}) has it open. Leave it there, or quit that app`
      : proc && proc.kind === 'sync'
        ? `a \`quilt join\` in a terminal (process ${other.pid}) is syncing it${info ? ` as "${info.name}"` : ''}. Stop that one (Ctrl-C there, or \`quilt stop\`)`
        : `another quilt process (${other.pid}) is syncing it${info ? ` as "${info.name}"` : ''}. Stop that one first`
  return `This folder is already being synced by another quilt process: ${who}, then rejoin here.`
}

/**
 * Starts syncing `dir`. `conn` is { server, room, secret }; `inviteServer`
 * optionally overrides the relay address given out in invites (e.g. a public
 * tunnel URL when the relay runs on this machine).
 */
export async function runSession ({ dir, conn, name, tool, color = null, shareByDefault = true, summarizeByDefault = false, joined = false, prefer = 'remote', inviteServer, onLog, onFatal, onDebug, kind = 'human', agentFeed = true, readerOptions = {}, passes = null, identity = null }) {
  dir = path.resolve(dir)
  if (!/^wss?:\/\//.test(conn.server)) throw new Error('The relay address must start with ws:// or wss://')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (!fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`)
  const busy = await describeOtherSync(dir)
  if (busy) throw new Error(busy)

  // With passes, the relay knows you by your account (or agent): its name and agent
  // badge come from the pass. The session starts with the name saved on this computer
  // (or one already fetched) and takes the pass's once it arrives, without waiting for
  // one here, so being offline doesn't stop a session from starting.
  const p = passes && passes.payload
  if (p && p.name) name = p.name
  if (p && p.kind === 'agent') kind = 'agent'
  name = (name || os.userInfo().username).trim()
  tool = tool || 'unknown'
  const invite = encodeInvite({ ...conn, server: inviteServer || conn.server })
  // Only the person who made the room has the view-only secret.
  const viewInvite = conn.viewSecret ? encodeInvite({ ...conn, secret: conn.viewSecret, server: inviteServer || conn.server }) : null
  const previous = readConfig(dir)
  // Sharing your AI chat follows your setting; a pause or resume is remembered for this folder.
  const shareAgent = previous && previous.room === conn.room && typeof previous.shareAgent === 'boolean' ? previous.shareAgent : shareByDefault !== false
  const summarize = previous && previous.room === conn.room && typeof previous.summarize === 'boolean' ? previous.summarize : !!summarizeByDefault
  fs.mkdirSync(path.join(dir, '.quilt'), { recursive: true })
  const configFile = path.join(dir, '.quilt', 'config.json')
  // It holds the room secret: written privately and atomically (see private-file.js).
  writePrivateJson(configFile, { ...conn, name, tool, inviteServer: inviteServer || undefined, shareAgent, summarize })
  // Keeps the saved name in step with the pass's (the rest of the file may have changed since).
  const saveName = (name) => {
    try { writePrivateJson(configFile, { ...JSON.parse(fs.readFileSync(configFile, 'utf8')), name }) } catch {}
  }
  ensureGitExclude(dir)

  const session = new Session({ dir, ...conn, name, tool, color, prefer, kind, shareAgent, identity, passes })
  const summarizer = () => createSummarizer({ onWarn: (msg) => session.log(`✂️  ${msg}`) })
  if (summarize) session.summarizer = summarizer()
  if (onLog) session.on('log', onLog)
  if (onDebug) session.on('debug', onDebug)
  session.on('fatal', (err) => onFatal && onFatal(err))
  const statusFile = path.join(dir, '.quilt', 'STATUS.md')
  session.on('status-changed', () => {
    try { fs.writeFileSync(statusFile, renderStatus(session.status())) } catch {}
  })

  try {
    await session.start({ waitTimeoutMs: 15000 })
  } catch (err) {
    await session.stop().catch(() => {})
    throw err
  }
  // The pass may have named us differently from the name we started with.
  if (session.name !== name) saveName(session.name)
  session.on('identity', ({ name }) => saveName(name))
  const control = await startControl(session, { invite, viewInvite, joined })
  remember({ dir, room: conn.room, server: conn.server, name: session.name, tool })

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

/** Keep .quilt/ out of git without editing the (synced) .gitignore. */
function ensureGitExclude (dir) {
  const exclude = path.join(dir, '.git', 'info', 'exclude')
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return
    const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
    if (!text.split('\n').includes('.quilt/')) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true })
      fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}.quilt/\n`)
    }
  } catch {}
}

// Recently used folders, for the UI's "rejoin" list.
const recentFile = () => path.join(quiltHome(), 'recent.json')

export function recentSessions () {
  try {
    return JSON.parse(fs.readFileSync(recentFile(), 'utf8')).filter((r) => fs.existsSync(path.join(r.dir, '.quilt', 'config.json')))
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
