import AppHeader from '@/components/AppHeader.js'
import { requireUser } from '@/lib/session.js'
import { createClient } from '@/lib/supabase/server.js'
import { TOOLS } from '@/lib/tools.js'
import { saveProfile, signOutEverywhere, deleteAccount } from './actions.js'

export const metadata = { title: 'Settings' }
const ERRORS = { profile: 'Check your name, colour and tool.', confirm: 'Type delete to confirm.', delete: 'Couldn’t delete your account. Try again.', signout: 'Couldn’t sign out your computers. Try again.' }

export default async function Settings ({ searchParams }) {
  const q = await searchParams
  const user = await requireUser('/settings')
  const supabase = await createClient()
  const { data: p } = await supabase.from('profiles').select('id, name, color, tool').eq('id', user.id).single()
  const providers = [...new Set(user.identities.map((i) => i.provider))]
  return (
    <>
      <AppHeader user={user} />
      <main className='wrap page stack' style={{ maxWidth: 640 }}>
        <h1 style={{ fontSize: 32 }}>Settings</h1>
        {q.saved && <p className='notice'>Saved. Your computers pick this up next time they check in.</p>}
        {q.error && <p className='notice bad'>{ERRORS[q.error] || 'Something went wrong.'}</p>}
        <form action={saveProfile} className='card stack'>
          <h2>Profile</h2>
          <div className='field'><label htmlFor='name'>Name</label><input className='input' id='name' name='name' defaultValue={p?.name || ''} maxLength={60} required /></div>
          <div className='row'>
            <div className='field'><label htmlFor='color'>Colour</label><input className='input' id='color' name='color' type='color' defaultValue={p?.color || '#C4472F'} style={{ width: 64, padding: 4 }} /></div>
            <div className='field' style={{ flex: 1 }}><label htmlFor='tool'>AI tool</label>
              <select className='input' id='tool' name='tool' defaultValue={p?.tool || 'Claude Code'}>{TOOLS.map((t) => <option key={t}>{t}</option>)}</select>
            </div>
          </div>
          <div><button className='btn primary'>Save</button></div>
        </form>
        <section className='card stack'>
          <h2>Account</h2>
          <p>{user.email} <span className='muted'>· signs in with {providers.join(', ') || 'email'}</span></p>
          <p><a href='/reset'>Change password</a></p>
          <form action={signOutEverywhere}><button className='btn'>Sign out all computers and browsers</button></form>
          <form action={deleteAccount} className='stack'>
            <p className='muted'>Deleting your account removes your profile, unlinks your computers and deletes your agents. Your project files aren’t touched.</p>
            <div className='row'><input className='input' name='confirm' placeholder='Type delete' aria-label='Type delete to confirm' /><button className='btn danger'>Delete account</button></div>
          </form>
        </section>
      </main>
    </>
  )
}
