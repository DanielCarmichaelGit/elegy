// Tells the accounts API what went wrong on the website (a 404, a page that crashed, a
// failed call to the API), so it lands with the app's and the API's own reports. Server-side
// only: the report key never reaches the browser. Never throws, never retries.
import 'server-only'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** Segments that are a secret, not a route shape: Quilt's own tokens, a long opaque id, a
 * uuid, or a device-link XXXX-XXXX code. Same grouping `nameOf` (lib/api.js) uses. */
function scrubSegments (p) {
  return p
    .replace(/\/(?:qi|qj|qd|qa|qr|dc)_[A-Za-z0-9_-]*(?=\/|$)/g, '/:token')
    .replace(UUID, ':id')
    .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, '/:token')
    .replace(/\/[A-Z0-9]{4}-[A-Z0-9]{4}(?=\/|$)/g, '/:code')
}

/** Only the path of a URL or pathname: no query, no fragment (invite links keep secrets
 * there), and with any token, id or link code in it replaced, since the path itself can
 * be the secret (an invite link's token lives in the path, not the query). */
export function cleanPath (value) {
  if (typeof value !== 'string' || !value) return '/'
  let p = value
  try { p = new URL(value, 'https://x').pathname } catch { p = value.split(/[?#]/)[0] }
  return (scrubSegments(p || '/') || '/').slice(0, 200)
}

/** The browser family, which is all a report needs to know about the visitor's software. */
export function uaFamily (ua = '') {
  if (/Edg\//.test(ua)) return 'edge'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Chrome\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua)) return 'safari'
  return 'other'
}

export async function report ({ kind, name, outcome = 'error', status, durationMs, message = '', userId = null, platform = '' }, { fetchImpl = fetch } = {}) {
  const key = process.env.QUILT_REPORT_KEY
  const api = process.env.QUILT_API_URL
  if (!key || !api) return
  try {
    await fetchImpl(`${api}/v1/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-quilt-report-key': key },
      body: JSON.stringify({ surface: 'web', appVersion: process.env.NEXT_PUBLIC_SITE_VERSION || '', platform, userId, events: [{ kind, name, outcome, status, durationMs, message: String(message || '').slice(0, 500) }] }),
      cache: 'no-store',
      signal: AbortSignal.timeout(1500)
    })
  } catch {}
}
