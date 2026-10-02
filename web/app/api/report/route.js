// The browser's way to report a 404 or a crashed page: a small body, forwarded to the
// accounts API with the website's key. Always 204, whatever happened.
import { report, cleanPath, uaFamily } from '@/lib/report.js'
import { currentUser } from '@/lib/session.js'

const KINDS = ['http404', 'error']
const MAX_BODY = 4096

export async function POST (request) {
  try {
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
