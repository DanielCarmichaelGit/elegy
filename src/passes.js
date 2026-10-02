// Session passes: short-lived tickets the accounts API signs and the relay checks.
// A pass says who you are (an account or an agent), your name, and the identity
// key you'll prove when you connect (empty for a hosted agent, which only ever
// talks to the relay over HTTPS and never proves a key). Its format is
// base64url(JSON payload) + "." + base64url(Ed25519 signature of the first part).
import crypto from 'node:crypto'
import { generateIdentity, parsePublicKey } from './identity.js'

export const PASS_VERSION = 1
export const PASS_TTL_MS = 10 * 60 * 1000
const MAX_NAME = 64
const KINDS = ['person', 'agent']

/** A new signing pair, encoded like identity keys: SPKI and PKCS8 DER, in base64url. */
export function newPassKeys () {
  return generateIdentity()
}

const privateKeyOf = (k) => typeof k === 'string' ? crypto.createPrivateKey({ key: Buffer.from(k, 'base64url'), format: 'der', type: 'pkcs8' }) : k
const publicKeyOf = (k) => typeof k === 'string' ? parsePublicKey(k) : k

/** The public half of a PASS_SIGNING_KEY, as QUILT_PASS_PUBLIC_KEY takes it. */
export function passPublicKey (signingKey) {
  return crypto.createPublicKey(privateKeyOf(signingKey)).export({ type: 'spki', format: 'der' }).toString('base64url')
}

export function signPass (payload, signingKey) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.sign(null, Buffer.from(body), privateKeyOf(signingKey)).toString('base64url')
  return `${body}.${sig}`
}

/** A pass's payload without checking it (clients read their name from it). Null if malformed. */
export function readPass (pass) {
  const [body, sig, extra] = String(pass ?? '').split('.')
  if (!body || !sig || extra !== undefined) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return p && typeof p === 'object' && !Array.isArray(p) ? p : null
  } catch { return null }
}

/**
 * The payload when the signature verifies, it's version 1, it hasn't expired and
 * its fields make sense; otherwise null.
 */
export function verifyPass (pass, key, { now = Date.now() } = {}) {
  const k = publicKeyOf(key)
  const p = readPass(pass)
  if (!k || !p) return null
  const [body, sig] = String(pass).split('.')
  let signed = false
  try { signed = crypto.verify(null, Buffer.from(body), k, Buffer.from(sig, 'base64url')) } catch {}
  if (!signed || p.v !== PASS_VERSION) return null
  if (typeof p.exp !== 'number' || p.exp <= now) return null
  if (typeof p.sub !== 'string' || !p.sub || !KINDS.includes(p.kind)) return null
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > MAX_NAME) return null
  // No key: an HTTP-only pass (a hosted agent, see relay-mcp.js); it can't open a WebSocket.
  if (typeof p.key !== 'string' || (p.key && !parsePublicKey(p.key))) return null
  return p
}
