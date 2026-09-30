import { notFound } from 'next/navigation'
import Notice from '@/components/Notice.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgMe } from '@/lib/org.js'
import { allowed, assignableRoles, when } from '@/lib/org-view.js'
import { sendInvite, resendInvite, cancelInvite, approveRequest, denyRequest } from './actions.js'

export const metadata = { title: 'Invites' }

export default async function Invites ({ params, searchParams }) {
  const { slug } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}/invites`)
  const me = await orgMe(user.accessToken, slug)
  if (!allowed(me, 'invites', 'r')) notFound()
  const canInvite = allowed(me, 'invites', 'c')
  const [r, rolesRes] = await Promise.all([
    apiCall(user, 'GET', `/v1/orgs/${slug}/invites`),
    canInvite ? apiCall(user, 'GET', `/v1/orgs/${slug}/roles`) : null
  ])
  const invites = r.data?.invites || []
  const requests = r.data?.requests || []
  const roles = assignableRoles(rolesRes?.data?.roles, me)
  const memberRole = roles.find((x) => x.builtin === 'member')?.id
  const roleSelect = () => (
    <select className='input' name='roleId' defaultValue={memberRole} aria-label='Role'>
      {roles.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
    </select>
  )
  const hidden = (id) => <><input type='hidden' name='slug' value={slug} /><input type='hidden' name='id' value={id} /></>
  return (
    <div className='stack'>
      <Notice q={q} />
      {!r.ok && <p className='notice bad'>Could not load invites right now.</p>}
      {canInvite && (
        <form action={sendInvite} className='card stack'>
          <h3>Invite someone</h3>
          <input type='hidden' name='slug' value={slug} />
          <div className='row'>
            <input className='input' name='email' type='email' placeholder='name@company.com' aria-label='Email' required style={{ flex: '1 1 240px' }} />
            {roleSelect()}
            <button className='btn primary'>Send invite</button>
          </div>
          <p className='muted'>They get an email with a link that works for 7 days, and join by signing in with that address.</p>
        </form>)}
      <section className='card stack'>
        <h3>Pending invites</h3>
        {invites.length
          ? (
            <div>
              {invites.map((i) => (
                <div key={i.id} className='list-row'>
                  <span><b>{i.email}</b> <span className='pill'>{i.role}</span> <span className='muted'>· {i.expired ? 'expired' : `expires ${when(i.expiresAt)}`}</span></span>
                  <span className='row'>
                    {allowed(me, 'invites', 'u') && <form action={resendInvite}>{hidden(i.id)}<button className='btn ghost'>Resend</button></form>}
                    {allowed(me, 'invites', 'd') && <form action={cancelInvite}>{hidden(i.id)}<button className='btn ghost danger'>Cancel</button></form>}
                  </span>
                </div>))}
            </div>)
          : <p className='muted'>No pending invites.</p>}
      </section>
      <section className='card stack'>
        <h3>Requests to join</h3>
        {requests.length
          ? (
            <div>
              {requests.map((x) => (
                <form key={x.id} action={approveRequest} className='list-row'>
                  {hidden(x.id)}
                  <span><b>{x.name || x.email}</b> <span className='muted'>{x.email}</span></span>
                  <span className='row'>
                    {canInvite && <>{roleSelect()}<button className='btn'>Approve</button></>}
                    {allowed(me, 'invites', 'd') && <button className='btn ghost danger' formAction={denyRequest}>Deny</button>}
                  </span>
                </form>))}
            </div>)
          : <p className='muted'>{me.org.domainRequests ? 'No one is waiting.' : 'People on your email domain can ask to join once it is turned on in Settings.'}</p>}
      </section>
    </div>
  )
}
