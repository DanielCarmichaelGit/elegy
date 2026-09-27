// Wire protocol shared by the relay server and clients.
// Compatible with the standard y-websocket message layout.
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'

export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
export const MSG_QUERY_AWARENESS = 3

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
