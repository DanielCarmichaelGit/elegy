'use server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server.js'
import { safeNext } from '@/lib/safe-next.js'

async function origin () {
  if (process.env.QUILT_SITE_URL) return process.env.QUILT_SITE_URL
  if (process.env.NODE_ENV === 'production') throw new Error('QUILT_SITE_URL must be set in production — the request Host header is attacker-controlled.')
  // Local dev only: no fixed site URL yet, so fall back to whatever host served the request.
  const h = await headers()
  return `${h.get('x-forwarded-proto') || 'https'}://${h.get('host')}`
}

export async function emailLink (formData) {
  const email = String(formData.get('email') || '').trim()
  const next = safeNext(formData.get('next'))
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) redirect(`/signin?next=${encodeURIComponent(next)}&error=email`)
  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${await origin()}/auth/callback?next=${encodeURIComponent(next)}` } })
  redirect(`/signin?next=${encodeURIComponent(next)}&${error ? 'error=send' : 'sent=1'}`)
}

export async function provider (formData) {
  const name = String(formData.get('provider'))
  const allowed = (process.env.NEXT_PUBLIC_AUTH_PROVIDERS || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!allowed.includes(name)) redirect('/signin?error=provider')
  const next = safeNext(formData.get('next'))
  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithOAuth({ provider: name, options: { redirectTo: `${await origin()}/auth/callback?next=${encodeURIComponent(next)}` } })
  redirect(error ? '/signin?error=provider' : data.url)
}
