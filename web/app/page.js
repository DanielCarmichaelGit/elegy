import { headers } from 'next/headers'
import Link from 'next/link'
import Header from '@/components/Header.js'
import Footer from '@/components/Footer.js'
import Mark from '@/components/Mark.js'
import { downloadFor, DOWNLOADS } from '@/lib/platform.js'
import { currentUser } from '@/lib/session.js'

const STEPS = [
  ['Start a session', 'Pick a project folder in the Quilt app.'],
  ['Send the link', 'Your partner clicks it and the project appears on their computer.'],
  ['Build together', 'Edits sync live, and you can watch each other\'s AI work.']
]
const TOOLS = ['Claude Code', 'Cursor', 'Codex', 'Windsurf', 'VS Code', 'Zed']

export default async function Home () {
  const ua = (await headers()).get('user-agent') || ''
  const main = downloadFor(ua)
  const others = Object.values(DOWNLOADS).filter((d) => d !== main)
  const user = await currentUser()
  return (
    <>
      <Header signedIn={!!user} />
      <main className='wrap page'>
        <section className='stack' style={{ alignItems: 'center', textAlign: 'center', padding: '56px 0 40px' }}>
          <Mark sew className='hero-mark' />
          <h1 style={{ maxWidth: 760 }}>Build one project together, live — everyone in their own AI.</h1>
          <p className='muted' style={{ maxWidth: 560 }}>Quilt keeps a folder in sync between you and your partners while each of you works with Claude Code, Cursor, or whatever you like.</p>
          <div className='row' style={{ justifyContent: 'center' }}>
            {main && <a className='btn primary' href={main.href}>{main.label}</a>}
            {others.map((d) => <a key={d.href} className={main ? 'btn ghost' : 'btn'} href={d.href}>{d.label}</a>)}
          </div>
        </section>
        <section className='row' style={{ alignItems: 'stretch', marginTop: 24 }}>
          {STEPS.map(([title, text], i) => (
            <div key={title} className='card stack' style={{ flex: '1 1 260px' }}>
              <span className='pill'>{i + 1}</span>
              <h3>{title}</h3>
              <p className='muted'>{text}</p>
            </div>
          ))}
        </section>
        <section className='stack' style={{ marginTop: 56, alignItems: 'center', textAlign: 'center' }}>
          <h2>Works with every AI</h2>
          <div className='row' style={{ justifyContent: 'center' }}>{TOOLS.map((t) => <span key={t} className='pill'>{t}</span>)}</div>
        </section>
        <section className='card stack' style={{ marginTop: 56 }}>
          <h2>Agents can join too</h2>
          <p className='muted'>Create an agent in your dashboard and give it an invite link. It joins the session as its own member — with an agent badge — reads and edits files, and chats with everyone.</p>
          <div><Link className='btn' href='/signin'>Get started</Link></div>
        </section>
      </main>
      <Footer />
    </>
  )
}
