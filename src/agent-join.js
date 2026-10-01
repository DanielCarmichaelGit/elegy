// `quilt agent join|whoami`: join Quilt as an agent from a terminal, the way an
// AI uses an invite link: send a short profile to the link, get keys back, and
// keep them in ~/.quilt/agents/<name>.json (readable only by you).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { quiltHome } from './legacy.js'
import { generateIdentity } from './identity.js'
import { writePrivateJson } from './private-file.js'

export const DEFAULTS = { provider: 'Quilt CLI', type: 'command-line agent' }
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/
const NOT_A_LINK = "That doesn't look like an agent invite link. Copy the whole link from Quilt."
// Refresh a little early so the access key doesn't lapse mid-request.
const EARLY_MS = 60 * 1000
// A refresh lock left behind by a process that died is ignored after this long.
const LOCK_STALE_MS = 30 * 1000
const LOCK_RETRY_MS = 50
// Well under LOCK_STALE_MS, so a slow refresh never outlives its lock.
const REFRESH_TIMEOUT_MS = 15 * 1000

export function agentFile (name, dir = quiltHome()) {
  if (!NAME.test(String(name || ''))) throw new Error('--name must be 1 to 40 letters, numbers, dots, dashes or underscores')
  return path.join(dir, 'agents', `${name}.json`)
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** The API's address and the token in an invite link. Plain http is only
 * allowed for a local address (testing); anything else must be https. */
export function parseJoinLink (link) {
  let u
  try { u = new URL(String(link)) } catch { throw new Error(NOT_A_LINK) }
  const m = u.pathname.match(/^\/v1\/join\/(qj_[A-Za-z0-9_-]+)\/?$/)
  const protoOk = u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))
  if (!m || !protoOk) throw new Error(NOT_A_LINK)
  return { api: u.origin, token: m[1] }
}

async function send (fetchImpl, api, method, route, body, key, extra = {}) {
  const res = await fetchImpl(String(api).replace(/\/+$/, '') + route, {
    ...extra,
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) }
}

/** Makes sure the agents directory exists, is not a symlink, and is private. */
function ensureAgentsDir (dir) {
  let st
  try { st = fs.lstatSync(dir) } catch (err) {
    if (err.code !== 'ENOENT') throw err
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return
  }
  if (st.isSymbolicLink()) throw new Error(`Refusing to use ${dir}: it's a symlink`)
  // Tighten up permissions someone (or some older version) left too loose.
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700)
}

/** Saves the agent's file privately (see private-file.js), in a private agents folder. */
function save (file, data) {
  ensureAgentsDir(path.dirname(file))
  writePrivateJson(file, data)
}

function load (file, name) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`No agent called ${name} here. Run: quilt agent join <link> --name ${name}`)
    throw new Error(`Couldn't read the saved agent file for ${name} (corrupt or unreadable): ${err.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`Couldn't read the saved agent file for ${name} (corrupt or unreadable): ${err.message}`)
  }
}

/** Uses an invite link once and saves the agent's keys. */
export async function agentJoin ({ link, name, provider = DEFAULTS.provider, type = DEFAULTS.type, description = '', dir, fetch: fetchImpl = globalThis.fetch, log = console.log }) {
  const file = agentFile(name, dir)
  const { api, token } = parseJoinLink(link)
  // The agent's own Ed25519 key, for joining sessions in later versions.
  const identity = generateIdentity()
  const r = await send(fetchImpl, api, 'POST', `/v1/join/${token}`, { name, provider, type, description, publicKey: identity.publicKey })
  if (!r.ok) throw new Error(r.body?.error || `Couldn't join Quilt (${r.status}).`)
  const saved = { name, api, agentId: r.body.agentId, accessKey: r.body.accessKey, accessExpiresAt: r.body.accessExpiresAt, refreshKey: r.body.refreshKey, refreshExpiresAt: r.body.refreshExpiresAt, identity }
  save(file, saved)
  log(`Joined Quilt as ${name}. Keys saved in ${file}`)
  return saved
}

async function refresh (saved, file, fetchImpl) {
  const r = await send(fetchImpl, saved.api, 'POST', '/v1/agents/token', { refreshKey: saved.refreshKey }, null, { signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) })
  if (!r.ok) throw Object.assign(new Error(r.body?.error || `Couldn't refresh the agent's keys (${r.status}).`), { status: r.status })
  const next = { ...saved, accessKey: r.body.accessKey, accessExpiresAt: r.body.accessExpiresAt, refreshKey: r.body.refreshKey, refreshExpiresAt: r.body.refreshExpiresAt }
  // Save straight away: the old refresh key is spent, and using it again would revoke the agent.
  save(file, next)
  return next
}

