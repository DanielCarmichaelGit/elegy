// `quilt agent join|whoami`: join Quilt as an agent from a terminal, the way an
// AI uses an invite link: send a short profile to the link, get keys back, and
// keep them in ~/.quilt/agents/<name>.json (readable only by you).
import fs from 'node:fs'
import path from 'node:path'
import { quiltHome } from './legacy.js'
import { generateIdentity } from './identity.js'
import { writePrivateJson } from './private-file.js'

export const DEFAULTS = { provider: 'Quilt CLI', type: 'command-line agent' }
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/
const NOT_A_LINK = "That doesn't look like an agent invite link. Copy the whole link from Quilt."
// Refresh a little early so the access key doesn't lapse mid-request.
const EARLY_MS = 60 * 1000

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

async function send (fetchImpl, api, method, route, body, key) {
  const res = await fetchImpl(String(api).replace(/\/+$/, '') + route, {
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
  const r = await send(fetchImpl, saved.api, 'POST', '/v1/agents/token', { refreshKey: saved.refreshKey })
  if (!r.ok) throw new Error(r.body?.error || `Couldn't refresh the agent's keys (${r.status}).`)
  const next = { ...saved, accessKey: r.body.accessKey, accessExpiresAt: r.body.accessExpiresAt, refreshKey: r.body.refreshKey, refreshExpiresAt: r.body.refreshExpiresAt }
  // Save straight away: the old refresh key is spent, and using it again would revoke the agent.
  save(file, next)
  return next
}

/** Who the agent is, refreshing its keys first when the access key has (nearly) run out. */
export async function agentWhoami ({ name, dir, fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
  const file = agentFile(name, dir)
  let saved = load(file, name)
  if (saved.accessExpiresAt - EARLY_MS <= now()) saved = await refresh(saved, file, fetchImpl)
  const r = await send(fetchImpl, saved.api, 'GET', '/v1/agents/me', null, saved.accessKey)
  if (!r.ok) throw new Error(r.body?.error || `Couldn't reach Quilt (${r.status}).`)
  return r.body
}

export function describeAgent (me) {
  const where = me.agent.kind === 'org' ? `an agent in ${me.agent.org.name}` : 'your personal agent'
  const lines = [`${me.agent.name} (${me.agent.provider}, ${me.agent.type}): ${where}`]
  if (me.role) lines.push(`Role: ${me.role.name}`)
  for (const t of me.teams) lines.push(`Team ${t.name}: ${t.access}${t.scopes.length ? `, folders ${t.scopes.join(', ')}` : ''}`)
  return lines.join('\n')
}
