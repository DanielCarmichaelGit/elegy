import Notice from '@/components/Notice.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgMe } from '@/lib/org.js'
import { allowed, peopleNotIn } from '@/lib/org-view.js'
import { createTeam, renameTeam, deleteTeam, addToTeam, setTeamAccess, removeFromTeam } from './actions.js'

export const metadata = { title: 'Teams' }

function Hidden ({ slug, id, memberId }) {
  return (
    <>
      <input type='hidden' name='slug' value={slug} />
      {id && <input type='hidden' name='id' value={id} />}
      {memberId && <input type='hidden' name='memberId' value={memberId} />}
    </>
  )
}

function AccessSelect ({ value }) {
  return (
    <select className='input' name='access' defaultValue={value} aria-label='Access'>
      <option value='editor'>Editor</option>
      <option value='viewer'>Viewer</option>
    </select>
  )
}

export default async function Teams ({ params, searchParams }) {
  const { slug } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}/teams`)
  const me = await orgMe(user.accessToken, slug)
  const r = await apiCall(user, 'GET', `/v1/orgs/${slug}/teams`)
  const teams = r.data?.teams || []
  const people = r.data?.people || null
  const c = (resource, op) => allowed(me, resource, op)
  return (
    <div className='stack'>
      <Notice q={q} />
      {!r.ok && <p className='notice bad'>Couldn't load teams right now.</p>}
      {r.ok && !teams.length && <p className='muted'>{c('teams', 'c') ? 'No teams yet. Make one below.' : "You're not in any teams yet."}</p>}
      {teams.map((t) => {
        const addable = people ? peopleNotIn(people, t.members) : []
        return (
          <section key={t.id} className='card stack'>
            <div className='row' style={{ justifyContent: 'space-between' }}>
              {c('teams', 'u')
                ? (
                  <form action={renameTeam} className='row'>
                    <Hidden slug={slug} id={t.id} />
                    <input className='input' name='name' defaultValue={t.name} maxLength={60} aria-label='Team name' />
                    <button className='btn ghost'>Rename</button>
                  </form>)
                : <h3>{t.name}</h3>}
              <span className='row'>
                {t.access && <span className='pill'>You: {t.access}</span>}
                {c('teams', 'd') && <form action={deleteTeam}><Hidden slug={slug} id={t.id} /><button className='btn ghost danger'>Delete team</button></form>}
              </span>
            </div>
            {t.members === null
              ? <p className='muted'>You can't see who's in this team.</p>
              : t.members.length
                ? (
                  <div>
                    {t.members.map((m) => (
                      <div key={m.memberId} className='list-row'>
                        <span>
                          <b>{m.name}</b> {m.kind === 'agent' && <span className='pill'>Agent</span>}
                          {m.scopes?.length > 0 && <span className='muted'> · folders {m.scopes.join(', ')}</span>}
                        </span>
                        <span className='row'>
                          {c('team_members', 'u')
                            ? (
                              <form action={setTeamAccess} className='row'>
                                <Hidden slug={slug} id={t.id} memberId={m.memberId} />
                                <AccessSelect value={m.access} />
                                <button className='btn ghost'>Save</button>
                              </form>)
                            : <span className='pill'>{m.access}</span>}
                          {c('team_members', 'd') && (
                            <form action={removeFromTeam}><Hidden slug={slug} id={t.id} memberId={m.memberId} /><button className='btn ghost danger'>Remove</button></form>)}
                        </span>
                      </div>))}
                  </div>)
                : <p className='muted'>No one in this team yet.</p>}
            {addable.length > 0 && (
              <form action={addToTeam} className='row'>
                <Hidden slug={slug} id={t.id} />
                <select className='input' name='memberId' aria-label='Person to add'>
                  {addable.map((p) => <option key={p.memberId} value={p.memberId}>{p.kind === 'agent' ? `${p.name} (agent)` : p.name}</option>)}
                </select>
                <AccessSelect value='viewer' />
                <button className='btn'>Add to team</button>
              </form>)}
          </section>
        )
      })}
      {c('teams', 'c') && (
        <form action={createTeam} className='card row'>
          <Hidden slug={slug} />
          <input className='input' name='name' maxLength={60} placeholder='New team name' aria-label='New team name' required style={{ flex: '1 1 220px' }} />
          <button className='btn primary'>Create team</button>
        </form>)}
    </div>
  )
}
