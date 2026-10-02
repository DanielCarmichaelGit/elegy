import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import Header from '@/components/Header.js'
import Footer from '@/components/Footer.js'
import JoinInvite from '@/components/JoinInvite.js'
import { currentUser } from '@/lib/session.js'
import { pickDownloads } from '@/lib/platform.js'
import { isRoom } from '@/lib/join.js'

// Public: someone opening an invite may not have an account yet. The page itself sends
// signed-out people to sign in (keeping the invite in their browser), and opens the
// app for signed-in people.
export const metadata = { title: 'Join a session', robots: { index: false, follow: false }, referrer: 'no-referrer' }

export default async function Join ({ params }) {
  const { room } = await params
  if (!isRoom(room)) notFound()
  const user = await currentUser()
  const ua = (await headers()).get('user-agent') || ''
  return (
    <>
      <Header />
      <main className='wrap page'>
        <div className='card stack join-card'>
          <JoinInvite room={room} signedIn={!!user} downloads={pickDownloads({ ua })} />
        </div>
      </main>
      <Footer />
    </>
  )
}
