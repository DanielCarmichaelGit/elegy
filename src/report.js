// src/report.js
// Tells Quilt what went wrong in the app (and how long actions took) so problems can be
// found without anyone filing them. Batches reports to the accounts API, scrubs anything
// personal first, and never gets in the way: it drops rather than retries, and never throws.
import { apiUrl } from './account.js'
import { currentVersion } from './releases.js'

// A path on this computer says who you are and how your disk is laid out; its last part
// (the project folder, the app) is all a report needs. A directory segment may be a few
// space-joined words of its own ("Program Files (x86)"), so each segment allows up to four.
// A UNC path (\\server\share\...) is a root of its own kind, same treatment.
const PATH = /(?:~|[A-Za-z]:|\/(?:Users|home|private|tmp|var|opt|Applications|Volumes|root|mnt|srv|data|workspace)|\\\\[^\s\\]+)(?:[\\/][^\s'"`:,\\/]+(?: [^\s'"`:,\\/]+){0,3})*/g
// Every token prefix Quilt mints: qd_ (device), qa_/qr_ (agent access/refresh), dc_ (device
// code), qi_ (org invite), qj_ (agent join). No \b: `_` is a word character, so `\b` would miss
// a token straight after an underscore (`_qd_...`); instead, the character right before the
// prefix (if any) just has to not be alphanumeric, and that character is kept in the output.
const TOKEN = /(?:^|[^A-Za-z0-9])((?:qd|qa|qr|dc|qi|qj)_[A-Za-z0-9_-]+)/g
// join.heyquilt.com and quilt:// links; also the older/relay form of an invite link, any host,
// where the secret lives after a `#` on a `/join/...` path.
const INVITE = /(?:https?:\/\/join\.heyquilt\.com\/[^\s'"`]+|quilt:\/\/[^\s'"`]+|\/join\/[^\s#'"`]+#\S+)/g
// A username:password (or token) embedded in a URL, e.g. https://x-access-token:ghp_x@github.com/.
const CREDS = /:\/\/[^/\s:@]+:[^@\s]+@/g
// GitHub tokens (classic and fine-grained) and JWTs (a Bearer token, including Supabase's).
const SECRET = /\b(?:gh[pousr]_|github_pat_)\w+|eyJ[\w-]+\.[\w-]+\.[\w-]+/g

/** `text` with paths cut to their last part, and tokens, credentials and invite links hidden. */
export function scrub (text) {
  return String(text ?? '')
    .replace(INVITE, '[invite]')
    .replace(CREDS, '://[secret]@')
    .replace(SECRET, '[secret]')
    .replace(TOKEN, (m, token) => m.slice(0, m.length - token.length) + '[secret]')
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
