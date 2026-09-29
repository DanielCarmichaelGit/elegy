import Header from '@/components/Header.js'
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
    <>
      <Header />
      <main className='wrap page' style={{ maxWidth: 420 }}>
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
                <PasswordSignInForm next={next} />
                <p className='row' style={{ justifyContent: 'space-between' }}>
                  <a className='muted' href={`/forgot?next=${encodeURIComponent(next)}`}>Forgot password?</a>
                  <a className='muted' href={`/signup?next=${encodeURIComponent(next)}`}>New to Quilt? Create an account</a>
                </p>
                <details>
                  <summary className='muted'>Or email me a sign-in link</summary>
                  <form action={emailLink} className='stack' style={{ marginTop: 12 }}>
                    <input type='hidden' name='next' value={next} />
                    <div className='field'>
                      <label htmlFor='link-email'>Email</label>
                      <input className='input' id='link-email' name='email' type='email' autoComplete='email' required />
                    </div>
                    <button className='btn'>Email me a sign-in link</button>
                  </form>
                </details>
              </>)}
          {q.error && <p className='notice bad'>{ERRORS[q.error] || 'Something went wrong.'}</p>}
        </div>
      </main>
    </>
  )
}
