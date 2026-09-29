// Client connection to the relay: keeps a Y.Doc and presence in sync over a
// WebSocket, reconnecting with backoff. Edits made while offline are merged on
// reconnect by the CRDT.
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import crypto from 'node:crypto'
import {
  MSG_SYNC, MSG_AWARENESS, MSG_QUERY_AWARENESS, MSG_AUTH, MSG_CLAIM, MSG_CLAIMS,
  MSG_ACCESS, MSG_ADMIN, MSG_MEMBERS,
  CLOSE_AUTH_FAILED, CLOSE_NAME_TAKEN, CLOSE_ROOM_FULL, CLOSE_DENIED,
  encoding, decoding, syncProtocol, awarenessProtocol,
  syncStep1Message, updateMessage, awarenessMessage, bytesMessage, jsonMessage
} from './protocol.js'
import { signChallenge } from './identity.js'

const REQUEST_TIMEOUT_MS = 10000

export const REMOTE = Symbol('remote')

export class Connection extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.server  ws:// or wss:// base URL of the relay
   * @param {string} opts.room
   * @param {string} opts.secret
   * @param {string} opts.name       who we are in the room
   * @param {{ publicKey: string, privateKey: string }} opts.identity  proves the name is ours
   * @param {string} [opts.viewSecret]  when creating a room: the secret for view-only invites
   * @param {'human'|'agent'} [opts.kind]
   * @param {import('yjs').Doc} opts.doc
   * @param {() => void} [opts.beforeRemote] called before remote changes are applied
   */
  constructor ({ server, room, secret, key, viewSecret, kind = 'human', name, identity, doc, beforeRemote }) {
    super()
    // `key` (the relay key) is only needed to create a room on a relay that requires one.
    const q = new URLSearchParams({ secret: secret || '', name, key: identity.publicKey, kind })
    if (key) q.set('relayKey', key)
    if (viewSecret) q.set('viewSecret', viewSecret)
    this.access = null // what the relay says we may do: { state, role, scopes, owner, controlled }
    this.url = `${server.replace(/\/+$/, '')}/${encodeURIComponent(room)}?${q}`
    this.room = room
    this.identity = identity
    this.requests = new Map() // id -> { resolve, reject, timer }
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

    // The relay first asks us to sign a challenge; sync starts once we have.
    ws.on('open', () => { this.authed = false })

    ws.on('message', (data) => {
      try {
        if (this.authed) this.handle(new Uint8Array(data))
        else this.authenticate(new Uint8Array(data))
      } catch (err) { this.emit('warn', `error handling message from relay: ${err.stack}`) }
    })

    ws.on('unexpected-response', (req, res) => {
      const reason = res.statusMessage || `HTTP ${res.statusCode}`
      if (res.statusCode === 403 && /relay key/i.test(reason)) {
        this.emit('fatal', new Error('This relay needs a relay key to start new sessions. Ask whoever runs it, then set it with `quilt relay set <url> --key <key>`.'))
        this.close()
      } else if (res.statusCode === 401 || res.statusCode === 400 || res.statusCode === 403) {
        this.emit('fatal', new Error(`Relay refused connection: ${reason}`))
        this.close()
      } else if (res.statusCode === 429) {
        this.emit('warn', 'relay says there are too many connections from this network; retrying')
      } else {
        this.emit('warn', `relay responded ${reason}`)
      }
    })

    ws.on('error', (err) => this.emit('warn', `connection error: ${err.message}`))

    ws.on('close', (code, reason) => {
      if (code === CLOSE_DENIED) {
        this.emit('fatal', Object.assign(new Error(String(reason) || 'The session owner did not let you in'), { denied: true }))
        this.close()
      } else if (code === CLOSE_AUTH_FAILED || code === CLOSE_NAME_TAKEN) {
        this.emit('fatal', new Error(`Relay refused connection: ${String(reason) || 'identity check failed'}`))
        this.close()
      } else if (code === CLOSE_ROOM_FULL) {
        this.emit('fatal', new Error('This session is over the relay\'s size limit, so new changes can\'t be saved there. Start a new session, or host your own relay with a higher limit.'))
        this.closed = true
      }
      const wasConnected = this.connected
      this.connected = false
      this.synced = false
      this.authed = false
      if (this.ws === ws) this.ws = null
      for (const [id, r] of this.requests) { clearTimeout(r.timer); r.reject(new Error('disconnected from relay')); this.requests.delete(id) }
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

  authenticate (buf) {
    const dec = decoding.createDecoder(buf)
    if (decoding.readVarUint(dec) !== MSG_AUTH) {
      this.emit('fatal', new Error('The relay runs an older quilt that cannot check identities; update it'))
      return this.close()
    }
    const nonce = decoding.readVarUint8Array(dec)
    this.ws.send(bytesMessage(MSG_AUTH, signChallenge(this.identity, this.room, nonce)))
    // The relay handles messages in order, so we can start syncing right away.
    // (If we have to wait for the owner, it ignores this and we start again once let in.)
    this.authed = true
    this.connected = true
    this.backoff = 500
    this.emit('status', 'connected')
    this.startSync()
  }

  startSync () {
    this.send(syncStep1Message(this.doc))
    if (this.awareness.getLocalState() !== null) {
      this.send(awarenessMessage(this.awareness, [this.doc.clientID]))
    }
    const q = encoding.createEncoder()
    encoding.writeVarUint(q, MSG_QUERY_AWARENESS)
    this.send(encoding.toUint8Array(q))
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
    } else if (type === MSG_ACCESS) {
      const was = this.access
      this.access = JSON.parse(decoding.readVarString(dec))
      if (was && was.state === 'pending' && this.access.state === 'approved') this.startSync()
      this.emit('access', this.access)
    } else if (type === MSG_MEMBERS) {
      const msg = JSON.parse(decoding.readVarString(dec))
      this.emit('members', msg)
      this.settle(msg.reply, 'request refused')
    } else if (type === MSG_CLAIMS) {
      const { claims, reply } = JSON.parse(decoding.readVarString(dec))
      this.emit('claims', claims)
      this.settle(reply, 'claim refused')
    }
  }

  settle (reply, fallback) {
    const r = reply && this.requests.get(reply.id)
    if (!r) return
    clearTimeout(r.timer)
    this.requests.delete(reply.id)
    if (reply.ok) r.resolve(reply)
    else r.reject(new Error(reply.error || fallback))
  }

  request (type, req, what) {
    if (!this.authed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`not connected to the relay; ${what} need a connection`))
    }
    const id = crypto.randomBytes(8).toString('hex')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('the relay did not answer')) }, REQUEST_TIMEOUT_MS)
      this.requests.set(id, { resolve, reject, timer })
      this.send(jsonMessage(type, { id, ...req }))
    })
  }

  /** Asks the relay to claim or release; resolves with its reply. Claims need a live connection. */
  claimRequest (req) { return this.request(MSG_CLAIM, req, 'claims') }

  /** Owner only: approve, deny, change or remove someone. */
  adminRequest (req) { return this.request(MSG_ADMIN, req, 'changes to who is in the session') }

  send (msg) {
    if (this.authed && this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg)
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
