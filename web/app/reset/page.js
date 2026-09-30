import AuthLayout from '@/components/AuthLayout.js'
import { requireUser } from '@/lib/session.js'
import { updatePassword } from './actions.js'

export const metadata = { title: 'Set a new password' }
const ERRORS = { password: 'Password must be 8–72 characters.', match: 'Passwords don’t match.', same_password: 'That’s your current password. Pick a new one.', weak_password: 'Choose a stronger password: longer, or mix in numbers and symbols.', generic: 'Something went wrong. Try again.' }

export default async function Reset ({ searchParams }) {
  const q = await searchParams
  await requireUser('/reset')
  return (
    <AuthLayout caption='Set a new password to keep building.'>
      <div className='card stack'>
        <h2>Set a new password</h2>
        <form action={updatePassword} className='stack'>
          <div className='field'>
            <label htmlFor='password'>New password</label>
            <input className='input' id='password' name='password' type='password' autoComplete='new-password' minLength={8} maxLength={72} required />
          </div>
          <div className='field'>
            <label htmlFor='confirm'>Confirm password</label>
            <input className='input' id='confirm' name='confirm' type='password' autoComplete='new-password' minLength={8} maxLength={72} required />
          </div>
          <button className='btn primary'>Update password</button>
        </form>
        {q.error && <p className='notice bad'>{ERRORS[q.error] || 'Something went wrong.'}</p>}
      </div>
    </AuthLayout>
  )
}
