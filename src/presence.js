// Presence reports: the relay tells the accounts API who is in which session, and
// when, so people's dashboards can show their sessions and who they worked with.
// Only for connections with a pass (an account), and only when the relay has both
// QUILT_API_URL and RELAY_API_SECRET. Events wait in a queue that is kept on disk
// (`<dataDir>/presence-queue.jsonl`), so a restart or a down API loses nothing, and
// are sent every minute, at most 500 per request, in order.
import fs from 'node:fs'
import crypto from 'node:crypto'

export const PRESENCE_FILE = 'presence-queue.jsonl'
export const PRESENCE_FLUSH_MS = 60 * 1000
export const PRESENCE_BATCH = 500
export const PRESENCE_MAX_QUEUE = 100_000
export const PRESENCE_MAX_BACKOFF_MS = 10 * 60 * 1000
const SYNC_MS = 1000
const SEND_TIMEOUT_MS = 15 * 1000
const CLOSE_TIMEOUT_MS = 5 * 1000

export class PresenceReporter {
  /**
   * @param {object} o
   * @param {string} o.apiUrl   the accounts API, e.g. https://api.heyquilt.com
   * @param {string} o.secret   RELAY_API_SECRET. Never logged.
   * @param {string|null} [o.file]  the queue file; null keeps the queue in memory only
   */
  constructor ({ apiUrl, secret, file = null, log = () => {}, now = Date.now, fetch = globalThis.fetch, flushMs = PRESENCE_FLUSH_MS, batch = PRESENCE_BATCH, maxQueue = PRESENCE_MAX_QUEUE, maxBackoffMs = PRESENCE_MAX_BACKOFF_MS, syncMs = SYNC_MS, timeoutMs = SEND_TIMEOUT_MS }) {
    this.url = `${String(apiUrl).replace(/\/+$/, '')}/v1/relay/presence`
    this.secret = secret
    this.file = file
    this.log = log
    this.now = now
    this.fetch = fetch
    this.flushMs = flushMs
    this.batch = batch
    this.maxQueue = maxQueue
    this.maxBackoffMs = maxBackoffMs
    this.syncMs = syncMs
    this.timeoutMs = timeoutMs
    this.queue = [] // { seq, ev }, oldest first
    this.seq = 0
    this.open = new Map() // start event id -> { start, room, account }: visits not ended yet
    this.unwritten = [] // queue lines not yet appended to the file
    this.rewrite = false // the file no longer matches the queue: write it whole next time
    this.failures = 0
    this.retryAt = 0
    this.sending = null
    this.closed = false
    this.timers = []
  }

