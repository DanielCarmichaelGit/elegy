'use client'

// The header's single download button: picks the visitor's OS in the browser (same
// detection the landing page uses), or falls back to a plain link to the closing band.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { detectDownloads } from '@/lib/platform.js'
import { OsIcon } from './DownloadButtons.js'

export default function HeaderDownload () {
  const [pick, setPick] = useState(null)

  useEffect(() => {
    let live = true
    detectDownloads(typeof navigator !== 'undefined' ? navigator : undefined)
      .then((p) => { if (live) setPick(p) })
    return () => { live = false }
  }, [])

  // Unknown, or genuinely ambiguous (both Mac and Windows offered): a plain link down to
  // the download band rather than guessing.
  if (!pick || pick.primary.length !== 1) {
    return <Link className='btn primary qh-dl' href='/#download'>Download</Link>
  }
  const d = pick.primary[0]
  return <a className='btn primary qh-dl' href={d.href}><OsIcon os={d.os} />Download</a>
}
