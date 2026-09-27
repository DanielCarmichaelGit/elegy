// Client connection to the relay: keeps a Y.Doc and presence in sync over a
// WebSocket, reconnecting with backoff. Edits made while offline are merged on
// reconnect by the CRDT.
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import {
  MSG_SYNC, MSG_AWARENESS, MSG_QUERY_AWARENESS,
  encoding, decoding, syncProtocol, awarenessProtocol,
  syncStep1Message, updateMessage, awarenessMessage
} from './protocol.js'

export const REMOTE = Symbol('remote')

export class Connection extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.server  ws:// or wss:// base URL of the relay
   * @param {string} opts.room
   * @param {string} opts.secret
   * @param {import('yjs').Doc} opts.doc
   * @param {() => void} [opts.beforeRemote] called before remote changes are applied
   */
  constructor ({ server, room, secret, doc, beforeRemote }) {
    super()
    this.url = `${server.replace(/\/+$/, '')}/${encodeURIComponent(room)}?secret=${encodeURIComponent(secret || '')}`
    this.doc = doc
    this.beforeRemote = beforeRemote || (() => {})
    this.awareness = new awarenessProtocol.Awareness(doc)
    this.ws = null
    this.connected = false
    this.synced = false
    this.closed = false
    this.backoff = 500

    this._onUpdate = (update, origin) => {
      if (origin !== REMOTE) this.send(updateMessage(update))
    }
    this._onAwareness = ({ added, updated, removed }, origin) => {
      if (origin === 'local') this.send(awarenessMessage(this.awareness, added.concat(updated, removed)))
    }
    doc.on('update', this._onUpdate)
    this.awareness.on('update', this._onAwareness)
    this.connect()
  }

  connect () {
    if (this.closed) return
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.on('open', () => {
      this.connected = true
      this.backoff = 500
      this.emit('status', 'connected')
      this.send(syncStep1Message(this.doc))
      if (this.awareness.getLocalState() !== null) {
        this.send(awarenessMessage(this.awareness, [this.doc.clientID]))
      }
      const q = encoding.createEncoder()
      encoding.writeVarUint(q, MSG_QUERY_AWARENESS)
      this.send(encoding.toUint8Array(q))
    })

    ws.on('message', (data) => {
      try { this.handle(new Uint8Array(data)) } catch (err) { this.emit('warn', `bad message from relay: ${err.message}`) }
    })

    ws.on('unexpected-response', (req, res) => {
      const reason = res.statusMessage || `HTTP ${res.statusCode}`
      if (res.statusCode === 401 || res.statusCode === 400) {
        this.emit('fatal', new Error(`Relay refused connection: ${reason}`))
        this.close()
      } else {
        this.emit('warn', `relay responded ${reason}`)
      }
    })

    ws.on('error', (err) => this.emit('warn', `connection error: ${err.message}`))

    ws.on('close', () => {
      const wasConnected = this.connected
      this.connected = false
      this.synced = false
      if (this.ws === ws) this.ws = null
      // Peers' presence is stale once we're disconnected.
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID)
      awarenessProtocol.removeAwarenessStates(this.awareness, others, 'connection')
      if (wasConnected && !this.closed) this.emit('status', 'disconnected')
      if (!this.closed) {
        setTimeout(() => this.connect(), this.backoff)
        this.backoff = Math.min(this.backoff * 2, 10000)
      }
    })
  }

  handle (buf) {
    const dec = decoding.createDecoder(buf)
    const type = decoding.readVarUint(dec)
    if (type === MSG_SYNC) {
      // Give the owner a chance to capture unsaved local edits so remote
      // changes merge with them instead of overwriting them.
      this.beforeRemote()
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg)
  }

  waitForSync () {
    if (this.synced) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const onSynced = () => { cleanup(); resolve() }
      const onFatal = (err) => { cleanup(); reject(err) }
      const cleanup = () => { this.off('synced', onSynced); this.off('fatal', onFatal) }
      this.on('synced', onSynced)
      this.on('fatal', onFatal)
    })
  }

  close () {
    this.closed = true
    this.doc.off('update', this._onUpdate)
    this.awareness.off('update', this._onAwareness)
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'local')
    if (this.ws) {
      const ws = this.ws
      // Flush the presence removal before closing.
      setTimeout(() => ws.close(), 50)
    }
    this.awareness.destroy()
  }
}
