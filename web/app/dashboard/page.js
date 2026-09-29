import { headers } from 'next/headers'
import Header from '@/components/Header.js'
import NewAgent from '@/components/NewAgent.js'
import { requireUser } from '@/lib/session.js'
import { createClient } from '@/lib/supabase/server.js'
import { apiCall } from '@/lib/api.js'
import { downloadFor, DOWNLOADS } from '@/lib/platform.js'
import { unlinkComputer, revokeAgent } from './actions.js'

export const metadata = { title: 'Dashboard' }
const PLATFORMS = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' }
// Renders on the server (UTC on Netlify), so pin the zone and label it rather than showing an unlabelled local time
const when = (t) => (t ? new Date(t).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC', timeZoneName: 'short' }) : 'never')

export default async function Dashboard ({ searchParams }) {
  const q = await searchParams
  const user = await requireUser('/dashboard')
  const supabase = await createClient()
  // Name the columns: secret columns (token_hash) aren't granted to signed-in people.
  const { data: computers } = await supabase.from('devices').select('id, name, platform, last_seen_at, revoked_at').is('revoked_at', null).order('last_seen_at', { ascending: false })
  const agentsRes = await apiCall(user, 'GET', '/v1/agents')
  const agents = (agentsRes.data?.agents || []).filter((a) => !a.revokedAt)
  const ua = (await headers()).get('user-agent') || ''
  const download = downloadFor(ua) || DOWNLOADS.macArm
  return (
    <>
      <Header signedIn />
      <main className='wrap page stack'>
        <div className='row' style={{ justifyContent: 'space-between' }}>
          <h1 style={{ fontSize: 32 }}>Dashboard</h1>
          <div className='row'>
            <a className='btn ghost' href='/settings'>Settings</a>
            <form action='/auth/signout' method='post'><button className='btn ghost'>Sign out</button></form>
          </div>
        </div>
        {q.password && <p className='notice'>Password updated.</p>}
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
          <p className='muted'>Coming soon: agents will be able to join sessions as their own members, with an agent badge.</p>
          {!agentsRes.ok && <p className='notice bad'>Couldn’t load your agents right now.</p>}
          {agents.map((a) => (
            <div key={a.id} className='row' style={{ justifyContent: 'space-between' }}>
              <span><b>{a.name}</b> <span className='muted mono'>{a.keyPrefix}…</span> <span className='muted'>· last used {when(a.lastUsedAt)}</span></span>
              <form action={revokeAgent}><input type='hidden' name='id' value={a.id} /><button className='btn ghost danger'>Revoke</button></form>
            </div>))}
          <NewAgent />
        </section>
      </main>
    </>
  )
}
