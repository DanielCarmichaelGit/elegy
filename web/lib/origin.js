import 'server-only'
import { headers } from 'next/headers'

// Not a 'use server' file: exporting a plain async function from one turns it
// into a callable server action endpoint, which this has no reason to be.
export async function origin () {
  if (process.env.QUILT_SITE_URL) return process.env.QUILT_SITE_URL
  if (process.env.NODE_ENV === 'production') throw new Error('QUILT_SITE_URL must be set in production — the request Host header is attacker-controlled.')
  // Local dev only: no fixed site URL yet, so fall back to whatever host served the request.
  const h = await headers()
  return `${h.get('x-forwarded-proto') || 'https'}://${h.get('host')}`
}