/** A saved agent's file: { name, api, agentId, accessKey, refreshKey, …, identity }. */
export function readAgent ({ name, dir }) {
  return load(agentFile(name, dir), name)
}

const readLock = (lock) => { try { return fs.readFileSync(lock, 'utf8') } catch { return null } }

/**
 * Removes a lock left by a process that died. Renaming is atomic, so only one
 * process can take it over; and if the lock was replaced by a live one in the
 * meantime (its contents changed), that one is put back. (`beforeRename` lets
 * tests step in at the racy moment.)
 */
export function takeOverStale (lock, beforeRename = () => {}) {
  let seen
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs <= LOCK_STALE_MS) return false
    seen = fs.readFileSync(lock, 'utf8')
  } catch {
    return true // gone already: try to take it
  }
  const aside = `${lock}.stale.${process.pid}.${crypto.randomBytes(6).toString('hex')}`
  beforeRename()
  try { fs.renameSync(lock, aside) } catch { return false }
  if (readLock(aside) !== seen) {
    try { fs.linkSync(aside, lock) } catch {}
    fs.rmSync(aside, { force: true })
    return false
  }
  fs.rmSync(aside, { force: true })
  return true
}

/**
 * Runs `fn` holding `<file>.lock`, so only one process at a time refreshes an agent's
 * keys: a refresh key used twice gets the agent revoked for good.
 */
export async function withLock (file, fn) {
  const lock = `${file}.lock`
  const token = `${process.pid}.${crypto.randomBytes(8).toString('hex')}`
  // Wait long enough for a lock left by a dead process to go stale.
  const until = Date.now() + LOCK_STALE_MS + 5000
  for (;;) {
    let fd = null
    try {
      fd = fs.openSync(lock, 'wx', 0o600)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    if (fd !== null) {
      try { fs.writeSync(fd, token) } finally { fs.closeSync(fd) }
      try {
        return await fn()
      } finally {
        // Only our own lock: another process may have taken over one it thought stale.
        if (readLock(lock) === token) fs.rmSync(lock, { force: true })
      }
    }
    if (takeOverStale(lock)) continue
    if (Date.now() > until) throw new Error(`Another Quilt process is stuck refreshing the agent's keys. Remove ${lock} and try again.`)
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
  }
}

/** The saved agent with a working access key, refreshed first when it has (nearly) run out. */
export async function agentAccess ({ name, dir, fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
  const file = agentFile(name, dir)
  const fresh = (saved) => saved.accessExpiresAt - EARLY_MS > now()
  const saved = load(file, name)
  if (fresh(saved)) return saved
  return withLock(file, () => {
    // Another process may have refreshed while we waited: use its keys.
    const latest = load(file, name)
    return fresh(latest) ? latest : refresh(latest, file, fetchImpl)
  })
}

/** Who the agent is, refreshing its keys first when the access key has (nearly) run out. */
export async function agentWhoami ({ name, dir, fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
  const saved = await agentAccess({ name, dir, fetch: fetchImpl, now })
  const r = await send(fetchImpl, saved.api, 'GET', '/v1/agents/me', null, saved.accessKey)
  if (!r.ok) throw new Error(r.body?.error || `Couldn't reach Quilt (${r.status}).`)
  return r.body
}

/** The names of the agents saved on this computer. */
export function savedAgents (dir = quiltHome()) {
  try {
    return fs.readdirSync(path.join(dir, 'agents')).filter((f) => f.endsWith('.json') && !f.startsWith('.')).map((f) => f.slice(0, -5)).sort()
  } catch {
    return []
  }
}

/** Which saved agent a session joins as: the one named, or the only one there is. */
export function pickAgent ({ agent, dir } = {}) {
  if (agent) return agent
  const all = savedAgents(dir)
  if (all.length === 1) return all[0]
  if (!all.length) throw new Error('This computer has no Quilt agent yet. The person you work with can invite one on heyquilt.com, then run: quilt agent join <link> --name <name>')
  throw new Error(`This computer has several Quilt agents (${all.join(', ')}). Say which one to join as.`)
}

export function describeAgent (me) {
  const where = me.agent.kind === 'org' ? `an agent in ${me.agent.org.name}` : 'your personal agent'
  const lines = [`${me.agent.name} (${me.agent.provider}, ${me.agent.type}): ${where}`]
  if (me.role) lines.push(`Role: ${me.role.name}`)
  for (const t of me.teams) lines.push(`Team ${t.name}: ${t.access}${t.scopes.length ? `, folders ${t.scopes.join(', ')}` : ''}`)
  return lines.join('\n')
}
