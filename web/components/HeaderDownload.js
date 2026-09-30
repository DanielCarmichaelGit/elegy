'use client'

// The header's single download button: picks the visitor's OS in the browser (same
// detection the landing page uses), or falls back to a plain link to the closing band.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { pickDownloads } from '@/lib/platform.js'
import { OsIcon } from './DownloadButtons.js'

export default function HeaderDownload () {
  const [pick, setPick] = useState(null)

  useEffect(() => {
    const uad = typeof navigator !== 'undefined' ? navigator.userAgentData : null
    if (uad && typeof uad.getHighEntropyValues === 'function') {
      uad.getHighEntropyValues(['architecture', 'platform'])
        .then(({ architecture, platform }) => setPick(pickDownloads({ architecture, platform })))
        .catch(() => setPick(pickDownloads({ ua: navigator.userAgent })))
    } else {
      setPick(pickDownloads({ ua: typeof navigator !== 'undefined' ? navigator.userAgent : '' }))
    }
  }, [])

  // Unknown, or genuinely ambiguous (both Mac and Windows offered): a plain link down to
  // the download band rather than guessing.
  if (!pick || pick.primary.length !== 1) {
    return <Link className='btn dark qh-dl' href='/#download'>Download</Link>
  }
  const d = pick.primary[0]
  return <a className='btn dark qh-dl' href={d.href}><OsIcon os={d.os} />Download</a>
}
