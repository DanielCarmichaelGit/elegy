'use server'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server.js'
import { safeNext } from '@/lib/safe-next.js'
import { isValidEmail, isValidPassword } from '@/lib/validate.js'
import { origin } from '@/app/signin/actions.js'

export async function signUp (formData) {
  const name = String(formData.get('name') || '').trim()
  const email = String(formData.get('email') || '').trim()
  const password = String(formData.get('password') || '')
  const next = safeNext(formData.get('next'))
  const back = (error) => redirect(`/signup?next=${encodeURIComponent(next)}&error=${error}`)
  if (!name) back('name')
  if (!isValidEmail(email)) back('email')
  if (!isValidPassword(password)) back('password')
  const supabase = await createClient()
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name }, emailRedirectTo: `${await origin()}/auth/callback?next=${encodeURIComponent(next)}` }
  })
  // Supabase doesn't return a clean "already registered" error — a repeat signup
  // comes back as a user with no identities (or, on some configs, an outright error).
  if (error) back('generic')
  if (data.user && (data.user.identities || []).length === 0) back('taken')
  if (data.session) redirect(next)
  redirect(`/signup?next=${encodeURIComponent(next)}&sent=1`)
}
