import Link from 'next/link'
import Mark from './Mark.js'

// The 50/50 layout shared by /signin, /signup, /signup/org, /forgot and /reset: the form
// on the left (untouched, just wrapped), and a brand panel on the right. No site Header here,
// just a minimal top with the wordmark linking home.
export default function AuthLayout ({ children, caption }) {
  return (
    <div className='auth-shell'>
      <div className='auth-form-col'>
        <div className='auth-top'>
          <Link href='/' className='brand' aria-label='Quilt home'><Mark /></Link>
        </div>
        <div className='auth-form-wrap'>{children}</div>
        <p className='auth-foot muted'><Link href='/'>Back to Quilt</Link></p>
      </div>
      <div className='auth-brand-col'>
        <div className='quilt-patch' aria-hidden='true' />
        <div className='quilt-stitch' aria-hidden='true' />
        <div className='auth-brand-inner'>
          <div className='qwin auth-shot'>
            <div className='qwin-bar'><i /><i /><i /><span>quilt · landing-page (shared with Sam)</span></div>
            {/* eslint-disable-next-line @next/next/no-img-element -- fixed local screenshot, plain img keeps this simple */}
            <img className='qwin-shot' src='/shots/session.png' alt='' width={1600} height={1000} />
          </div>
          <div className='auth-copy'>
            <p className='auth-tagline'>Build together, live. Everyone in their own AI.</p>
            {caption && <p className='auth-caption'>{caption}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
