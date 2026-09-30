// scripts/api-smoke.mjs — checks a deployed accounts API end to end.
// Usage: QUILT_API=https://api.heyquilt.com QUILT_TEST_JWT=<a signed-in user's access token> node scripts/api-smoke.mjs
import { generateIdentity, signChallenge } from '../src/identity.js'
const API = process.env.QUILT_API; const JWT = process.env.QUILT_TEST_JWT
const call = async (m, p, b, t) => { const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, b: await r.json().catch(() => null) } }
const ok = (c, msg) => { if (!c) { console.error('FAIL', msg); process.exit(1) } console.log('ok  ', msg) }
ok((await call('GET', '/healthz')).b?.ok, 'health')
const id = generateIdentity()
// Polls prove this computer holds the key by signing the device code.
const poll = (dc) => call('POST', '/v1/device/poll', { deviceCode: dc, signature: Buffer.from(signChallenge(id, 'device-link', Buffer.from(dc))).toString('base64url') })
const st = await call('POST', '/v1/device/start', { publicKey: id.publicKey, deviceName: 'smoke test', platform: 'test' }); ok(st.s === 200, 'device/start')
ok((await poll(st.b.deviceCode)).s === 202, 'poll pending')
if (!JWT) { console.log('set QUILT_TEST_JWT to check approve, profile and agents'); process.exit(0) }
ok((await call('POST', '/v1/device/approve', { userCode: st.b.userCode, approve: true }, JWT)).s === 200, 'approve')
const tok = (await poll(st.b.deviceCode)).b?.token; ok(tok?.startsWith('qd_'), 'token')
ok((await call('GET', '/v1/me', null, tok)).b?.profile?.id, 'me')
const ag = await call('POST', '/v1/agents', { name: 'smoke agent' }, JWT); ok(ag.b?.key?.startsWith('qa_'), 'agent created')
ok((await call('DELETE', `/v1/agents/${ag.b.agent.id}`, null, JWT)).s === 200, 'agent revoked')
ok((await call('POST', '/v1/me/signout', {}, tok)).s === 200, 'signout')
console.log('all good')
