import AuthLayout from '@/components/AuthLayout.js'
import { emailLink, provider } from './actions.js'
import PasswordSignInForm from './PasswordForm.js'
import { safeNext } from '@/lib/safe-next.js'

export const metadata = { title: 'Sign in' }
const LABELS = { google: 'Continue with Google', github: 'Continue with GitHub' }
const ERRORS = { email: 'That email doesn’t look right.', send: 'We couldn’t send the link. Try again in a minute.', provider: 'That sign-in option isn’t available.', link: 'That sign-in link expired, was already used, or was opened in a different browser. Send a new one from this browser.' }

export default async function SignIn ({ searchParams }) {
  const q = await searchParams
  const next = safeNext(q.next)
  const providers = (process.env.NEXT_PUBLIC_AUTH_PROVIDERS || '').split(',').map((s) => s.trim()).filter((p) => LABELS[p])
  return (
    <AuthLayout caption='Pick up right where you left off.'>
      <div className='card stack'>
        <h2>Sign in to Quilt</h2>
        {q.sent
          ? <p className='notice'>Check your email for a sign-in link. Open it on this device, in this browser.</p>
          : (
            <>
              {providers.map((p) => (
                <form key={p} action={provider}>
                  <input type='hidden' name='provider' value={p} />
                  <input type='hidden' name='next' value={next} />
                  <button className='btn' style={{ width: '100%' }}>{LABELS[p]}</button>
                </form>
              ))}
              {q.mode === 'link'
                ? (
                  <form action={emailLink} className='stack'>
                    <input type='hidden' name='next' value={next} />
                    <div className='field'>
                      <label htmlFor='link-email'>Email</label>
                      <input className='input' id='link-email' name='email' type='email' autoComplete='email' required />
                    </div>
                    <button className='btn primary'>Email me a sign-in link</button>
                  </form>)
                : <PasswordSignInForm next={next} />}
              <div className='auth-secondary'>
                {q.mode === 'link'
                  ? <a className='btn small' href={`/signin?next=${encodeURIComponent(next)}`}>Use a password instead</a>
                  : <a className='btn small' href={`/signin?mode=link&next=${encodeURIComponent(next)}`}>Email me a sign-in link instead</a>}
                <p className='row' style={{ justifyContent: 'space-between' }}>
                  <a className='muted' href={`/forgot?next=${encodeURIComponent(next)}`}>Forgot password?</a>
                  <a className='muted' href={`/signup?next=${encodeURIComponent(next)}`}>New to Quilt? Create an account</a>
                </p>
              </div>
            </>)}
        {q.error && <p className='notice bad'>{ERRORS[q.error] || 'Something went wrong.'}</p>}
      </div>
    </AuthLayout>
  )
}
