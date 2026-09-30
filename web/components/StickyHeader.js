'use client'

// Keeps the header stuck to the top, sliding it away while the page scrolls down and back
// the moment it scrolls up. Near the top it always shows, and it stays put while one of its
// menus is open or something inside it has keyboard focus.
import { useEffect, useRef, useState } from 'react'

const TOP = 80 // always shown this close to the top
const JITTER = 4 // ignore tiny trackpad wobbles

export default function StickyHeader ({ children }) {
  const ref = useRef(null)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    let last = window.scrollY
    const onScroll = () => {
      const y = window.scrollY
      const dy = y - last
      if (Math.abs(dy) < JITTER) return
      last = y
      const el = ref.current
      const busy = el && (el.querySelector('[aria-expanded="true"]') || el.contains(document.activeElement))
      setHidden(y > TOP && dy > 0 && !busy)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div ref={ref} className={`qh-wrap${hidden ? ' qh-hidden' : ''}`} onFocusCapture={() => setHidden(false)}>
      {children}
    </div>
  )
}
