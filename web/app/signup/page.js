import AuthLayout from '@/components/AuthLayout.js'
import SignUpForm from './SignUpForm.js'
import { safeNext } from '@/lib/safe-next.js'

export const metadata = { title: 'Create account' }

export default async function SignUp ({ searchParams }) {
  const q = await searchParams
  const next = safeNext(q.next)
  return (
    <AuthLayout caption='Start building together in a minute.'>
      <div className='card stack'>
        <h2>Create your account</h2>
        <SignUpForm next={next} />
        <p className='muted'>Already have an account? <a href={`/signin?next=${encodeURIComponent(next)}`}>Sign in</a></p>
      </div>
    </AuthLayout>
  )
}
