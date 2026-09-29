'use server'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server.js'
import { safeNext } from '@/lib/safe-next.js'
import { origin } from '@/lib/origin.js'

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
