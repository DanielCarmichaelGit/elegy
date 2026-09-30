import Header from '@/components/Header.js'
import SpaceSwitcher from '@/components/SpaceSwitcher.js'
import { requireUser } from '@/lib/session.js'
import { myOrgs, orgMe } from '@/lib/org.js'
import { orgTabs } from '@/lib/org-view.js'

export default async function OrgLayout ({ children, params }) {
  const { slug } = await params
  const user = await requireUser(`/org/${slug}`)
  const [me, orgs] = await Promise.all([orgMe(user.accessToken, slug), myOrgs(user.accessToken)])
  return (
    <>
      <Header signedIn />
      <main className='wrap page stack'>
        <div className='row' style={{ justifyContent: 'space-between' }}>
          <h1 style={{ fontSize: 32 }}>{me.org.name}</h1>
          <SpaceSwitcher orgs={orgs} current={slug} />
        </div>
        <nav className='tabs' aria-label={`${me.org.name} sections`}>
          {orgTabs(slug, me).map((t) => <a key={t.href} href={t.href}>{t.label}</a>)}
        </nav>
        {children}
      </main>
    </>
  )
}
