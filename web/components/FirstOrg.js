'use client'
import { useEffect, useRef, useState } from 'react'
import { createFirstOrg } from '@/app/dashboard/actions.js'

// Makes the org an org sign-up asked for, once, then opens it. There's no way
// to skip this: org_name only clears once the org actually exists, so the
// only way off this screen is for the org to get made.
export default function FirstOrg ({ name }) {
  const started = useRef(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function run () {
    setError(null)
    setBusy(true)
    const r = await createFirstOrg()
    if (r?.slug) { window.location.assign(`/org/${r.slug}`); return }
    setBusy(false)
    setError(r?.error || 'Couldn’t create your org. Try again.')
  }

  // React may run effects twice in development; the ref keeps it to one org.
  useEffect(() => {
    if (started.current) return
    started.current = true
    run()
  }, [])

  return (
    <section className='card stack'>
      {error
        ? (
          <>
            <p className='notice bad'>{error}</p>
            <button className='btn primary' onClick={run} disabled={busy}>{busy ? 'Trying…' : 'Try again'}</button>
          </>)
        : <p className='muted'>Setting up {name}…</p>}
    </section>
  )
}
