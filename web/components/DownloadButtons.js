'use client'

import { useEffect, useState } from 'react'
import { pickDownloads } from '@/lib/platform.js'

// Apple and Windows glyphs, inline so they inherit the button's text colour.
function AppleLogo () {
  return (
    <svg viewBox='0 0 24 24' aria-hidden='true'>
      <path d='M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701' />
    </svg>
  )
}

function WindowsLogo () {
  return (
    <svg viewBox='0 0 24 24' aria-hidden='true'>
      <path d='M0 3.4 9.8 2v9.5H0zM11 1.8 24 0v11.4H11zM0 12.6h9.8V22L0 20.6zM11 12.6h13V24l-13-1.8z' />
    </svg>
  )
}

const Logo = ({ os }) => os === 'windows' ? <WindowsLogo /> : <AppleLogo />

// Fine print under the buttons: links to whichever builds aren't already showing as buttons.
function FinePrint ({ primary, others }) {
  if (primary.length > 1) {
    const intel = others[0]
    return <p className='dl-fine'>Mac with Intel? <a href={intel.href}>{intel.fine}</a></p>
  }
  if (!others.length) return null
  return (
    <p className='dl-fine'>
      {others.map((d, i) => (
        <span key={d.href}>{i > 0 ? ' · ' : ''}<a href={d.href}>{d.fine}</a></span>
      ))}
    </p>
  )
}

// Renders the server's best guess from the user-agent immediately, then refines it on mount
// with navigator.userAgentData when the browser supports it. Falls back to showing both
// buttons whenever detection isn't possible (Safari, Firefox, Linux, mobile, or an error).
export default function DownloadButtons ({ initial, className = '' }) {
  const [pick, setPick] = useState(initial)

  useEffect(() => {
    const uad = typeof navigator !== 'undefined' ? navigator.userAgentData : null
    if (!uad || typeof uad.getHighEntropyValues !== 'function') return
    uad.getHighEntropyValues(['architecture', 'platform'])
      .then(({ architecture, platform }) => setPick(pickDownloads({ architecture, platform })))
      .catch(() => {}) // can't tell: keep the server's guess, which already shows both if unsure
  }, [])

  const { primary, others } = pick
  return (
    <div className={className}>
      <div className='row dl-row' style={{ justifyContent: 'center' }}>
        {primary.map((d, i) => (
          <a key={d.href} className={i === 0 ? 'btn primary dl-btn' : 'btn ghost dl-btn'} href={d.href}>
            <Logo os={d.os} />{d.label}
          </a>
        ))}
      </div>
      <FinePrint primary={primary} others={others} />
    </div>
  )
}
