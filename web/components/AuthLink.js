'use client'

// Sign in / Dashboard in the header, decided entirely in the browser so public pages
// (the landing page, pricing) never need to call Supabase on the server for it.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client.js'

export default function AuthLink () {
  const [signedIn, setSignedIn] = useState(false)

  useEffect(() => {
    let active = true
    createClient().auth.getSession().then(({ data }) => {
      if (active) setSignedIn(!!data.session)
    }).catch(() => {})
    return () => { active = false }
  }, [])

  return signedIn
    ? <Link className='qh-link' href='/dashboard'>Dashboard</Link>
    : <Link className='qh-link' href='/signin'>Sign in</Link>
}
