'use client'
// Client-side (not a server action) so Supabase's per-IP sign-up rate limit
// sees each visitor's own IP rather than Netlify's shared one.
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client.js'
import { isValidEmail, isValidPassword } from '@/lib/validate.js'
import { safeNext } from '@/lib/safe-next.js'

const ERRORS = {
  name: 'Enter your name.',
  email: 'That email doesn’t look right.',
  password: 'Password must be 8–72 characters.',
  weak_password: 'Choose a stronger password: longer, or mix in numbers and symbols.',
  taken: 'That email already has an account. Sign in instead.',
  generic: 'Something went wrong. Try again.'
}

export default function SignUpForm ({ next }) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  async function onSubmit (e) {
    e.preventDefault()
    const name = e.currentTarget.name.value.trim().slice(0, 60)
    const email = e.currentTarget.email.value.trim()
    const password = e.currentTarget.password.value
    if (!name) { setError('name'); return }
    if (!isValidEmail(email)) { setError('email'); return }
    if (!isValidPassword(password)) { setError('password'); return }
    setError(null)
    setBusy(true)
    const { data, error: err } = await createClient().auth.signUp({
      email,
      password,
      options: { data: { name }, emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(safeNext(next))}` }
    })
    setBusy(false)
    if (err) { setError(err.code === 'user_already_exists' ? 'taken' : err.code === 'weak_password' ? 'weak_password' : 'generic'); return }
    // Supabase doesn't return a clean "already registered" error: a repeat signup
    // comes back as a user with no identities instead.
    if (data.user && (data.user.identities || []).length === 0) { setError('taken'); return }
    if (data.session) { window.location.assign(safeNext(next)); return }
    setSent(true)
  }

  if (sent) return <p className='notice'>Check your email to confirm your account.</p>

  return (
    <form onSubmit={onSubmit} className='stack'>
      <div className='field'>
        <label htmlFor='name'>Name</label>
        <input className='input' id='name' name='name' autoComplete='name' maxLength={60} required />
      </div>
      <div className='field'>
        <label htmlFor='email'>Email</label>
        <input className='input' id='email' name='email' type='email' autoComplete='email' required />
      </div>
      <div className='field'>
        <label htmlFor='password'>Password</label>
        <input className='input' id='password' name='password' type='password' autoComplete='new-password' minLength={8} maxLength={72} required />
      </div>
      <button className='btn primary' disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      {error && <p className='notice bad'>{ERRORS[error] || ERRORS.generic}</p>}
    </form>
  )
}
