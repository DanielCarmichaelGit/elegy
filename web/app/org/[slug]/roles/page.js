import { notFound } from 'next/navigation'
import Notice from '@/components/Notice.js'
import RoleGrid from '@/components/RoleGrid.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgMe } from '@/lib/org.js'
import { allowed } from '@/lib/org-view.js'
import { isSubset } from '@/lib/permissions.js'
import { createRole, saveRole, deleteRole } from './actions.js'

export const metadata = { title: 'Roles' }

export default async function Roles ({ params, searchParams }) {
  const { slug } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}/roles`)
  const me = await orgMe(user.accessToken, slug)
  if (!allowed(me, 'roles', 'r')) notFound()
  const r = await apiCall(user, 'GET', `/v1/orgs/${slug}/roles`)
  const roles = r.data?.roles || []
  // You can only edit roles whose checkboxes you hold yourself.
  const editable = (role) => allowed(me, 'roles', 'u') && (me.isOwner || isSubset(role.grants, me.grants))
  return (
    <div className='stack'>
      <Notice q={q} />
      {!r.ok && <p className='notice bad'>Couldn't load roles right now.</p>}
      {roles.map((role) => role.builtin === 'owner'
        ? (
          <section key={role.id} className='card stack'>
            <h3>Owner</h3>
            <p className='muted'>Every permission, plus transferring and deleting the org. There's exactly one owner, and this role can't be edited.</p>
          </section>)
        : (
          <form key={role.id} action={saveRole} className='card stack'>
            <input type='hidden' name='slug' value={slug} />
            <input type='hidden' name='id' value={role.id} />
            <div className='row' style={{ justifyContent: 'space-between' }}>
              {role.builtin || !editable(role)
                ? <h3>{role.name}</h3>
                : <input className='input' name='name' defaultValue={role.name} maxLength={40} aria-label='Role name' />}
              {role.builtin && <span className='pill'>Built in</span>}
            </div>
            <div className='table-scroll'><RoleGrid grants={role.grants} mine={me.grants} isOwner={me.isOwner} readOnly={!editable(role)} /></div>
            {editable(role) && (
              <div className='row'>
                <button className='btn primary'>Save</button>
                {allowed(me, 'roles', 'd') && !role.builtin && <button className='btn ghost danger' formAction={deleteRole}>Delete role</button>}
              </div>)}
          </form>))}
      {allowed(me, 'roles', 'c') && (
        <form action={createRole} className='card stack'>
          <h3>New role</h3>
          <input type='hidden' name='slug' value={slug} />
          <div className='field'>
            <label htmlFor='new-role'>Name</label>
            <input className='input' id='new-role' name='name' maxLength={40} required />
          </div>
          <div className='table-scroll'><RoleGrid grants={{}} mine={me.grants} isOwner={me.isOwner} /></div>
          <div><button className='btn primary'>Create role</button></div>
        </form>)}
    </div>
  )
}
