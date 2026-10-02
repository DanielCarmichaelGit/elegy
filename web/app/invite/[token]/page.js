import AppHeader from '@/components/AppHeader.js'
import Notice from '@/components/Notice.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { inviteGone, isInviteToken } from '@/lib/org-view.js'
import { acceptInvite } from './actions.js'

export const metadata = { title: 'Join an org' }

export default async function Invite ({ params, searchParams }) {
  const { token } = await params
  const q = await searchParams
  const user = await requireUser(`/invite/${encodeURIComponent(token)}`)
  // A malformed token can never match a real invite, so don't waste an API call on it.
  const r = isInviteToken(token) ? await apiCall(user, 'GET', `/v1/invites/${encodeURIComponent(token)}`) : { ok: false, status: 404, data: null }
  const inv = r.ok ? r.data : null
  const forMe = inv && String(user.email || '').toLowerCase() === inv.email
  let body
  if (!inv) {
    body = <><h2>That invite link does not work</h2><p className='muted'>{r.status === 429 ? 'Too many tries. Wait a minute and reload.' : 'Check the link in your email, or ask for a new invite.'}</p></>
  } else if (inv.status !== 'pending') {
    body = <><h2>{inv.org.name}</h2><p className='muted'>{inviteGone(inv.status)}</p></>
  } else if (!forMe) {
    body = (
      <>
        <h2>Join {inv.org.name}</h2>
        <p>This invite is for <b>{inv.email}</b>, but you are signed in as <b>{user.email}</b>.</p>
        <p className='muted'>Sign out, then open the link from your email again and sign in with {inv.email}.</p>
        <form action='/auth/signout' method='post'><button className='btn'>Sign out</button></form>
      </>
    )
  } else {
    body = (
      <>
        <h2>Join {inv.org.name}</h2>
        <p className='muted'>You will join as <b>{inv.role}</b>.</p>
        <Notice q={q} />
        <form action={acceptInvite}>
          <input type='hidden' name='token' value={token} />
          <button className='btn primary'>Join {inv.org.name}</button>
        </form>
      </>
    )
  }
  return (
    <>
      <AppHeader user={user} />
      <main className='wrap page stack'>
        <h1 style={{ fontSize: 32 }}>Join an org</h1>
        <section className='card stack'>{body}</section>
      </main>
    </>
  )
}
