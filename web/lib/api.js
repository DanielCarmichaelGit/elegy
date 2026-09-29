import 'server-only'

// Calls the Quilt accounts API as the signed-in person (server-side only: the API
// address and the person's token never need to reach the browser for this).
export async function apiCall (user, method, path, body) {
  // Missing config must fail loudly in production rather than silently calling "undefined/v1/..."
  if (!process.env.QUILT_API_URL && process.env.NODE_ENV === 'production') {
    throw new Error('QUILT_API_URL is not set')
  }
  try {
    const res = await fetch(process.env.QUILT_API_URL + path, {
      method,
      headers: { authorization: `Bearer ${user.accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    })
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) }
  } catch {
    return { ok: false, status: 0, data: null }
  }
}
