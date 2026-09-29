import Header from '@/components/Header.js'
import Footer from '@/components/Footer.js'
import { currentUser } from '@/lib/session.js'

export const metadata = { title: 'Pricing' }

const PLANS = [
  { name: 'Free', what: 'Everything on your own computers and network.' },
  { name: 'Paid', what: 'Cloud sessions: join from anywhere, and bring cloud agents.' },
  { name: 'Team', what: 'Per seat, with control over who reaches your sessions.' }
]

export default async function Pricing () {
  const user = await currentUser()
  return (
    <>
      <Header signedIn={!!user} />
      <main className='wrap page stack'>
        <h1>Pricing is coming soon</h1>
        <p className='muted'>Quilt is free while we build it. These are the plans we're planning.</p>
        <div className='row' style={{ alignItems: 'stretch' }}>
          {PLANS.map((p) => (
            <div key={p.name} className='card stack' style={{ flex: '1 1 240px' }}>
              <h3>{p.name}</h3>
              <p className='muted'>{p.what}</p>
            </div>
          ))}
        </div>
      </main>
      <Footer />
    </>
  )
}
