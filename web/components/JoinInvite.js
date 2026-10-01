'use client'

import { useEffect, useState } from 'react'
import DownloadButtons from './DownloadButtons.js'
import { joinView } from '@/lib/join.js'

// The part of the join page that needs the browser: the secret is only in location.hash.
export default function JoinInvite ({ room, downloads }) {
  const [view, setView] = useState(null) // null until the fragment has been read

  useEffect(() => { setView(joinView(room, window.location.hash)) }, [room])

  return (
    <>
      <h1>You're invited to a Quilt session</h1>
      {view && view.missing && <p className='notice bad'>This link is missing part of it. Ask for a new invite.</p>}
      {view && !view.missing && <a className='btn primary join-open' href={view.open}>Open in Quilt</a>}
      <p className='muted'>Quilt will ask you to sign in first.</p>
      <div className='join-get'>
        <p className='muted'>Don't have Quilt yet? Download it, then click Open in Quilt again.</p>
        <DownloadButtons initial={downloads} />
      </div>
    </>
  )
}
