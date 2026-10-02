import AppHeader from '@/components/AppHeader.js'
import Notice from '@/components/Notice.js'
import ConfirmDelete from '@/components/ConfirmDelete.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { describeType, foldersText } from '@/lib/access-form.js'
import { createAccessType, saveAccessType, deleteAccessType } from './actions.js'

export const metadata = { title: 'Access types' }

/** The fields of a type's form, filled in from `t` (empty for a new one). */
function Fields ({ t = {}, id }) {
  return (
    <>
      <div className='field'>
        <label htmlFor={`${id}-name`}>Name</label>
        <input className='input' id={`${id}-name`} name='name' defaultValue={t.name || ''} maxLength={40} required />
      </div>
      <div className='field'>
        <label htmlFor={`${id}-files`}>Files</label>
        <select className='input' id={`${id}-files`} name='files' defaultValue={t.files || 'edit'}>
          <option value='edit'>Can edit</option>
          <option value='view'>View only</option>
        </select>
      </div>
      <div className='field'>
        <label htmlFor={`${id}-folders`}>Folders</label>
        <textarea className='input textarea' id={`${id}-folders`} name='folders' rows={3} defaultValue={foldersText(t.folders)} placeholder='All folders' />
        <span className='muted small'>One per line, like src or docs. Leave empty for every folder.</span>
      </div>
      <label className='row switch'>
        <input type='checkbox' role='switch' name='talk' defaultChecked={t.talk !== false} /> May chat and post to the feed
      </label>
    </>
  )
}

export default async function AccessTypes ({ searchParams }) {
  const q = await searchParams
  const user = await requireUser('/dashboard/access')
  const r = await apiCall(user, 'GET', '/v1/access-types')
  const types = r.data?.types || []
  const own = types.filter((t) => !t.builtin)
  return (
    <>
      <AppHeader user={user} space='personal' />
      <main className='wrap page stack'>
        <h1 style={{ fontSize: 32 }}>Access types</h1>
        <p className='muted'>What someone may do in a session: edit or only view, which folders, and whether they may chat and post to the feed. In the Quilt app, you let people in and invite them as one of these. In a session you can narrow someone's access further, but never past their type.</p>
        <Notice q={q} />
        {!r.ok && <p className='notice bad'>Couldn't load your access types right now.</p>}
        <section className='card stack'>
          <h2>Your access types</h2>
          {types.filter((t) => t.builtin).map((t) => (
            <div key={t.id} className='list-row'>
              <span><b>{t.name}</b> <span className='pill'>Built in</span><br /><span className='muted'>{describeType(t)}</span></span>
            </div>))}
          {own.map((t) => (
            <details key={t.id} className='list-row access-type'>
              <summary><span><b>{t.name}</b><br /><span className='muted'>{describeType(t)}</span></span><span className='btn ghost'>Edit</span></summary>
              <form action={saveAccessType} className='stack fields-narrow'>
                <input type='hidden' name='id' value={t.id} />
                <Fields t={t} id={t.id} />
                <div className='row'>
                  <button className='btn primary'>Save</button>
                  <ConfirmDelete action={deleteAccessType} what={t.name} note='People who have it get View only.' />
                </div>
              </form>
            </details>))}
          {r.ok && !own.length && <p className='muted'>No access types of your own yet. Make one below.</p>}
        </section>
        <form action={createAccessType} className='card stack fields-narrow'>
          <h2>New access type</h2>
          <Fields id='new' />
          <div><button className='btn primary'>Create access type</button></div>
        </form>
      </main>
    </>
  )
}
