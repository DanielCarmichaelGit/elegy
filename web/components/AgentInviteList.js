import { when } from '@/lib/org-view.js'
import { inviteStatusText } from '@/lib/agent-view.js'

// Recent agent invites: who used them, and Cancel for the ones still waiting.
export default function AgentInviteList ({ invites, cancel, slug }) {
  if (!invites?.length) return null
  return (
    <div>
      {invites.map((i) => (
        <div key={i.id} className='list-row'>
          <span>
            <b>{inviteStatusText(i)}</b>
            <br />
            <span className='muted'>
              Made {when(i.createdAt)}
              {i.status === 'waiting' && ` · expires ${when(i.expiresAt)}`}
              {i.role && ` · role ${i.role}`}
              {i.teams.length > 0 && ` · ${i.teams.map((t) => `${t.name} (${t.access})`).join(', ')}`}
            </span>
          </span>
          {i.status === 'waiting' && (
            <form action={cancel}>
              {slug && <input type='hidden' name='slug' value={slug} />}
              <input type='hidden' name='id' value={i.id} />
              <button className='btn ghost danger'>Cancel</button>
            </form>)}
        </div>))}
    </div>
  )
}
