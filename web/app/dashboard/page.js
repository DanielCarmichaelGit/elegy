import { headers, cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Header from '@/components/Header.js'
import FirstOrg from '@/components/FirstOrg.js'
import SpaceSwitcher from '@/components/SpaceSwitcher.js'
import AgentInvite from '@/components/AgentInvite.js'
import AgentInviteList from '@/components/AgentInviteList.js'
import { requireUser } from '@/lib/session.js'
import { createClient } from '@/lib/supabase/server.js'
import { apiCall } from '@/lib/api.js'
import { myOrgs } from '@/lib/org.js'
import { SPACE_COOKIE, spaceHome } from '@/lib/space.js'
import { safeMessage, when } from '@/lib/org-view.js'
import { agentStatus, AGENT_JOIN_COMMAND } from '@/lib/agent-view.js'
import { downloadFor, DOWNLOADS } from '@/lib/platform.js'
import { unlinkComputer, revokeAgent, askToJoin, createAgentInvite, cancelAgentInvite } from './actions.js'

export const metadata = { title: 'Dashboard' }
const PLATFORMS = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' }

export default async function Dashboard ({ searchParams }) {
  const q = await searchParams
  const user = await requireUser('/dashboard')
  const orgs = await myOrgs(user.accessToken)
  // Come back to the space the person chose last, if they're still in it.
  const home = spaceHome((await cookies()).get(SPACE_COOKIE)?.value, orgs)
  if (home !== '/dashboard') redirect(home)
  const supabase = await createClient()
  // Name the columns: secret columns (token_hash) aren't granted to signed-in people.
  // Independent calls, so they run together rather than one after another.
  const [{ data: computers }, agentsRes, invitesRes, discover, { data: profile }] = await Promise.all([
    supabase.from('devices').select('id, name, platform, last_seen_at, revoked_at').is('revoked_at', null).order('last_seen_at', { ascending: false }),
    apiCall(user, 'GET', '/v1/agents'),
    apiCall(user, 'GET', '/v1/agent-invites'),
    // Orgs on the person's own (confirmed, non-public) email domain that take join requests.
    apiCall(user, 'GET', '/v1/orgs/discover'),
    // Only an org account ever gets a FirstOrg card, even if a personal account somehow has stray org_name metadata.
    supabase.from('profiles').select('kind').eq('id', user.id).maybeSingle()
  ])
  // The API lists only agents that aren't revoked.
  const agents = agentsRes.data?.agents || []
  const invites = (invitesRes.data?.invites || []).slice(0, 10)
  const joinable = discover.data?.orgs || []
  const ua = (await headers()).get('user-agent') || ''
  const download = downloadFor(ua) || DOWNLOADS.macArm
  return (
    <>
      <Header signedIn />
      <main className='wrap page stack'>
        <div className='row' style={{ justifyContent: 'space-between' }}>
          <h1 style={{ fontSize: 32 }}>Dashboard</h1>
          <div className='row'>
            <SpaceSwitcher orgs={orgs} current='personal' />
            <a className='btn ghost' href='/settings'>Settings</a>
            <form action='/auth/signout' method='post'><button className='btn ghost'>Sign out</button></form>
          </div>
        </div>
        {q.password && <p className='notice'>Password updated.</p>}
        {q.left && <p className='notice'>You left the org.</p>}
        {q.orgDeleted && <p className='notice'>The org was deleted.</p>}
        {!orgs.length && user.orgName && profile?.kind === 'org' && <FirstOrg name={user.orgName} />}
        {q.asked && <p className='notice'>Asked. Someone at the org will let you in.</p>}
        {q.error && <p className='notice bad'>{safeMessage(q.error)}</p>}
        {joinable.length > 0 && (
          <section className='card stack'>
            <h2>Orgs at {discover.data.domain}</h2>
            {joinable.map((o) => (
              <div key={o.slug} className='list-row'>
                <b>{o.name}</b>
                {o.requested
                  ? <span className='pill'>Requested</span>
                  : <form action={askToJoin}><input type='hidden' name='slug' value={o.slug} /><button className='btn'>Ask to join</button></form>}
              </div>))}
          </section>)}
        <section className='card stack'>
          <div className='row' style={{ justifyContent: 'space-between' }}>
            <h2>Your computers</h2>
            <a className='btn ghost' href={download.href}>{download.label}</a>
          </div>
          {computers?.length
            ? computers.map((c) => (
              <div key={c.id} className='row' style={{ justifyContent: 'space-between' }}>
                <span><b>{c.name}</b> {PLATFORMS[c.platform] && <span className='pill'>{PLATFORMS[c.platform]}</span>} <span className='muted'>· last seen {when(c.last_seen_at)}</span></span>
                <form action={unlinkComputer}><input type='hidden' name='id' value={c.id} /><button className='btn ghost danger'>Unlink</button></form>
              </div>))
            : <p className='muted'>No computers yet. Open the Quilt app and choose <b>Sign in</b>.</p>}
        </section>
        <section className='card stack'>
          <h2>Your agents</h2>
          {!agentsRes.ok && <p className='notice bad'>Could not load your agents right now.</p>}
          {agentsRes.ok && !agents.length && <p className='muted'>No agents yet.</p>}
          {agents.length > 0 && (
            <div>
              {agents.map((a) => {
                const s = agentStatus(a.status)
                return (
                  <div key={a.id} className='list-row'>
                    <span>
                      <b>{a.name}</b> <span className='pill'>Agent</span> {s && <span className='pill'>{s.label}</span>}
                      <br />
                      <span className='muted'>{a.provider} · {a.type}{a.description ? ` · ${a.description}` : ''}</span>
                      <br />
                      <span className='muted'>{s ? s.why : `Added ${when(a.createdAt)} · last used ${when(a.lastUsedAt)}`}</span>
                    </span>
                    <form action={revokeAgent}><input type='hidden' name='id' value={a.id} /><button className='btn ghost danger'>Revoke</button></form>
                  </div>)
              })}
            </div>)}
          <div className='stack'>
            <h3>Invite an agent</h3>
            <p className='muted'>Make a one-time link and paste it into your AI (Claude Code, Cursor, ChatGPT and others). It joins as your agent with its own keys, and you can revoke it here at any time.</p>
            <AgentInvite action={createAgentInvite} />
            <AgentInviteList invites={invites} cancel={cancelAgentInvite} />
            <p className='muted'>From a terminal: <code>{AGENT_JOIN_COMMAND}</code></p>
          </div>
        </section>
      </main>
    </>
  )
}
