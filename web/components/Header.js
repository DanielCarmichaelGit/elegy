import Link from 'next/link'
import Mark from './Mark.js'
import HeaderNav from './HeaderNav.js'
import AuthLink from './AuthLink.js'
import HeaderDownload from './HeaderDownload.js'

// Header option B: a floating rounded bar. Fully static (no headers()/cookies()/currentUser),
// so any page that renders it can still be prerendered; sign-in state and the download pick
// are both resolved client-side (see AuthLink.js and HeaderDownload.js).
export default function Header () {
  return (
    <div className='qh-wrap'>
      <header className='qh'>
        <Link href='/' className='brand qh-brand' aria-label='Quilt home'><Mark /></Link>
        <HeaderNav />
        <div className='qh-right'>
          <AuthLink />
          <HeaderDownload />
        </div>
      </header>
    </div>
  )
}
