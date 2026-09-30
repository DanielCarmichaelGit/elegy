'use client'
// Client-side (not a server action) so Supabase's per-IP sign-up rate limit
// sees each visitor's own IP rather than Netlify's shared one.
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client.js'
import { isValidEmail, isValidPassword } from '@/lib/validate.js'
import { safeNext } from '@/lib/safe-next.js'
import { signUpData } from '@/lib/signup.js'

const ERRORS = {
  name: 'Enter your name.',
  org: 'Enter your org’s name (up to 80 characters).',
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
  const [kind, setKind] = useState('me')

  async function onSubmit (e) {
    e.preventDefault()
    const form = e.currentTarget
    const name = form.name.value.trim().slice(0, 60)
    const email = form.email.value.trim()
    const password = form.password.value
    if (!name) { setError('name'); return }
    const data = signUpData({ name, kind, orgName: kind === 'team' ? form.org.value : '' })
    if (!data) { setError('org'); return }
    if (!isValidEmail(email)) { setError('email'); return }
    if (!isValidPassword(password)) { setError('password'); return }
    setError(null)
    setBusy(true)
    const { data: res, error: err } = await createClient().auth.signUp({
      email,
      password,
      options: { data, emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(safeNext(next))}` }
    })
    setBusy(false)
    if (err) { setError(err.code === 'user_already_exists' ? 'taken' : err.code === 'weak_password' ? 'weak_password' : 'generic'); return }
    // Supabase doesn't return a clean "already registered" error: a repeat signup
    // comes back as a user with no identities instead.
    if (res.user && (res.user.identities || []).length === 0) { setError('taken'); return }
    if (res.session) { window.location.assign(safeNext(next)); return }
    setSent(true)
  }

  if (sent) {
    return (
      <p className='notice'>
        Check your email to confirm your account.{kind === 'team' ? ' Your org is set up the first time you open your dashboard.' : ''}
      </p>
    )
  }

  return (
    <form onSubmit={onSubmit} className='stack'>
      <fieldset className='choice'>
        <legend>Who’s it for?</legend>
        <label><input type='radio' name='kind' value='me' checked={kind === 'me'} onChange={() => setKind('me')} /> Just me</label>
        <label><input type='radio' name='kind' value='team' checked={kind === 'team'} onChange={() => setKind('team')} /> A team</label>
      </fieldset>
      {kind === 'team' && (
        <div className='field'>
          <label htmlFor='org'>Org name</label>
          <input className='input' id='org' name='org' maxLength={80} required placeholder='e.g. Acme' />
        </div>)}
      <div className='field'>
        <label htmlFor='name'>Your name</label>
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
