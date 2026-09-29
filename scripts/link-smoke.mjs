// Links a throwaway "computer" to your account through the real website and API.
// Usage: QUILT_API=https://quilt-api.fly.dev node scripts/link-smoke.mjs
// It prints a link: open it, sign in, click Approve. The script then collects the
// token (signing the poll like the app will), reads your profile, and signs out.
import { generateIdentity, signChallenge } from '../src/identity.js'

const API = process.env.QUILT_API || 'https://quilt-api.fly.dev'
const call = async (m, p, b, t) => { const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, b: await r.json().catch(() => null) } }
const id = generateIdentity()
const start = await call('POST', '/v1/device/start', { publicKey: id.publicKey, deviceName: 'link smoke test', platform: 'test' })
if (start.s !== 200) { console.error('start failed', start); process.exit(1) }
console.log(`Open ${start.b.verificationUrl}\nCheck it shows code ${start.b.userCode}, then Approve. Waiting…`)
const signature = Buffer.from(signChallenge(id, 'device-link', Buffer.from(start.b.deviceCode))).toString('base64url')
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, start.b.interval * 1000))
  const p = await call('POST', '/v1/device/poll', { deviceCode: start.b.deviceCode, signature })
  if (p.s === 202) continue
  if (p.s !== 200) { console.error('poll ended', p.s, p.b); process.exit(1) }
  console.log('ok   token received')
  const me = await call('GET', '/v1/me', null, p.b.token)
  console.log(me.s === 200 ? `ok   signed in as ${me.b.profile.name}` : `FAIL me ${me.s}`)
  console.log((await call('POST', '/v1/me/signout', {}, p.b.token)).s === 200 ? 'ok   signed out (the test computer is unlinked)' : 'FAIL signout')
  process.exit(me.s === 200 ? 0 : 1)
}
console.error('timed out'); process.exit(1)
