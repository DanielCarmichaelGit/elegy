import Link from 'next/link'
import Mark from './Mark.js'

export default function Header ({ signedIn = false }) {
  return (
    <header className='wrap site-header'>
      <Link href='/' className='brand' aria-label='Quilt home'><Mark /></Link>
      <nav>
        <Link className='btn ghost' href='/pricing'>Pricing</Link>
        {signedIn
          ? <Link className='btn' href='/dashboard'>Dashboard</Link>
          : <Link className='btn' href='/signin'>Sign in</Link>}
      </nav>
    </header>
  )
}
