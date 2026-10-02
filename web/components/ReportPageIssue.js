// Posts one report about this page (a 404, or a page that crashed) when it is shown.
// Only the path goes: never the query string or fragment, where invite links keep secrets.
'use client'
import { useEffect, useRef } from 'react'

export default function ReportPageIssue ({ kind, message = '' }) {
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current) return
    sent.current = true
    fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, name: window.location.pathname, message: String(message || '').slice(0, 500) }) }).catch(() => {})
  }, [kind, message])
  return null
}
