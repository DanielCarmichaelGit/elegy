import Header from '@/components/Header.js'
import NewOrgForm from './NewOrgForm.js'
import { requireUser } from '@/lib/session.js'

export const metadata = { title: 'Create an org' }

export default async function NewOrg () {
  await requireUser('/orgs/new')
  return (
    <>
      <Header signedIn />
      <main className='wrap page' style={{ maxWidth: 420 }}>
        <div className='card stack'>
          <h2>Create an org</h2>
          <p className='muted'>A shared space for your team. You will be its owner and can invite people once it is made.</p>
          <NewOrgForm />
        </div>
      </main>
    </>
  )
}
