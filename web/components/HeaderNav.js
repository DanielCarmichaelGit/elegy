'use client'

// The segmented pill nav (header option B), plus the sub-760px collapse into a menu
// button that opens a small panel. usePathname highlights the current page's item.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const ITEMS = [
  { href: '/#how', label: 'How it works' },
  { href: '/#agents', label: 'Agents' },
  { href: '/pricing', label: 'Pricing' }
]

export default function HeaderNav () {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const link = (item, onClick) => {
    const active = item.href === '/pricing' && pathname === '/pricing'
    return (
      <Link key={item.href} className={`qh-link${active ? ' on' : ''}`} href={item.href} onClick={onClick}>
        {item.label}
      </Link>
    )
  }

  return (
    <>
      <nav className='qh-mid' aria-label='Main'>{ITEMS.map((item) => link(item))}</nav>
      <button
        type='button'
        className='qh-menu-btn'
        aria-expanded={open}
        aria-controls='qh-mobile-panel'
        aria-label='Menu'
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox='0 0 24 24' aria-hidden='true' width='20' height='20'>
          <path fill='currentColor' d='M3 6h18v2H3zM3 11h18v2H3zM3 16h18v2H3z' />
        </svg>
      </button>
      {open && (
        <div id='qh-mobile-panel' className='qh-mobile-panel'>
          {ITEMS.map((item) => link(item, () => setOpen(false)))}
        </div>
      )}
    </>
  )
}
