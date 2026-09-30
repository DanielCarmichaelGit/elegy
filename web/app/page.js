import { headers } from 'next/headers'
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
const AGENT_STEPS = [
  ['The agent asks to join', 'It registers itself and shows you a link and a short code, no account needed.'],
  ['You approve and set what it can do', 'Pick the org, the teams, editor or viewer, and optionally which folders.'],
  ['It joins as its own member', 'Agent badge, its own edits and chats, and the same claims and roles as people.']
]
const AGENT_CAPS = [
  ['folder', 'Edits only its folders', "It can only touch the folders you allow, nothing else in the project."],
  ['chat', 'Chats with everyone', 'It shows up in the session feed and talks with people like any member.'],
  ['clock', 'Keys expire every hour', 'Its access key is short-lived, refreshed automatically while it stays approved.'],
  ['off', 'Revoke in one click', 'Cut it off at once and every key it holds stops working immediately.']
]
const AGENT_CAP_ICONS = {
  folder: <path d='M3 6.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' />,
  chat: <path d='M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z' />,
  clock: <><circle cx='12' cy='12' r='9' /><path d='M12 7v5l3.5 2' /></>,
  off: <><path d='M12 3v7' /><path d='M6.5 6.5a8 8 0 1 0 11 0' /></>
}

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

        <div className='wrap sec' id='agents'>
          <div className='agents-head'>
            <div className='row' style={{ justifyContent: 'center', gap: 10 }}>
              <h2>Bring your AI agents in as teammates</h2>
              <span className='pill'>Coming soon</span>
            </div>
            <p className='sub'>An agent can sign itself up, and join a session as a member in its own right.</p>
          </div>

          <div className='steps agent-steps'>
            {AGENT_STEPS.map(([title, text], i) => (
              <div key={title} className='step agent-step'>
                <div className='step-t'>
                  <span className='pill step-n'>{i + 1}</span>
                  <h3>{title}</h3>
                  <p className='muted'>{text}</p>
                </div>
              </div>
            ))}
          </div>

          <div className='agent-visual'>
            <div className='agent-approve-card' role='img' aria-label='An approval screen for an agent named Larry, showing its code K7QD-2MFX, the Acme org as the destination, editor access to the Web team and viewer access to the Docs team, folder access limited to src and docs, and Approve and Deny buttons.'>
              <div className='agent-approve-top'>
                <span className='agent-avatar' style={{ background: 'var(--qm-a)' }}>L</span>
                <div>
                  <div className='row' style={{ gap: 6 }}>
                    <b>Larry</b><span className='agent-badge'>Agent</span>
                  </div>
                  <span className='mono muted agent-code'>K7QD-2MFX</span>
                </div>
              </div>
              <dl className='agent-approve-rows'>
                <div className='agent-approve-row'>
                  <dt>Where</dt>
                  <dd>Acme org</dd>
                </div>
                <div className='agent-approve-row'>
                  <dt>Teams</dt>
                  <dd className='stack' style={{ gap: 6 }}>
                    <span className='agent-team-row'>Web <span className='agent-select'>Editor</span></span>
                    <span className='agent-team-row'>Docs <span className='agent-select'>Viewer</span></span>
                  </dd>
                </div>
                <div className='agent-approve-row'>
                  <dt>Folders</dt>
                  <dd className='row' style={{ gap: 6 }}>
                    <span className='tool-chip agent-chip mono'>src/</span>
                    <span className='tool-chip agent-chip mono'>docs/</span>
                  </dd>
                </div>
              </dl>
              <div className='row agent-approve-actions' aria-hidden='true'>
                <span className='btn primary agent-fake-btn'>Approve</span>
                <span className='btn agent-fake-btn'>Deny</span>
              </div>
            </div>

            <div className='agent-session-card' role='img' aria-label='A session member list showing three members: you on Cursor, Sam on Claude Code, and Larry with an agent badge, whose status reads editing src slash pricing dot jsx.'>
              <div className='qwin-bar'><i /><i /><i /><span>quilt · members</span></div>
              <ul className='agent-member-list'>
                <li>
                  <span className='agent-avatar' style={{ background: 'var(--qm-a)' }}>Y</span>
                  <div>
                    <b>You</b>
                    <span className='muted agent-member-sub'>Cursor</span>
                  </div>
                </li>
                <li>
                  <span className='agent-avatar' style={{ background: 'var(--qm-c)' }}>S</span>
                  <div>
                    <b>Sam</b>
                    <span className='muted agent-member-sub'>Claude Code</span>
                  </div>
                </li>
                <li>
                  <span className='agent-avatar' style={{ background: 'var(--qm-b)' }}>L</span>
                  <div>
                    <div className='row' style={{ gap: 6 }}>
                      <b>Larry</b><span className='agent-badge'>Agent</span>
                    </div>
                    <span className='muted agent-member-sub'>editing src/pricing.jsx</span>
                  </div>
                </li>
              </ul>
            </div>
          </div>

          <div className='agent-caps'>
            {AGENT_CAPS.map(([icon, title, text]) => (
              <div key={title} className='agent-cap'>
                <svg className='agent-cap-ico' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.6' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>
                  {AGENT_CAP_ICONS[icon]}
                </svg>
                <h3>{title}</h3>
                <p className='muted'>{text}</p>
              </div>
            ))}
          </div>
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
