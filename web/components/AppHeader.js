import Link from 'next/link'
import { cookies } from 'next/headers'
import Mark from './Mark.js'
import HeaderNav from './HeaderNav.js'
import StickyHeader from './StickyHeader.js'
import SpaceSwitcher from './SpaceSwitcher.js'
import AccountMenu from './AccountMenu.js'
import { myOrgs, orgMe } from '@/lib/org.js'
import { orgTabs } from '@/lib/org-view.js'
import { SPACE_COOKIE, PERSONAL, spaceHome } from '@/lib/space.js'
import { createClient } from '@/lib/supabase/server.js'

const PERSONAL_NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/dashboard#computers', label: 'Computers' },
  { href: '/dashboard#agents', label: 'Agents' }
]

/** Initials for the avatar: from the profile name, else the email. */
export function initials (name, email) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (words.length) return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase()
  return String(email || '?')[0].toUpperCase()
}

// The signed-in header: the space you're in (switchable), that space's pages, and your
// account menu. space is 'personal' or an org slug; left out, it's the remembered space.
// myOrgs and orgMe are cached per request, so pages that already loaded them pay nothing.
export default async function AppHeader ({ user, space }) {
  const orgs = await myOrgs(user.accessToken)
  if (!space) {
    const home = spaceHome((await cookies()).get(SPACE_COOKIE)?.value, orgs)
    space = home === '/dashboard' ? PERSONAL : home.slice('/org/'.length)
  }
  const org = space !== PERSONAL ? orgs.find((o) => o.slug === space) : null
  const supabase = await createClient()
  const [{ data: profile }, me] = await Promise.all([
    supabase.from('profiles').select('name').eq('id', user.id).maybeSingle(),
    org ? orgMe(user.accessToken, org.slug) : null
  ])
  const items = org
    ? orgTabs(org.slug, me).map((t) => t.href === `/org/${org.slug}` ? { ...t, exact: true } : t)
    : PERSONAL_NAV
  return (
    <StickyHeader>
      <header className='qh'>
        <Link href={org ? `/org/${org.slug}` : '/dashboard'} className='brand qh-brand' aria-label='Quilt home'><Mark /></Link>
        <span className='qh-divider' />
        <SpaceSwitcher orgs={orgs} current={org ? org.slug : PERSONAL} />
        <HeaderNav items={items} label={org ? `${org.name} pages` : 'Your pages'} />
        <span className='qh-grow' />
        <AccountMenu
          name={profile?.name || ''}
          email={user.email}
          initials={initials(profile?.name, user.email)}
          where={org ? org.name : 'Personal'}
        />
      </header>
    </StickyHeader>
  )
}

/** The same bar while a signed-in page loads, so nothing shifts when it arrives. */
export function AppHeaderSkeleton () {
  return (
    <StickyHeader>
      <header className='qh'>
        <Link href='/dashboard' className='brand qh-brand' aria-label='Quilt home'><Mark /></Link>
        <span className='qh-divider' />
        <span className='skeleton qh-skel' style={{ width: 150 }} />
        <span className='skeleton qh-skel' style={{ width: 260 }} />
        <span className='qh-grow' />
        <span className='skeleton' style={{ width: 36, height: 36, borderRadius: '50%' }} />
      </header>
    </StickyHeader>
  )
}
