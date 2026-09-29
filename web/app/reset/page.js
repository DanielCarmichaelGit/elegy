import Header from '@/components/Header.js'
import { requireUser } from '@/lib/session.js'
import { updatePassword } from './actions.js'

export const metadata = { title: 'Set a new password' }
const ERRORS = { password: 'Password must be at least 8 characters.', match: 'Passwords don’t match.', generic: 'Something went wrong. Try again.' }

export default async function Reset ({ searchParams }) {
  const q = await searchParams
  await requireUser('/reset')
  return (
    <>
      <Header signedIn />
      <main className='wrap page' style={{ maxWidth: 420 }}>
        <div className='card stack'>
          <h2>Set a new password</h2>
          <form action={updatePassword} className='stack'>
            <div className='field'>
              <label htmlFor='password'>New password</label>
              <input className='input' id='password' name='password' type='password' autoComplete='new-password' minLength={8} required />
            </div>
            <div className='field'>
              <label htmlFor='confirm'>Confirm password</label>
              <input className='input' id='confirm' name='confirm' type='password' autoComplete='new-password' minLength={8} required />
            </div>
            <button className='btn primary'>Update password</button>
          </form>
          {q.error && <p className='notice bad'>{ERRORS[q.error] || 'Something went wrong.'}</p>}
        </div>
      </main>
    </>
  )
}
