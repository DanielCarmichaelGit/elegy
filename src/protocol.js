// Wire protocol shared by the relay server and clients.
// Compatible with the standard y-websocket message layout.
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'

export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
export const MSG_QUERY_AWARENESS = 3
// quilt extensions (ignored by plain y-websocket clients):
export const MSG_AUTH = 10 // relay -> client: nonce; client -> relay: signature
export const MSG_CLAIM = 11 // client -> relay: JSON { id, op: 'claim'|'release', pattern, note }
export const MSG_CLAIMS = 12 // relay -> client: JSON { claims, reply?: { id, ok, error, released } }
export const MSG_ACCESS = 13 // relay -> client: JSON { state: 'pending'|'approved', role, scopes, owner }
export const MSG_ADMIN = 14 // client (owner) -> relay: JSON { id, op: 'approve'|'deny'|'set'|'remove'|'end'|'name', key, role, scopes, name }
export const MSG_MEMBERS = 15 // relay -> client: JSON { members, sessionName, pending?, reply?: { id, ok, error } }
export const MSG_PASS = 16 // client -> relay: JSON { pass }: a fresh session pass, sent at least every 5 minutes

// WebSocket close codes the relay uses to refuse a client for good.
export const CLOSE_AUTH_FAILED = 4401
export const CLOSE_NAME_TAKEN = 4403
export const CLOSE_DENIED = 4406 // the owner said no, or removed you

// WebSocket close code the relay uses when a room is over its size quota.
export const CLOSE_ROOM_FULL = 4413

export const CLOSE_ENDED = 4410 // the owner ended the session and it was deleted

// The connection's session pass ran out without a new one. Clients reconnect with a fresh pass.
export const CLOSE_PASS_EXPIRED = 4419

// Sent to apps too old for a session that now stores large files. It reuses
// 4401 because every app that knows close codes stops on it and shows the
// reason; the oldest ones reconnect instead, and the relay refuses that
// reconnect with the same message.
export const CLOSE_NEEDS_UPDATE = CLOSE_AUTH_FAILED

// Largest file that can be sent in chat.
export const MAX_SHARED_FILE_BYTES = 100 * 1024 * 1024

export { encoding, decoding, syncProtocol, awarenessProtocol }

export function syncStep1Message (doc) {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_SYNC)
  syncProtocol.writeSyncStep1(enc, doc)
  return encoding.toUint8Array(enc)
}

export function updateMessage (update) {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_SYNC)
  syncProtocol.writeUpdate(enc, update)
  return encoding.toUint8Array(enc)
}

export function awarenessMessage (awareness, clients) {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_AWARENESS)
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, clients))
  return encoding.toUint8Array(enc)
}

export function bytesMessage (type, bytes) {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, type)
  encoding.writeVarUint8Array(enc, bytes)
  return encoding.toUint8Array(enc)
}

export function jsonMessage (type, value) {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, type)
  encoding.writeVarString(enc, JSON.stringify(value))
  return encoding.toUint8Array(enc)
}
