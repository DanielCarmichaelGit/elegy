// What an issue report looks like, and how two reports of the same problem end up
// in one issue: shared by the /v1/issues route, the API's own error recording and
// both stores, so the memory store (the tested reference) and Postgres agree.
import crypto from 'node:crypto'
import { HttpError, UUID, stripInvisible } from './http.js'

export const SURFACES = ['app', 'api', 'web']
export const KINDS = ['action', 'error', 'http404', 'crash']
export const OUTCOMES = ['ok', 'slow', 'error']
export const MAX_BATCH = 20
const DAY = 24 * 60 * 60 * 1000
const MAX_CONTEXT_KEYS = 16
const MAX_CONTEXT_BYTES = 2048

const cut = (value, max) => stripInvisible(value).slice(0, max).join('').trim()

/** A message with the parts that differ between repeats of one problem replaced. */
export function normalizeMessage (message) {
  return String(message ?? '').toLowerCase()
    .replace(/(["'`])(?:(?!\1).){1,500}\1/g, '<str>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<hex>')
    .replace(/(?:~|[a-z]:\\|\/)[^\s'"`:,()]*[\\/][^\s'"`:,()]*/g, '<path>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** The same problem on the same surface, kind and name always gets this fingerprint. */
export function fingerprint ({ surface, kind, name, message }) {
  return crypto.createHash('sha256').update([surface, kind, name, normalizeMessage(message)].join('|')).digest('hex')
}

/** Context is a few flat facts (which editor, which route): scalars only, bounded. Never throws. */
export function cleanContext (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_CONTEXT_KEYS) break
    const key = cut(k, 40)
    if (!key) continue
    if (typeof v === 'string') out[key] = cut(v, 200)
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
    else if (typeof v === 'boolean') out[key] = v
  }
  // Still too big (16 long strings): drop fields from the end until it fits.
  while (JSON.stringify(out).length > MAX_CONTEXT_BYTES) delete out[Object.keys(out).pop()]
  return out
}

const oneOf = (list, value, what) => {
  const v = String(value ?? '')
  if (!list.includes(v)) throw new HttpError(400, `${what} must be one of ${list.join(', ')}`)
  return v
}
// Postgres's `integer` column can't hold more than this; a value outside it would turn a
// whole batch into a 500 (22003). Clamping to null here keeps a bad report a 400, never a crash.
const INT_MAX = 2_147_483_647
const intOrNull = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const n = Math.round(v)
  return n >= 0 && n <= INT_MAX ? n : null
}

/**
 * One event as the stores take it. `surface`, `appVersion`, `platform`, `userId` and
 * `deviceId` are decided by the caller (the route knows who is reporting), never by the body.
 */
export function cleanEvent (raw, { surface, appVersion = '', platform = '', userId = null, deviceId = null, now = Date.now }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'each event must be an object')
  const kind = oneOf(KINDS, raw.kind, 'kind')
  const outcome = oneOf(OUTCOMES, raw.outcome ?? 'ok', 'outcome')
  const name = cut(raw.name, 80)
  if (!name) throw new HttpError(400, 'name is empty')
  const t = now()
  const at = typeof raw.occurredAt === 'number' ? raw.occurredAt : Date.parse(raw.occurredAt)
  const occurredAt = Number.isFinite(at) ? Math.min(Math.max(at, t - DAY), t + DAY) : t
  const message = cut(raw.message, 500)
  const e = {
    surface: oneOf(SURFACES, surface, 'surface'),
    kind, name, outcome,
    status: intOrNull(raw.status),
    durationMs: intOrNull(raw.durationMs),
    message,
    appVersion: cut(appVersion, 40),
    platform: cut(platform, 40),
    userId: userId ? String(userId) : null,
    deviceId: deviceId ? String(deviceId) : null,
    context: cleanContext(raw.context),
    occurredAt,
    fingerprint: null
  }
  if (outcome !== 'ok') e.fingerprint = fingerprint(e)
  return e
}

/** "GET /v1/orgs/:slug/members": a request's path with the parts that vary replaced, so requests group. */
export function routeName (method, pathname) {
  const segs = String(pathname || '/').split('/')
  const parts = segs.map((p, i) => {
    if (UUID.test(p)) return ':id'
    if (/^[A-Za-z0-9_-]{24,64}$/.test(p)) return ':token'
    if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(p)) return ':code'
    // The slug right after /orgs/ varies per org, same as an id would; group them too.
    if (segs[i - 1] === 'orgs') return ':slug'
    return p
  })
  return `${method} ${parts.join('/')}`.slice(0, 80)
}
