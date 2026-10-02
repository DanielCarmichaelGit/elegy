// The browser's way to report a 404 or a crashed page: a small body, forwarded to the
// accounts API with the website's key. Always 204, whatever happened.
// This route is reachable by anyone, signed in or not, so it also has to defend itself:
// a content-length check before reading the body, and a per-IP limiter before forwarding.
import { report, cleanPath, uaFamily } from '@/lib/report.js'
import { currentUser } from '@/lib/session.js'

const KINDS = ['http404', 'error']
const MAX_BODY = 4096
const LIMIT = 10
const WINDOW_MS = 60_000
const MAX_KEYS = 10_000
// Module-level: one limiter per running instance, good enough to blunt a single
// fast caller (Netlify fronts every request with its own client IP header).
const hits = new Map()
function overLimit (key) {
  const now = Date.now()
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS)
  const over = recent.length >= LIMIT
  if (!over) hits.set(key, [...recent, now])
  // Keep the map bounded: forget keys with nothing left in the window.
  if (hits.size > MAX_KEYS) for (const [k, ts] of hits) if (ts.every((t) => now - t >= WINDOW_MS)) hits.delete(k)
  return over
}

export async function POST (request) {
  try {
    const len = Number(request.headers.get('content-length') || 0)
    if (len > MAX_BODY) return new Response(null, { status: 204 })
    const key = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    if (overLimit(key)) return new Response(null, { status: 204 })
    const text = await request.text()
    if (text.length > MAX_BODY) return new Response(null, { status: 204 })
    const body = JSON.parse(text)
    if (!body || typeof body !== 'object' || !KINDS.includes(body.kind)) return new Response(null, { status: 204 })
    let userId = null
    try { userId = (await currentUser())?.id || null } catch {}
    await report({
      kind: body.kind,
      name: cleanPath(body.name),
      status: body.kind === 'http404' ? 404 : undefined,
      message: typeof body.message === 'string' ? body.message : '',
      userId,
      platform: uaFamily(request.headers.get('user-agent') || '')
    })
  } catch {}
  return new Response(null, { status: 204 })
}
