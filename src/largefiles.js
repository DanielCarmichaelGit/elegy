// Encryption for large files stored outside the session document. Each session
// has file keys; a file key is stored in the document only wrapped (encrypted)
// with keys derived from the session's secrets, so only members can open it.
import crypto from 'node:crypto'

const MAGIC = Buffer.from('QF1')
const NONCE = 12
const TAG = 16

/** The key that wraps file keys for whoever holds `secret` in `room`. */
export function deriveWrapKey (secret, room) {
  return Buffer.from(crypto.hkdfSync('sha256', String(secret), String(room), 'quilt-file-key-wrap-v1', 32))
}

export function newFileKey () {
  return crypto.randomBytes(32)
}

function seal (plain, key) {
  const nonce = crypto.randomBytes(NONCE)
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([nonce, body, c.getAuthTag()])
}

function open (sealed, key) {
  if (sealed.length < NONCE + TAG) throw new Error('too short')
  const d = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(0, NONCE))
  d.setAuthTag(sealed.subarray(sealed.length - TAG))
  return Buffer.concat([d.update(sealed.subarray(NONCE, sealed.length - TAG)), d.final()])
}

export function wrapKey (fileKey, wrap) {
  return seal(fileKey, wrap).toString('base64url')
}

/** The file key, or null if this wrap key doesn't open it. */
export function unwrapKey (wrapped, wrap) {
  try {
    const key = open(Buffer.from(String(wrapped), 'base64url'), wrap)
    return key.length === 32 ? key : null
  } catch {
    return null
  }
}

export function encryptBlob (plain, fileKey) {
  return Buffer.concat([MAGIC, seal(plain, fileKey)])
}

export function decryptBlob (sealed, fileKey) {
  try {
    if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a quilt file')
    return open(sealed.subarray(MAGIC.length), fileKey)
  } catch {
    throw new Error('this file could not be decrypted')
  }
}

/** Where a file is stored: the same for the same key and content, meaningless to anyone else. */
export function blobId (fileKey, sha1Hex) {
  return crypto.createHmac('sha256', fileKey).update(`id:${sha1Hex}`).digest('hex').slice(0, 32)
}
