import AuthLayout from '@/components/AuthLayout.js'
import ForgotForm from './ForgotForm.js'
import { safeNext } from '@/lib/safe-next.js'

export const metadata = { title: 'Reset password' }

export default async function Forgot ({ searchParams }) {
  const q = await searchParams
  const next = safeNext(q.next)
  return (
    <AuthLayout caption="We'll get you back in.">
      <div className='card stack'>
        <h2>Reset your password</h2>
        <ForgotForm />
        <p className='muted'><a href={`/signin?next=${encodeURIComponent(next)}`}>Back to sign in</a></p>
      </div>
    </AuthLayout>
  )
}
