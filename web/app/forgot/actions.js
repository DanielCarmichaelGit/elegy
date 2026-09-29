'use server'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server.js'
import { safeNext } from '@/lib/safe-next.js'
import { isValidEmail } from '@/lib/validate.js'
import { origin } from '@/app/signin/actions.js'

export async function requestReset (formData) {
  const email = String(formData.get('email') || '').trim()
  const next = safeNext(formData.get('next'))
  // Don't reveal whether the email has an account either way — always land on the same notice.
  if (isValidEmail(email)) {
    const supabase = await createClient()
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${await origin()}/auth/callback?next=/reset` })
  }
  redirect(`/forgot?next=${encodeURIComponent(next)}&sent=1`)
}
