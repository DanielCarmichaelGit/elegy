'use client'
// Runs in the browser (not a server action) so Supabase's per-IP rate limiting
// sees each visitor's own IP instead of Netlify's, and one bad actor can't
// exhaust the shared limit for everyone signing in.
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client.js'
import { isValidEmail } from '@/lib/validate.js'
import { safeNext } from '@/lib/safe-next.js'

const ERRORS = {
  email: 'That email doesn’t look right.',
  email_not_confirmed: 'Confirm your email first: check your inbox.',
  generic: 'Wrong email or password.'
}

export default function PasswordSignInForm ({ next }) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit (e) {
    e.preventDefault()
    const email = e.currentTarget.email.value.trim()
    const password = e.currentTarget.password.value
    if (!isValidEmail(email)) { setError('email'); return }
    setError(null)
    setBusy(true)
    const { error: err } = await createClient().auth.signInWithPassword({ email, password })
    setBusy(false)
    if (err) { setError(err.code === 'email_not_confirmed' ? 'email_not_confirmed' : 'generic'); return }
    // Full navigation, not client-side routing, so the server sees the cookies Supabase just set.
    window.location.assign(safeNext(next))
  }

  return (
    <form onSubmit={onSubmit} className='stack'>
      <div className='field'>
        <label htmlFor='email'>Email</label>
        <input className='input' id='email' name='email' type='email' autoComplete='email' required />
      </div>
      <div className='field'>
        <label htmlFor='password'>Password</label>
        <input className='input' id='password' name='password' type='password' autoComplete='current-password' required />
      </div>
      <button className='btn primary' disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      {error && <p className='notice bad'>{ERRORS[error] || ERRORS.generic}</p>}
    </form>
  )
}
