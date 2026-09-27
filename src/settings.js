// Per-user settings in ~/.elegy/settings.json, such as the default relay
// (the hosted relay you and your friends use) and its key.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const file = () => path.join(os.homedir(), '.elegy', 'settings.json')

export function getSettings () {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')) } catch { return {} }
}

export function saveSettings (patch) {
  const next = { ...getSettings(), ...patch }
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null || next[k] === '') delete next[k]
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(next, null, 2), { mode: 0o600 })
  return next
}

/** "https://relay.example.com/" -> "wss://relay.example.com". Throws on anything that isn't a web address. */
export function normalizeRelay (url) {
  let u = String(url || '').trim().replace(/\/+$/, '')
  if (!u) throw new Error('Enter a relay address, like wss://relay.example.com')
  if (!/^[a-z]+:\/\//i.test(u)) u = `wss://${u}`
  u = u.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:')
  if (!/^wss?:\/\/[^\s/]+/i.test(u)) throw new Error('A relay address looks like wss://relay.example.com')
  return u
}

/** The relay to use for a new session, and the key to create rooms on it. */
export function defaultRelay () {
  const s = getSettings()
  const relay = process.env.ELEGY_SERVER || s.relay || ''
  const key = process.env.ELEGY_RELAY_KEY || (relay && relay === s.relay ? s.relayKey || '' : '')
  return relay ? { relay, key } : null
}

/** Key for creating rooms on `server`, if it's the saved default relay. */
export function keyFor (server) {
  const d = defaultRelay()
  return d && d.relay === server ? d.key : (process.env.ELEGY_RELAY_KEY || '')
}

/** Asks a relay how it's doing. Resolves to its /healthz data, or throws. */
export async function checkRelay (url, { timeoutMs = 8000 } = {}) {
  const http = normalizeRelay(url).replace(/^ws/i, 'http')
  const started = Date.now()
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${http}/healthz`, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`the relay answered HTTP ${res.status}`)
    const data = await res.json()
    if (!data || data.ok !== true) throw new Error('that address answered, but it isn\'t an elegy relay')
    return { ...data, latencyMs: Date.now() - started }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`no answer from ${http} within ${timeoutMs / 1000}s`)
    if (/fetch failed/.test(err.message)) throw new Error(`couldn't reach ${http} (${err.cause?.code || 'network error'})`)
    throw err
  } finally {
    clearTimeout(t)
  }
}
