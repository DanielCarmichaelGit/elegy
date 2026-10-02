// src/report.js
// Tells Quilt what went wrong in the app (and how long actions took) so problems can be
// found without anyone filing them. Batches reports to the accounts API, scrubs anything
// personal first, and never gets in the way: it drops rather than retries, and never throws.
import { apiUrl } from './account.js'
import { currentVersion } from './releases.js'

// A path on this computer says who you are and how your disk is laid out; its last part
// (the project folder, the app) is all a report needs.
const PATH = /(?:~|[A-Za-z]:\\|\/(?:Users|home|private|tmp|var|opt|Applications|Volumes|root|mnt))(?:[^\s'"`:,()]|\s(?=[^\s'"`:,()]*[\\/]))*/g
const TOKEN = /\b(?:qd|qa|qr|dc)_[A-Za-z0-9_-]+/g
const INVITE = /(?:https?:\/\/join\.heyquilt\.com\/[^\s'"`]+|quilt:\/\/[^\s'"`]+)/g

/** `text` with paths cut to their last part, and tokens and invite links hidden. */
export function scrub (text) {
  return String(text ?? '')
    .replace(INVITE, '[invite]')
    .replace(TOKEN, '[secret]')
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

  function record (event) {
    try {
      if (!enabled()) return
      const { kind, name, outcome = 'ok', status, durationMs, message = '', context = {} } = event || {}
      waiting.push({ kind, name: String(name || '').slice(0, 80), outcome, status, durationMs, message: scrub(message).slice(0, 500), context: scrubContext(context), occurredAt: now() })
      if (waiting.length > maxWaiting) waiting.splice(0, waiting.length - maxWaiting)
      if (waiting.length >= batchSize) send()
      else schedule()
    } catch {}
  }

  function schedule () {
    if (timer || !waiting.length) return
    const delay = Math.max(delayMs, pausedUntil - now())
    timer = setTimer(() => { timer = null; send() }, delay)
  }

  function send () {
    if (inflight || !waiting.length) return
    if (now() < pausedUntil) return schedule()
    if (timer) { clearTimer(timer); timer = null }
    const events = waiting.splice(0, batchSize)
    const t = token()
    inflight = Promise.resolve().then(() => fetch(`${api}/v1/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
      body: JSON.stringify({ surface: 'app', appVersion: version, platform, events })
    })).then((res) => {
      if (!res || !res.ok) throw new Error(`Quilt answered ${res && res.status}`)
    }).catch((err) => {
      // Dropped, not retried: a report is never worth a retry storm. One quiet line.
      pausedUntil = now() + backoffMs
      log(`issue report not sent: ${err?.message || err}`)
    }).finally(() => {
      inflight = null
      if (waiting.length) schedule()
    })
    return inflight
  }

  /** Sends what is waiting now; gives up after `timeoutMs` so shutdown never hangs on it. */
  async function flush ({ timeoutMs = 2000 } = {}) {
    if (!waiting.length && !inflight) return
    const work = (inflight || Promise.resolve()).then(() => { pausedUntil = 0; return send() })
    await Promise.race([work, new Promise((res) => setTimeout(res, timeoutMs))]).catch(() => {})
  }

  return { record, flush, close: () => flush(), waiting: () => waiting.length }
}
