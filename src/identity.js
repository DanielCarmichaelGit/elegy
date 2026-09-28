// Per-person identity: an Ed25519 key pair kept in ~/.elegy/identity.json.
// The relay ties each name in a room to the first key that used it, and
// checks a signature on every connect, so nobody can act under someone
// else's name (for example to fake or release their claims).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const AUTH_CONTEXT = 'elegy-auth-v1'

export const identityFile = () => path.join(os.homedir(), '.elegy', 'identity.json')

export function generateIdentity () {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
  }
}

/** Loads this machine's identity, creating it on first use. */
export function loadIdentity (file = identityFile()) {
  try {
    const id = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (id.publicKey && id.privateKey) return id
  } catch {}
  const id = generateIdentity()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(id), { mode: 0o600 })
  return id
}

const payload = (room, nonce) => Buffer.concat([Buffer.from(`${AUTH_CONTEXT}\0${room}\0`), Buffer.from(nonce)])

export function signChallenge (identity, room, nonce) {
  const key = crypto.createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
  return new Uint8Array(crypto.sign(null, payload(room, nonce), key))
}

/** Parses a public key sent by a client; null unless it's a valid Ed25519 key. */
export function parsePublicKey (b64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(b64), 'base64url'), format: 'der', type: 'spki' })
    return key.asymmetricKeyType === 'ed25519' ? key : null
  } catch { return null }
}

export function verifyChallenge (key, room, nonce, signature) {
  try { return crypto.verify(null, payload(room, nonce), key, Buffer.from(signature)) } catch { return false }
}
