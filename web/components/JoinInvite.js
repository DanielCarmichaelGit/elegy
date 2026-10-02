'use client'

import { useEffect, useState } from 'react'
import DownloadButtons from './DownloadButtons.js'
import { joinView, rememberJoin, recallJoin, signInForJoin } from '@/lib/join.js'

// The part of the join page that needs the browser: the secret is only in location.hash.
// Signed out: remember the invite here and go sign in (or sign up); the sign-in comes
// back to this page, where the remembered secret is picked up again.
// Signed in: open the app straight away, with the button and downloads as the fallback.
export default function JoinInvite ({ room, signedIn, downloads }) {
  const [view, setView] = useState(null) // null until the fragment has been read

  useEffect(() => {
    const storage = (() => { try { return window.localStorage } catch { return null } })()
    const fromLink = window.location.hash.replace(/^#/, '')
    if (fromLink) rememberJoin(storage, room, fromLink)
    const secret = fromLink || recallJoin(storage, room)
    if (!secret) { setView({ missing: true }); return }
    if (!signedIn) {
      setView({ signingIn: true })
      window.location.replace(signInForJoin(room))
      return
    }
    const v = joinView(room, secret)
    setView(v)
    // Hand the invite to the app. Without the app installed nothing happens, and the
    // page below says what to do.
    window.location.assign(v.open)
  }, [room, signedIn])

  if (view && view.signingIn) {
    return (
      <>
        <h1>You're invited to a Quilt session</h1>
        <p className='muted'>Sign in to Quilt to join. Taking you there…</p>
        <a className='btn primary join-open' href={signInForJoin(room)}>Sign in to join</a>
      </>
    )
  }
  const ready = view && !view.missing && !view.signingIn
  return (
    <>
      <h1>You're invited to a Quilt session</h1>
      {view && view.missing && <p className='notice bad'>This link is missing part of it. Ask for a new invite.</p>}
      {ready && <p className='muted'>Opening Quilt… If it didn't open, click the button.</p>}
      {ready && <a className='btn primary join-open' href={view.open}>Open in Quilt</a>}
      <div className='join-get'>
        <p className='muted'>Don't have Quilt yet? Download it, open it once, then click Open in Quilt again.</p>
        <DownloadButtons initial={downloads} />
      </div>
    </>
  )
}
