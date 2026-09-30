import { notFound } from 'next/navigation'
import Notice from '@/components/Notice.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgMe } from '@/lib/org.js'
import { allowed, assignableRoles } from '@/lib/org-view.js'
import { setRole, removeMember } from './actions.js'
import { leaveOrg } from '../actions.js'

export const metadata = { title: 'People' }

export default async function People ({ params, searchParams }) {
  const { slug } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}/people`)
  const me = await orgMe(user.accessToken, slug)
  if (!allowed(me, 'members', 'r')) notFound()
  // Changing someone's role is Members: Update together with Roles: Update.
  const canAssign = allowed(me, 'members', 'u') && allowed(me, 'roles', 'u')
  const canRemove = allowed(me, 'members', 'd')
  const [membersRes, rolesRes] = await Promise.all([
    apiCall(user, 'GET', `/v1/orgs/${slug}/members`),
    canAssign ? apiCall(user, 'GET', `/v1/orgs/${slug}/roles`) : null
  ])
  const members = membersRes.data?.members || []
  const roles = assignableRoles(rolesRes?.data?.roles, me)
  return (
    <section className='card stack'>
      <h2>People</h2>
      <Notice q={q} />
      {!membersRes.ok && <p className='notice bad'>Couldn't load the member list right now.</p>}
      <div>
        {members.map((m) => (
          <div key={m.id} className='list-row'>
            <span>
              <b>{m.name || m.email}</b> {m.isYou && <span className='pill'>You</span>} {m.isOwner && <span className='pill'>Owner</span>}
              <br />
              <span className='muted'>{m.email}{m.teams.length ? ` · ${m.teams.map((t) => t.name).join(', ')}` : ''}</span>
            </span>
            <span className='row'>
              {canAssign && !m.isOwner && !m.isYou && roles.some((r) => r.id === m.roleId)
                ? (
                  <form action={setRole} className='row'>
                    <input type='hidden' name='slug' value={slug} />
                    <input type='hidden' name='id' value={m.id} />
                    <select className='input' name='roleId' defaultValue={m.roleId} aria-label={`Role for ${m.name || m.email}`}>
                      {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                    <button className='btn ghost'>Save</button>
                  </form>)
                : <span className='pill'>{m.role || 'No role'}</span>}
              {m.isYou && !m.isOwner && (
                <form action={leaveOrg}><input type='hidden' name='slug' value={slug} /><button className='btn ghost danger'>Leave</button></form>)}
              {canRemove && !m.isYou && !m.isOwner && (
                <form action={removeMember}>
                  <input type='hidden' name='slug' value={slug} />
                  <input type='hidden' name='id' value={m.id} />
                  <button className='btn ghost danger'>Remove</button>
                </form>)}
            </span>
          </div>))}
      </div>
    </section>
  )
}
