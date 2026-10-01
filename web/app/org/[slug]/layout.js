import AppHeader from '@/components/AppHeader.js'
import { requireUser } from '@/lib/session.js'
import { orgMe } from '@/lib/org.js'

export default async function OrgLayout ({ children, params }) {
  const { slug } = await params
  const user = await requireUser(`/org/${slug}`)
  const me = await orgMe(user.accessToken, slug)
  return (
    <>
      <AppHeader user={user} space={slug} />
      <main className='wrap page stack'>
        <h1 style={{ fontSize: 32 }}>{me.org.name}</h1>
        {children}
      </main>
    </>
  )
}
