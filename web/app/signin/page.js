import Header from '@/components/Header.js'
import { emailLink, provider } from './actions.js'
import { safeNext } from '@/lib/session.js'

export const metadata = { title: 'Sign in' }
const LABELS = { google: 'Continue with Google', github: 'Continue with GitHub' }
const ERRORS = { email: 'That email doesn’t look right.', send: 'We couldn’t send the link. Try again in a minute.', provider: 'That sign-in option isn’t available.', link: 'That sign-in link expired or was already used. Send a new one.' }

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
            ? <p className='notice'>Check your email for a sign-in link.</p>
            : (
              <>
                {providers.map((p) => (
                  <form key={p} action={provider}>
                    <input type='hidden' name='provider' value={p} />
                    <input type='hidden' name='next' value={next} />
                    <button className='btn' style={{ width: '100%' }}>{LABELS[p]}</button>
                  </form>
                ))}
                <form action={emailLink} className='stack'>
                  <input type='hidden' name='next' value={next} />
                  <div className='field'>
                    <label htmlFor='email'>Email</label>
                    <input className='input' id='email' name='email' type='email' autoComplete='email' required />
                  </div>
                  <button className='btn primary'>Email me a sign-in link</button>
                </form>
              </>)}
          {q.error && <p className='notice bad'>{ERRORS[q.error] || 'Something went wrong.'}</p>}
        </div>
      </main>
    </>
  )
}
