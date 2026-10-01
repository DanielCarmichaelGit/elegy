'use client'

// "Your account was deleted." after deleting it (settings redirects to /?deleted=1). Read in the
// browser so the homepage itself stays static; render it inside <Suspense>.
import { useSearchParams } from 'next/navigation'

export default function DeletedNotice () {
  const q = useSearchParams()
  return q.get('deleted') ? <p className='notice'>Your Quilt account was deleted.</p> : null
}
