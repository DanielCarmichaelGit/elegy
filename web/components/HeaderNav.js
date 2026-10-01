'use client'

// The segmented pill nav, plus the sub-760px collapse into a menu button that opens a small
// panel. usePathname highlights the current page's item: an exact match, or a page under it
// unless the item says exact (an org's Overview, which every org page sits under).
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const MARKETING = [
  { href: '/#how', label: 'How it works' },
  { href: '/#agents', label: 'Agents' },
  { href: '/pricing', label: 'Pricing' }
]

function isOn (item, pathname) {
  const path = item.href.split('#')[0]
  if (!path || item.href.includes('#')) return false
  return pathname === path || (!item.exact && pathname.startsWith(path + '/'))
}

export default function HeaderNav ({ items = MARKETING, label = 'Main' }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const link = (item, onClick) => {
    const on = isOn(item, pathname)
    return (
      <Link key={item.href} className={`qh-link${on ? ' on' : ''}`} href={item.href} onClick={onClick} aria-current={on ? 'page' : undefined}>
        {item.label}
      </Link>
    )
  }

  return (
    <>
      <nav className='qh-mid' aria-label={label}>{items.map((item) => link(item))}</nav>
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
          {items.map((item) => link(item, () => setOpen(false)))}
        </div>
      )}
    </>
  )
}
