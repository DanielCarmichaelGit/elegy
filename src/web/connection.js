// Browser version of src/connection.js: keeps a Y.Doc and presence in sync
// with the relay over a standard WebSocket, reconnecting with backoff. Uses
// only web APIs, so it also runs in Node (tests pass `ws` as WebSocketImpl).
import {
  MSG_SYNC, MSG_AWARENESS, MSG_QUERY_AWARENESS, CLOSE_ROOM_FULL,
  encoding, decoding, syncProtocol, awarenessProtocol,
  syncStep1Message, updateMessage, awarenessMessage
} from '../protocol.js'
import { Emitter } from './emitter.js'

export const REMOTE = Symbol('remote')

export class WebConnection extends Emitter {
  constructor ({ server, room, secret, key, doc, WebSocketImpl = globalThis.WebSocket }) {
    super()
    this.url = `${server.replace(/\/+$/, '')}/${encodeURIComponent(room)}?secret=${encodeURIComponent(secret || '')}${key ? `&key=${encodeURIComponent(key)}` : ''}`
    this.WS = WebSocketImpl
    this.doc = doc
    this.awareness = new awarenessProtocol.Awareness(doc)
    this.ws = null
    this.connected = false
    this.synced = false
    this.closed = false
    this.everOpened = false
    this.failures = 0
    this.backoff = 500

    this._onUpdate = (update, origin) => { if (origin !== REMOTE) this.send(updateMessage(update)) }
    this._onAwareness = ({ added, updated, removed }, origin) => {
      if (origin === 'local') this.send(awarenessMessage(this.awareness, added.concat(updated, removed)))
    }
    doc.on('update', this._onUpdate)
    this.awareness.on('update', this._onAwareness)
    this.connect()
  }

  connect () {
    if (this.closed) return
    let ws
    try { ws = new this.WS(this.url) } catch (err) { return this.emit('fatal', err) }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    let opened = false

    ws.onopen = () => {
      opened = true
      this.everOpened = true
      this.failures = 0
      this.connected = true
      this.backoff = 500
      this.emit('status', 'connected')
      this.send(syncStep1Message(this.doc))
      if (this.awareness.getLocalState() !== null) this.send(awarenessMessage(this.awareness, [this.doc.clientID]))
      const q = encoding.createEncoder()
      encoding.writeVarUint(q, MSG_QUERY_AWARENESS)
      this.send(encoding.toUint8Array(q))
    }
    ws.onmessage = (ev) => {
      try { this.handle(new Uint8Array(ev.data)) } catch (err) { this.emit('warn', `error handling message from relay: ${err.message}`) }
    }
    ws.onerror = () => {}
    ws.onclose = (ev) => {
      if (ev && ev.code === CLOSE_ROOM_FULL) {
        this.emit('fatal', new Error('This session is over the size limit, so new changes can\'t be saved. Start a new session.'))
        this.closed = true
      }
      const wasConnected = this.connected
      this.connected = false
      this.synced = false
      if (this.ws === ws) this.ws = null
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID)
      awarenessProtocol.removeAwarenessStates(this.awareness, others, 'connection')
      if (wasConnected && !this.closed) this.emit('status', 'disconnected')
      if (!opened) {
        // Browsers hide why a WebSocket was refused. A session that never opened
        // after a few tries was most likely refused (bad link), not just offline.
        this.failures++
        if (!this.everOpened && this.failures === 4) this.emit('warn', 'Still can\'t reach this session. Check the link, or whether the server is up.')
      }
      if (!this.closed) {
        setTimeout(() => this.connect(), this.backoff)
        this.backoff = Math.min(this.backoff * 2, 10000)
      }
    }
  }

  handle (buf) {
    const dec = decoding.createDecoder(buf)
    const type = decoding.readVarUint(dec)
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      const msgType = syncProtocol.readSyncMessage(dec, enc, this.doc, REMOTE)
      if (encoding.length(enc) > 1) this.send(encoding.toUint8Array(enc))
      if (msgType === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true
        this.emit('synced')
      }
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), REMOTE)
    } else if (type === MSG_QUERY_AWARENESS) {
      this.send(awarenessMessage(this.awareness, [...this.awareness.getStates().keys()]))
    }
  }

  send (msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(msg)
  }

  waitForSync () {
    if (this.synced) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const offS = this.on('synced', () => { offS(); offF(); resolve() })
      const offF = this.on('fatal', (err) => { offS(); offF(); reject(err) })
    })
  }

  close () {
    if (this.closed && !this.ws) return
    this.closed = true
    this.doc.off('update', this._onUpdate)
    this.awareness.off('update', this._onAwareness)
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'local')
    const ws = this.ws
    if (ws) setTimeout(() => ws.close(), 50) // flush the presence removal first
    this.awareness.destroy()
  }
}
