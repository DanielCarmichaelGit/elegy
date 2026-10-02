// The page for an address that isn't anything: the same shell as the rest of the site,
// a way back, and a quiet report so broken links get noticed.
import Link from 'next/link'
import Header from '@/components/Header.js'
import Footer from '@/components/Footer.js'
import ReportPageIssue from '@/components/ReportPageIssue.js'

export const metadata = { title: 'Page not found' }

export default function NotFound () {
  return (
    <>
      <Header />
      <main className='wrap' style={{ padding: '96px 0' }}>
        <div className='card stack' style={{ maxWidth: 520, margin: '0 auto' }}>
          <h1>That page isn’t here</h1>
          <p className='muted'>The link may be old, or the address may have a typo. Nothing of yours was touched.</p>
          <p><Link className='btn primary' href='/'>Back to Quilt</Link></p>
        </div>
      </main>
      <Footer />
      <ReportPageIssue kind='http404' />
    </>
  )
}
