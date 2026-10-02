// Next's error boundary for a page that crashed while rendering: a short page, a retry,
// and a report with the message so the crash is counted.
'use client'
import ReportPageIssue from '@/components/ReportPageIssue.js'

export default function Error ({ error, reset }) {
  // In production a server-component error reaches the client with a generic message;
  // the digest is the only link back to the Netlify function log for that crash.
  const message = error?.digest ? `${error?.message || ''} [digest ${error.digest}]` : (error?.message || '')
  return (
    <main className='wrap' style={{ padding: '96px 0' }}>
      <div className='card stack' style={{ maxWidth: 520, margin: '0 auto' }}>
        <h1>Something went wrong</h1>
        <p className='muted'>This page hit a problem. Trying again usually works.</p>
        <p><button className='btn primary' type='button' onClick={() => reset()}>Try again</button></p>
      </div>
      <ReportPageIssue kind='error' message={message} />
    </main>
  )
}
