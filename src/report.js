// src/report.js
// Tells Quilt what went wrong in the app (and how long actions took) so problems can be
// found without anyone filing them. Batches reports to the accounts API, scrubs anything
// personal first, and never gets in the way: it drops rather than retries, and never throws.
import { apiUrl } from './account.js'
import { currentVersion } from './releases.js'

// A path on this computer says who you are and how your disk is laid out; its last part
// (the project folder, the app) is all a report needs. A directory segment may be a few
// space-joined words of its own ("Program Files (x86)"), so each segment allows up to four.
const PATH = /(?:~|[A-Za-z]:|\/(?:Users|home|private|tmp|var|opt|Applications|Volumes|root|mnt))(?:[\\/][^\s'"`:,\\/]+(?: [^\s'"`:,\\/]+){0,3})*/g
const TOKEN = /\b(?:qd|qa|qr|dc)_[A-Za-z0-9_-]+/g
const INVITE = /(?:https?:\/\/join\.heyquilt\.com\/[^\s'"`]+|quilt:\/\/[^\s'"`]+)/g

/** `text` with paths cut to their last part, and tokens and invite links hidden. */
export function scrub (text) {
  return String(text ?? '')
    .replace(INVITE, '[invite]')
    .replace(TOKEN, '[secret]')
    // PATH can absorb a few words of trailing prose past the path's last separator (nothing
    // stops it there) — that's harmless: .pop() returns whatever follows the last separator
    // verbatim, spaces and all, so absorbed prose comes back unchanged. The safety invariant
    // lives here, in the replacement, not in how precisely the regex draws the line.
    .replace(PATH, (m) => m.split(/[\\/]/).filter(Boolean).pop() || '[path]')
}

const scrubContext = (c) => Object.fromEntries(Object.entries(c && typeof c === 'object' ? c : {}).map(([k, v]) => [k, typeof v === 'string' ? scrub(v) : v]))

export function createReporter ({
  token = () => null, enabled = () => true, fetch = globalThis.fetch, api = apiUrl(), version = currentVersion(), platform = process.platform,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  batchSize = 20, delayMs = 10_000, maxWaiting = 50, backoffMs = 60_000, log = () => {}
} = {}) {
  let waiting = []
  let timer = null
  let pausedUntil = 0
  let inflight = null
  let closed = false

  function record (event) {
    try {
      if (closed || !enabled()) return
      const { kind, name, outcome = 'ok', status, durationMs, message = '', context = {} } = event || {}
      waiting.push({ kind, name: String(name || '').slice(0, 80), outcome, status, durationMs, message: scrub(message).slice(0, 500), context: scrubContext(context), occurredAt: now() })
      if (waiting.length > maxWaiting) waiting.splice(0, waiting.length - maxWaiting)
      if (waiting.length >= batchSize) send()
      else schedule()
    } catch {}
  }

  function schedule () {
    if (closed || timer || !waiting.length) return
    const delay = Math.max(delayMs, pausedUntil - now())
    timer = setTimer(() => { timer = null; send() }, delay)
  }

  // Dropped, not retried: a report is never worth a retry storm. One quiet line.
  function fail (err) {
    pausedUntil = now() + backoffMs
    log(`issue report not sent: ${err?.message || err}`)
  }

  function send () {
    if (inflight || !waiting.length) return
    if (now() < pausedUntil) return schedule()
    if (timer) { clearTimer(timer); timer = null }
    const events = waiting.splice(0, batchSize)
    try {
      const t = token()
      inflight = Promise.resolve().then(() => fetch(`${api}/v1/issues`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
        body: JSON.stringify({ surface: 'app', appVersion: version, platform, events })
      })).then((res) => {
        if (!res || !res.ok) throw new Error(`Quilt answered ${res && res.status}`)
      }).catch(fail).finally(() => {
        inflight = null
        if (waiting.length) schedule()
      })
      return inflight
    } catch (err) {
      // token() (or anything else synchronous above) threw before any request went out:
      // the batch taken off `waiting` is still dropped, same as a failed send.
      fail(err)
      if (waiting.length) schedule()
    }
  }

  /**
   * Sends what is waiting now, batch after batch, until nothing is left or `timeoutMs` runs
   * out. If a send has nothing to wait on — paused by backoff, or nothing left to send — it
   * stops right there rather than spin: at shutdown a failed batch is dropped, not retried,
   * same as any other time.
   */
  async function flush ({ timeoutMs = 2000 } = {}) {
    const deadline = Date.now() + timeoutMs
    pausedUntil = 0
    while ((waiting.length || inflight) && Date.now() < deadline) {
      const step = inflight || send()
      if (!step) break
      let timeoutId
      const timeout = new Promise((res) => { timeoutId = setTimeout(res, Math.max(0, deadline - Date.now())) })
      await Promise.race([step, timeout]).catch(() => {})
      clearTimeout(timeoutId)
    }
  }

  /** Stops any future scheduling and flushes what is left, so shutdown never leaves a timer armed. */
  function close () {
    closed = true
    if (timer) { clearTimer(timer); timer = null }
    return flush()
  }

  return { record, flush, close, waiting: () => waiting.length }
}
