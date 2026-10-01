// Per-user settings in ~/.quilt/settings.json: your colour, AI tool and session
// defaults. And the one relay Quilt uses.
import fs from 'node:fs'
import path from 'node:path'
import { quiltHome } from './legacy.js'

/** The relay every session uses. QUILT_SERVER overrides it, for development and tests only. */
export const HOSTED_RELAY = 'wss://relay.heyquilt.com'
// The hosted relay's older address points at the same relay, so its sessions reopen as they are.
const HOSTED_ALIASES = [HOSTED_RELAY, 'wss://cowove-relay.fly.dev']
// Settings from when you could pick a relay. Ignored, and dropped the next time settings are saved.
const RETIRED = ['relay', 'relayKey', 'relayMode', 'publicUrl']

const file = () => path.join(quiltHome(), 'settings.json')

export function getSettings () {
  let s = {}
  try { s = JSON.parse(fs.readFileSync(file(), 'utf8')) || {} } catch {}
  for (const k of RETIRED) delete s[k]
  return s
}

export function saveSettings (patch) {
  const next = { ...getSettings(), ...patch }
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null || next[k] === '') delete next[k]
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(next, null, 2), { mode: 0o600 })
  return next
}

export function relayUrl () {
  return process.env.QUILT_SERVER || HOSTED_RELAY
}

export function isHostedRelay (server) {
  return HOSTED_ALIASES.includes(String(server || '').replace(/\/+$/, ''))
}

/** A session that ran on a relay on someone's own computer ("This computer"), which Quilt no longer runs. */
export function ranOnLocalRelay (server) {
  return /^ws:\/\//.test(String(server || '')) && server !== relayUrl()
}
