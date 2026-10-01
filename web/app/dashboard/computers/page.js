import { headers } from 'next/headers'
import AppHeader from '@/components/AppHeader.js'
import { requireUser } from '@/lib/session.js'
import { createClient } from '@/lib/supabase/server.js'
import { when } from '@/lib/org-view.js'
import { downloadFor, DOWNLOADS } from '@/lib/platform.js'
import { unlinkComputer } from '../actions.js'

export const metadata = { title: 'Computers' }
const PLATFORMS = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' }

export default async function Computers () {
  const user = await requireUser('/dashboard/computers')
  const supabase = await createClient()
  // Name the columns: secret columns (token_hash) aren't granted to signed-in people.
  const { data: computers } = await supabase.from('devices').select('id, name, platform, last_seen_at, revoked_at').is('revoked_at', null).order('last_seen_at', { ascending: false })
  const download = downloadFor((await headers()).get('user-agent') || '') || DOWNLOADS.macArm
  return (
    <>
      <AppHeader user={user} space='personal' />
      <main className='wrap page stack'>
        <h1 style={{ fontSize: 32 }}>Computers</h1>
        <section className='card stack'>
          <div className='row' style={{ justifyContent: 'space-between' }}>
            <h2>Your computers</h2>
            <a className='btn ghost' href={download.href}>{download.label}</a>
          </div>
          {computers?.length
            ? computers.map((c) => (
              <div key={c.id} className='list-row'>
                <span><b>{c.name}</b> {PLATFORMS[c.platform] && <span className='pill'>{PLATFORMS[c.platform]}</span>} <span className='muted'>· last seen {when(c.last_seen_at)}</span></span>
                <form action={unlinkComputer}><input type='hidden' name='id' value={c.id} /><button className='btn ghost danger'>Unlink</button></form>
              </div>))
            : <p className='muted'>No computers yet. Open the Quilt app and choose <b>Sign in</b>.</p>}
        </section>
      </main>
    </>
  )
}
