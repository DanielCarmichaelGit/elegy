import { notFound } from 'next/navigation'
import Notice from '@/components/Notice.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgMe } from '@/lib/org.js'
import { allowed } from '@/lib/org-view.js'
import { saveSettings, transferOwnership, deleteOrg } from './actions.js'

export const metadata = { title: 'Org settings' }

export default async function Settings ({ params, searchParams }) {
  const { slug } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}/settings`)
  const me = await orgMe(user.accessToken, slug)
  if (!allowed(me, 'org', 'r')) notFound()
  const canEdit = allowed(me, 'org', 'u')
  const others = me.isOwner
    ? ((await apiCall(user, 'GET', `/v1/orgs/${slug}/members`)).data?.members || []).filter((m) => !m.isYou && m.userId)
    : []
  // A neutral example: the web side has no public-mail-domain list to check the
  // viewer's own domain against, so it never suggests theirs as the org's domain.
  const domainPlaceholder = 'yourcompany.com'
  return (
    <div className='stack'>
      <Notice q={q} />
      <form action={saveSettings} className='card stack'>
        <h3>Org settings</h3>
        <input type='hidden' name='slug' value={slug} />
        <fieldset disabled={!canEdit} className='stack' style={{ border: 0, padding: 0, margin: 0 }}>
          <div className='field'>
            <label htmlFor='org-name'>Name</label>
            <input className='input' id='org-name' name='name' defaultValue={me.org.name} maxLength={80} required />
          </div>
          <div className='field'>
            <label htmlFor='org-domain'>Email domain</label>
            <input className='input' id='org-domain' name='domain' defaultValue={me.org.domain || ''} placeholder={domainPlaceholder} />
          </div>
          <label className='row'><input type='checkbox' name='domainRequests' defaultChecked={me.org.domainRequests} /> Let people with a confirmed email at this domain ask to join</label>
          <p className='muted'>The domain can only be your own confirmed email's domain, never a public one like gmail.com. Someone who can send invites approves each request.</p>
          {canEdit && <div><button className='btn primary'>Save</button></div>}
        </fieldset>
      </form>
      {me.isOwner && (
        <>
          <form action={transferOwnership} className='card stack'>
            <h3>Transfer ownership</h3>
            <input type='hidden' name='slug' value={slug} />
            <p className='muted'>The new owner gets every permission and you become an Admin. There is only ever one owner.</p>
            {others.length
              ? (
                <div className='row'>
                  <select className='input' name='memberId' aria-label='New owner'>
                    {others.map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
                  </select>
                  <input className='input' name='confirm' placeholder={`Type ${slug}`} aria-label={`Type ${slug} to confirm`} required />
                  <button className='btn'>Transfer</button>
                </div>)
              : <p className='muted'>Invite someone first.</p>}
          </form>
          <form action={deleteOrg} className='card stack'>
            <h3>Delete this org</h3>
            <input type='hidden' name='slug' value={slug} />
            <p className='muted'>This removes its roles, teams, members and invites. People keep their own accounts.</p>
            <div className='row'>
              <input className='input' name='confirm' placeholder={`Type ${slug}`} aria-label={`Type ${slug} to confirm`} />
              <button className='btn danger'>Delete org</button>
            </div>
          </form>
        </>)}
    </div>
  )
}
