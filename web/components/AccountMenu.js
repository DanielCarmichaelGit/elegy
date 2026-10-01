'use client'

// The avatar button and its menu: who you are, account settings, the app, and sign out.
// Closes on Escape, on a click outside, and after choosing an item.
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

export default function AccountMenu ({ name, email, initials, where }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [open])

  const close = () => setOpen(false)
  return (
    <div className='qh-account' ref={ref}>
      <button
        type='button'
        className='qh-avatar'
        aria-expanded={open}
        aria-controls='qh-account-menu'
        aria-label='Account menu'
        onClick={() => setOpen((o) => !o)}
      >
        <span className='qh-avatar-face'>{initials}</span>
        <span className='qh-avatar-car' aria-hidden='true'><svg viewBox='0 0 12 12' width='10' height='10' aria-hidden='true'><path d='M2.5 4.5h7L6 8.5z' fill='currentColor' /></svg></span>
      </button>
      {open && (
        <div id='qh-account-menu' className='qh-account-menu'>
          <div className='qh-who'>
            <b>{name || email}</b>
            <span>{name ? email : where}</span>
          </div>
          <Link href='/settings' onClick={close}>Account settings</Link>
          <Link href='/#download' onClick={close}>Download the app</Link>
          <Link href='/pricing' onClick={close}>Pricing</Link>
          <form action='/auth/signout' method='post'><button className='qh-out'>Sign out</button></form>
        </div>
      )}
    </div>
  )
}
