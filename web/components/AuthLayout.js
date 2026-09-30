import Link from 'next/link'
import Mark from './Mark.js'

const ico = (d) => <svg viewBox='0 0 24 24' width='18' height='18' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>{d}</svg>

// Three quick reasons, so the panel explains Quilt at a glance.
const REASONS = [
  { title: 'Your folder, synced live', text: 'Edits land on everyone\'s computer as you make them.', tone: 'a', icon: ico(<><path d='M21 12a9 9 0 0 1-15.5 6.2L3 16' /><path d='M3 12a9 9 0 0 1 15.5-6.2L21 8' /><path d='M21 3v5h-5' /><path d='M3 21v-5h5' /></>) },
  { title: 'Watch each other\'s AI', text: 'See every prompt and change your partner\'s AI makes.', tone: 'c', icon: ico(<><path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z' /><circle cx='12' cy='12' r='3' /></>) },
  { title: 'Agents join as teammates', text: 'Bring AI agents into a session with their own seat.', tone: 'b', icon: ico(<><path d='M12 3v4M12 17v4M3 12h4M17 12h4' /><path d='m6 6 2 2M16 16l2 2M6 18l2-2M16 8l2-2' /></>) }
]

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
          <div className='auth-card'>
            <p className='auth-tagline'>Build together, live. Everyone in their own AI.</p>
            <ul className='auth-reasons'>
              {REASONS.map((r) => (
                <li key={r.title}>
                  <span className={`auth-ico ${r.tone}`} aria-hidden='true'>{r.icon}</span>
                  <span><b>{r.title}</b><small>{r.text}</small></span>
                </li>
              ))}
            </ul>
            {caption && <p className='auth-caption'>{caption}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
