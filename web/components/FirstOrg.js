'use client'
import { useEffect, useRef, useState } from 'react'
import { createFirstOrg, dismissFirstOrg } from '@/app/dashboard/actions.js'

// Makes the org a "A team" sign-up asked for, once, then opens it.
export default function FirstOrg ({ name }) {
  const started = useRef(false)
  const [error, setError] = useState(null)

  async function run () {
    setError(null)
    const r = await createFirstOrg()
    if (r?.slug) window.location.assign(`/org/${r.slug}`)
    else setError(r?.error || 'Couldn’t create your org. Try again.')
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
            <div className='row'>
              <button className='btn primary' onClick={run}>Try again</button>
              <form action={dismissFirstOrg}><button className='btn ghost'>Not now</button></form>
            </div>
          </>)
        : <p className='muted'>Setting up {name}…</p>}
    </section>
  )
}
