import Header from '@/components/Header.js'
import { requestReset } from './actions.js'
import { safeNext } from '@/lib/safe-next.js'

export const metadata = { title: 'Reset password' }

export default async function Forgot ({ searchParams }) {
  const q = await searchParams
  const next = safeNext(q.next)
  return (
    <>
      <Header />
      <main className='wrap page' style={{ maxWidth: 420 }}>
        <div className='card stack'>
          <h2>Reset your password</h2>
          {q.sent
            ? <p className='notice'>If that email has an account, we sent a link to reset your password.</p>
            : (
              <form action={requestReset} className='stack'>
                <input type='hidden' name='next' value={next} />
                <div className='field'>
                  <label htmlFor='email'>Email</label>
                  <input className='input' id='email' name='email' type='email' autoComplete='email' required />
                </div>
                <button className='btn primary'>Send reset link</button>
              </form>)}
          <p className='muted'><a href={`/signin?next=${encodeURIComponent(next)}`}>Back to sign in</a></p>
        </div>
      </main>
    </>
  )
}
