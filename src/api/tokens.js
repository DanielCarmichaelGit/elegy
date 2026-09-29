// Secrets the accounts API hands out. Only their hashes are stored, so a leaked
// database can't be used to sign in as anyone.
import crypto from 'node:crypto'

export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' // no 0/O, 1/I/L

export function newToken (prefix) {
  return prefix + crypto.randomBytes(32).toString('base64url')
}

export function hashToken (token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

export function sameHash (a, b) {
  const x = Buffer.from(String(a), 'hex'); const y = Buffer.from(String(b), 'hex')
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y)
}

/** The short code a person matches between the app and the website, e.g. 7F3K-9QXM. */
export function newUserCode () {
  let s = ''
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
  return `${s.slice(0, 4)}-${s.slice(4)}`
}

export function normalizeUserCode (input) {
  const s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (s.length !== 8 || [...s].some((ch) => !CODE_ALPHABET.includes(ch))) return null
  return `${s.slice(0, 4)}-${s.slice(4)}`
}
