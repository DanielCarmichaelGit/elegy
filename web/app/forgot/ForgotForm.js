'use client'
// Client-side (not a server action) so Supabase's per-IP rate limit on this
// endpoint sees each visitor's own IP rather than Netlify's shared one.
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client.js'
import { isValidEmail } from '@/lib/validate.js'

export default function ForgotForm () {
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  async function onSubmit (e) {
    e.preventDefault()
    const email = e.currentTarget.email.value.trim()
    setBusy(true)
    // Don't reveal whether the email has an account either way: always land on the same notice.
    if (isValidEmail(email)) {
      await createClient().auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/auth/callback?next=/reset` })
    }
    setBusy(false)
    setSent(true)
  }

  if (sent) return <p className='notice'>If that email has an account, we sent a link to reset your password.</p>

  return (
    <form onSubmit={onSubmit} className='stack'>
      <div className='field'>
        <label htmlFor='email'>Email</label>
        <input className='input' id='email' name='email' type='email' autoComplete='email' required />
      </div>
      <button className='btn primary' disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
    </form>
  )
}
