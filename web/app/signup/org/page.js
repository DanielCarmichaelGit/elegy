import AuthLayout from '@/components/AuthLayout.js'
import SignUpOrgForm from './SignUpOrgForm.js'
import { safeNext } from '@/lib/safe-next.js'

export const metadata = { title: 'Create an org account' }

export default async function SignUpOrg ({ searchParams }) {
  const q = await searchParams
  const next = safeNext(q.next)
  return (
    <AuthLayout caption='Bring your team and your agents into one place.'>
      <div className='card stack'>
        <h2>Create your org account</h2>
        <p className='muted'>A shared space for your team. You will be its owner and can invite people once it is made.</p>
        <SignUpOrgForm next={next} />
        <p className='muted'>Setting up just for you? <a href={`/signup?next=${encodeURIComponent(next)}`}>Create a personal account</a></p>
      </div>
    </AuthLayout>
  )
}
