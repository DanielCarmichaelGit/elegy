import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import Header from '@/components/Header.js'
import Footer from '@/components/Footer.js'
import Mark from '@/components/Mark.js'
import JoinInvite from '@/components/JoinInvite.js'
import { pickDownloads } from '@/lib/platform.js'
import { isRoom, JOIN_HOST } from '@/lib/join.js'

// Public (no sign-in): someone opening an invite may not have an account yet.
export const metadata = { title: 'Join a session', robots: { index: false, follow: false }, referrer: 'no-referrer' }

// On join.heyquilt.com the site's normal Header can't be used: its links (/pricing, /signin,
// /dashboard, ...) are relative, so on this host they'd try to open the invite page for a
// "room" called pricing, signin, and so on. A plain, non-sticky bar with absolute links instead.
function JoinBar () {
  return (
    <header className='qh join-bar'>
      <a href='https://heyquilt.com/' className='brand qh-brand' aria-label='Quilt home'><Mark /></a>
    </header>
  )
}

export default async function Join ({ params }) {
  const { room } = await params
  if (!isRoom(room)) notFound()
  const h = await headers()
  const onJoinHost = (h.get('host') || '').split(':')[0].toLowerCase() === JOIN_HOST
  const ua = h.get('user-agent') || ''
  return (
    <>
      {onJoinHost ? <JoinBar /> : <Header />}
      <main className='wrap page' style={{ maxWidth: 560 }}>
        <div className='card stack join-card'>
          <JoinInvite room={room} downloads={pickDownloads({ ua })} />
        </div>
      </main>
      <Footer />
    </>
  )
}
