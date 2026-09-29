// Each agent signs in to the relay with its own Ed25519 key, like a person's app does.
// The API keeps the private key, encrypted with AGENT_KEY_SECRET (AES-256-GCM).
import crypto from 'node:crypto'
import { generateIdentity } from '../identity.js'

const keyFrom = (secret) => crypto.createHash('sha256').update(String(secret)).digest()

export function newAgentIdentity (secret) {
  const { publicKey, privateKey } = generateIdentity()
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv)
  const enc = Buffer.concat([c.update(privateKey, 'utf8'), c.final()])
  return { publicKey, privateKeyEnc: [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.') }
}

export function openAgentIdentity ({ publicKey, privateKeyEnc }, secret) {
  const [iv, tag, enc] = String(privateKeyEnc).split('.').map((s) => Buffer.from(s, 'base64url'))
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), iv)
  d.setAuthTag(tag)
  return { publicKey, privateKey: Buffer.concat([d.update(enc), d.final()]).toString('utf8') }
}