  /**
   * Reads the queue file a previous run left, and ends at "now" every visit it had
   * started and not ended (the relay crashed, or was redeployed). Returns how many.
   */
  load () {
    if (!this.file) return 0
    let text = ''
    try { text = fs.readFileSync(this.file, 'utf8') } catch (err) { if (err.code !== 'ENOENT') this.log(`presence: could not read ${this.file}: ${err.message}`); return 0 }
    let bad = 0
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { bad++; continue } // a line cut off by a crash
      if (Array.isArray(row.open)) {
        for (const v of row.open) if (v && v.start) this.open.set(v.start, v)
        continue
      }
      if (!row || !row.id || !row.type) { bad++; continue }
      this.queue.push({ seq: ++this.seq, ev: row })
      if (row.type === 'start') this.open.set(row.id, { start: row.id, room: row.room, account: row.account })
      if (row.type === 'end') this.open.delete(row.start)
    }
    if (bad) this.log(`presence: skipped ${bad} unreadable line(s) in ${this.file}`)
    const ended = this.open.size
    this.endAll()
    this.rewrite = true
    this.persist()
    return ended
  }

  /** Sends every minute (sooner retries wait for their backoff) and saves the queue every second. */
  start () {
    const tick = setInterval(() => { this.tick().catch(() => {}) }, this.flushMs)
    const sync = setInterval(() => this.persist(), this.syncMs)
    tick.unref()
    sync.unref()
    this.timers.push(tick, sync)
  }

  get size () { return this.queue.length }

  /** Someone with a pass was let into a room. Returns the visit, for visitEnd. */
  visitStart ({ room, account, name, owner = false }) {
    if (this.closed) return null
    const ev = { id: crypto.randomUUID(), type: 'start', room, account, name, ...(owner ? { owner: true } : {}), at: this.now() }
    const visit = { start: ev.id, room, account }
    this.open.set(ev.id, visit)
    this.enqueue(ev)
    return visit
  }

  /** That connection left (closed, removed, ended, or its pass lapsed). Once per visit. */
  visitEnd (visit) {
    if (this.closed || !visit || !this.open.delete(visit.start)) return
    this.enqueue({ id: crypto.randomUUID(), type: 'end', start: visit.start, room: visit.room, account: visit.account, at: this.now() })
  }

  /** The owner named the session. */
  rename ({ room, name }) {
    if (this.closed) return
    this.enqueue({ id: crypto.randomUUID(), type: 'name', room, name, at: this.now() })
  }

  /** Ends every open visit now: on shutdown, and for visits a previous run left open. */
  endAll () {
    for (const visit of [...this.open.values()]) {
      this.open.delete(visit.start)
      this.enqueue({ id: crypto.randomUUID(), type: 'end', start: visit.start, room: visit.room, account: visit.account, at: this.now() })
    }
  }

  enqueue (ev) {
    this.queue.push({ seq: ++this.seq, ev })
    this.unwritten.push(ev)
    if (this.queue.length > this.maxQueue) {
      const drop = this.queue.length - this.maxQueue
      this.queue.splice(0, drop)
      this.rewrite = true
      this.log(`presence: the queue is full (${this.maxQueue} events); dropped the ${drop} oldest`)
    }
  }

  /** Saves what's new in the queue: appended and fsynced, or the whole file when it has to be. */
  persist () {
    if (!this.file || (!this.rewrite && !this.unwritten.length)) return
    try {
      if (this.rewrite) {
        // Written whole, then renamed: a crash mid-write leaves the old file, never half of one.
        const tmp = `${this.file}.tmp`
        const lines = [JSON.stringify({ open: [...this.open.values()] }), ...this.queue.map((x) => JSON.stringify(x.ev))]
        const fd = fs.openSync(tmp, 'w')
        try { fs.writeSync(fd, lines.join('\n') + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        fs.renameSync(tmp, this.file)
      } else {
        const fd = fs.openSync(this.file, 'a')
        try { fs.writeSync(fd, this.unwritten.map((ev) => JSON.stringify(ev)).join('\n') + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      }
      this.unwritten = []
      this.rewrite = false
    } catch (err) {
      this.log(`presence: could not save the queue: ${err.message}`)
    }
  }

  /** Sends now unless a failure's backoff hasn't run out. */
  async tick () {
    if (this.now() < this.retryAt) return false
    return this.flush()
  }

  /**
   * Sends everything queued, oldest first, in requests of at most 500. Resolves true
   * when the queue is empty, false after a failure (the events stay for the retry).
   */
  flush () {
    if (!this.sending) this.sending = this.send().finally(() => { this.sending = null })
    return this.sending
  }

  async send () {
    let sent = false
    try {
      while (this.queue.length) {
        const chunk = this.queue.slice(0, this.batch)
        const res = await this.fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
          body: JSON.stringify({ events: chunk.map((x) => x.ev) }),
          signal: AbortSignal.timeout(this.timeoutMs)
        })
        if (!res.ok) throw new Error(`the accounts API answered ${res.status}`)
        // By sequence number: the queue may have dropped its oldest while this was in flight.
        const last = chunk[chunk.length - 1].seq
        const i = this.queue.findIndex((x) => x.seq > last)
        this.queue = i < 0 ? [] : this.queue.slice(i)
        sent = true
      }
      this.failures = 0
      this.retryAt = 0
      return true
    } catch (err) {
      this.failures++
      const wait = Math.min(this.flushMs * 2 ** (this.failures - 1), this.maxBackoffMs)
      this.retryAt = this.now() + wait
      this.log(`presence: could not report to the accounts API (${err.cause?.code || err.message}); trying again in ${Math.round(wait / 1000)} s`)
      return false
    } finally {
      if (sent) { this.rewrite = true; this.persist() }
    }
  }

  /** On shutdown: ends every open visit, stops the timers, saves the queue, and tries one last send (for at most 5 s). */
  async close () {
    if (this.closed) return
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.endAll()
    this.persist()
    this.closed = true
    let timer
    await Promise.race([this.flush(), new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS) })])
    clearTimeout(timer)
    this.persist()
  }
}
