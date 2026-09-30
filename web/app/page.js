import { headers } from 'next/headers'
import Link from 'next/link'
import Header from '@/components/Header.js'
import Footer from '@/components/Footer.js'
import Mark from '@/components/Mark.js'
import DownloadButtons from '@/components/DownloadButtons.js'
import { pickDownloads } from '@/lib/platform.js'

const STEPS = [
  ['start.png', 'The Quilt app, picking a project folder to start a session.', 'Start a session', 'Pick a project folder in the Quilt app.'],
  ['invite.png', 'A Quilt invite link, ready to send to a partner.', 'Send the link', 'Your partner clicks it and the project appears on their computer.'],
  ['session.png', 'A live Quilt session with both partners editing.', 'Build together', 'Edits sync live, and you see who is changing what.']
]
const TOOLS = ['Claude Code', 'Cursor', 'Codex', 'Windsurf', 'VS Code', 'Zed']

// The window-frame chrome around a screenshot, sewn onto a quilt patch band in the hero and the
// closing band, or plain on the cards and the dark feature band.
function WindowShot ({ src, alt, title, height = 360, eager = false }) {
  return (
    <div className='qwin'>
      <div className='qwin-bar'>
        <i /><i /><i />
        <span>{title}</span>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element -- fixed local screenshots, plain img keeps object-fit/position simple */}
      <img className='qwin-shot' src={`/shots/${src}`} alt={alt} width={1600} height={1000} style={{ height }} loading={eager ? 'eager' : 'lazy'} />
    </div>
  )
}

export default async function Home ({ searchParams }) {
  const q = await searchParams
  const ua = (await headers()).get('user-agent') || ''
  const initial = pickDownloads({ ua })
  return (
    <>
      <Header />
      <main className='page'>
        <div className='wrap'>
          {q.deleted && <p className='notice'>Your Quilt account was deleted.</p>}

          <section className='hero-b'>
            <Mark word={false} sew className='hero-mark' />
            <h1>Build together, live. Everyone in their own AI.</h1>
            <p className='lead'>One project folder, synced between you and your partners. Each of you keeps your own AI, and you can watch each other's work as it happens.</p>
            <DownloadButtons initial={initial} />
          </section>

          <section className='hero-band'>
            <div className='quilt-patch' aria-hidden='true' />
            <div className='quilt-stitch' aria-hidden='true' />
            <div className='hero-band-win'>
              <WindowShot src='session.png' alt='A live Quilt session, with both partners editing the same project and a feed of what each AI is doing.' title='quilt · landing-page (shared with Sam)' height={440} eager />
            </div>
          </section>
        </div>

        <div className='wrap sec' id='how'>
          <h2>Three steps, no setup</h2>
          <p className='sub'>Pick a folder, send a link, and you're building together.</p>
          <div className='steps'>
            {STEPS.map(([shot, alt, title, text], i) => (
              <div key={title} className='step'>
                <WindowShot src={shot} alt={alt} title='quilt · project' height={150} />
                <div className='step-t'>
                  <span className='pill step-n'>{i + 1}</span>
                  <h3>{title}</h3>
                  <p className='muted'>{text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className='wrap'>
          <section className='feature-band'>
            <div>
              <h2>See what their AI is doing</h2>
              <p>Every prompt and change from your partner's Claude Code or Cursor shows up in the feed, so two AIs never step on the same file.</p>
            </div>
            <WindowShot src='feed.png' alt="The activity feed in a Quilt session, showing a partner's prompts and their AI's edits as they happen." title='quilt · landing-page (shared with Sam)' height={320} />
          </section>
        </div>

        <div className='wrap sec' style={{ textAlign: 'center' }}>
          <h2>Works with the AI you already use</h2>
          <p className='sub'>No plugin to install. Quilt syncs the folder, your tools stay yours.</p>
          <div className='tools-row'>{TOOLS.map((t) => <span key={t} className='tool-chip'>{t}</span>)}</div>
        </div>

        <div className='wrap'>
          <section className='card stack agents-card' id='agents'>
            <h2>Agents will be able to join too</h2>
            <p className='muted'>Coming soon: create an agent in your dashboard and give it an invite link. It will be able to join sessions as its own member, with an agent badge, reading and editing files, and chatting with everyone.</p>
            <div><Link className='btn' href='/signin'>Get started</Link></div>
          </section>
        </div>

        <div className='wrap' id='download'>
          <section className='cta-band'>
            <div className='quilt-patch' aria-hidden='true' />
            <div className='quilt-stitch' aria-hidden='true' />
            <div className='cta-inner'>
              <h2>Start a session in a minute</h2>
              <p className='sub'>Free while we build it.</p>
              <DownloadButtons initial={initial} />
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </>
  )
}
