import Header from '@/components/Header.js'
import { signUp } from './actions.js'
import { safeNext } from '@/lib/safe-next.js'

export const metadata = { title: 'Create account' }
const ERRORS = { name: 'Enter your name.', email: 'That email doesn’t look right.', password: 'Password must be at least 8 characters.', taken: 'That email already has an account. Sign in instead.', generic: 'Something went wrong. Try again.' }

export default async function SignUp ({ searchParams }) {
  const q = await searchParams
  const next = safeNext(q.next)
  return (
    <>
      <Header />
      <main className='wrap page' style={{ maxWidth: 420 }}>
        <div className='card stack'>
          <h2>Create your account</h2>
          {q.sent
            ? <p className='notice'>Check your email to confirm your account.</p>
            : (
              <form action={signUp} className='stack'>
                <input type='hidden' name='next' value={next} />
                <div className='field'>
                  <label htmlFor='name'>Name</label>
                  <input className='input' id='name' name='name' autoComplete='name' required />
                </div>
                <div className='field'>
                  <label htmlFor='email'>Email</label>
                  <input className='input' id='email' name='email' type='email' autoComplete='email' required />
                </div>
                <div className='field'>
                  <label htmlFor='password'>Password</label>
                  <input className='input' id='password' name='password' type='password' autoComplete='new-password' minLength={8} required />
                </div>
                <button className='btn primary'>Create account</button>
              </form>)}
          {q.error && <p className='notice bad'>{ERRORS[q.error] || 'Something went wrong.'}</p>}
          <p className='muted'>Already have an account? <a href={`/signin?next=${encodeURIComponent(next)}`}>Sign in</a></p>
        </div>
      </main>
    </>
  )
}
