import Header from '@/components/Header.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { decide } from './actions.js'

export const metadata = { title: 'Link a computer' }
const PLATFORMS = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' }

export default async function LinkPage ({ searchParams }) {
  const q = await searchParams
  const code = String(q.code || '')
  const user = await requireUser(`/link?code=${encodeURIComponent(code)}`)
  let body
  if (q.done === 'approved') body = <><h2>Computer linked</h2><p className='muted'>You can go back to the Quilt app — it's signed in now.</p></>
  else if (q.done === 'denied') body = <><h2>Not linked</h2><p className='muted'>That computer won't be signed in.</p></>
  else {
    const r = code ? await apiCall(user, 'GET', `/v1/device/link/${encodeURIComponent(code)}`) : { ok: false, status: 404 }
    if (!r.ok) {
      body = <><h2>That code didn't work</h2><p className='muted'>{r.status === 410 ? 'It expired or was already used.' : 'Check the code in the Quilt app, or start signing in again there.'}</p>{q.done === 'failed' && <p className='notice bad'>Something went wrong. Try again.</p>}</>
    } else {
      const d = r.data
      body = (
        <>
          <h2>Link this computer to your account?</h2>
          <p><b>{d.deviceName}</b> {PLATFORMS[d.platform] ? <span className='pill'>{PLATFORMS[d.platform]}</span> : null}</p>
          <p className='muted'>Check the Quilt app shows this code: <code style={{ fontSize: 16 }}>{d.userCode}</code></p>
          <p className='muted'>Signed in as {user.email}</p>
          <form action={decide} className='row'>
            <input type='hidden' name='code' value={d.userCode} />
            <button className='btn primary' name='decision' value='approve'>Approve</button>
            <button className='btn ghost' name='decision' value='deny'>Deny</button>
          </form>
        </>
      )
    }
  }
  return (
    <>
      <Header signedIn />
      <main className='wrap page' style={{ maxWidth: 520 }}><div className='card stack'>{body}</div></main>
    </>
  )
}
