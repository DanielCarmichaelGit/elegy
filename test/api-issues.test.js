// test/api-issues.test.js
// Who may report issues, what a report must look like, and that repeats count up.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi } from './api-helpers.js'
import { generateIdentity } from '../src/identity.js'
import { newToken, hashToken } from '../src/api/tokens.js'

const REPORT_KEY = 'rk_test_secret'
let t
before(async () => { t = await startTestApi({ reportKey: REPORT_KEY, reportLimit: 3 }) })
after(() => t.close())

/** A linked computer for "mem", and its bearer token. */
async function linkComputer () {
  const id = generateIdentity()
  const d = await t.store.upsertDevice({ userId: 'mem', name: 'Mac', platform: 'darwin', publicKey: id.publicKey })
  const token = newToken('qd_')
  await t.store.setDeviceToken(d.id, hashToken(token))
  return { device: d, token }
}
const batch = (events, extra = {}) => ({ surface: 'app', appVersion: '0.3.2', platform: 'darwin', events, ...extra })
const post = (body, headers) => t.call('POST', '/v1/issues', body, null, headers)

test('a linked computer reports as its account; repeats of one problem make one issue', async () => {
  const { device, token } = await linkComputer()
  const auth = { authorization: `Bearer ${token}` }
  const r = await post(batch([
    { kind: 'action', name: 'open-in', outcome: 'ok', durationMs: 50, context: { app: 'cursor' } },
    { kind: 'action', name: 'open-in', outcome: 'error', durationMs: 20, message: 'Could not open it: spawn /Users/a/Cursor ENOENT', context: { app: 'cursor' } }
  ]), auth)
  assert.deepEqual([r.status, r.body], [200, { ok: true, recorded: 2 }])
  await post(batch([{ kind: 'action', name: 'open-in', outcome: 'error', message: 'Could not open it: spawn /Users/b/Cursor ENOENT', context: { app: 'cursor' } }]), auth)
  const events = t.store.listEvents().filter((e) => e.name === 'open-in')
  assert.equal(events.length, 3)
  for (const e of events) {
    assert.equal(e.userId, 'mem'); assert.equal(e.deviceId, device.id); assert.equal(e.surface, 'app')
    assert.equal(e.appVersion, '0.3.2'); assert.equal(e.platform, 'darwin')
  }
  const issues = t.store.listIssues().filter((i) => i.name === 'open-in')
  assert.equal(issues.length, 1); assert.equal(issues[0].count, 2)
})

test('a linked computer may only report for the app, and the body cannot pick a user', async () => {
  const { token } = await linkComputer()
  const auth = { authorization: `Bearer ${token}` }
  assert.equal((await post(batch([{ kind: 'error', name: 'x' }], { surface: 'web' }), auth)).status, 400)
  await post(batch([{ kind: 'error', name: 'claimed', outcome: 'error' }], { userId: 'owner' }), auth)
  assert.equal(t.store.listEvents().find((e) => e.name === 'claimed').userId, 'mem')
})

test('a revoked computer is turned away', async () => {
  const { device, token } = await linkComputer()
  await t.store.revokeDevice(device.id)
  assert.equal((await post(batch([{ kind: 'error', name: 'x' }]), { authorization: `Bearer ${token}` })).status, 401)
})

test('the website reports with the key, for the web surface, naming the signed-in person when it knows one', async () => {
  const key = { 'x-quilt-report-key': REPORT_KEY }
  const r = await post({ surface: 'web', appVersion: '', platform: 'safari', userId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', events: [{ kind: 'http404', name: '/pricing/old', outcome: 'error', status: 404 }] }, key)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const e = t.store.listEvents().find((x) => x.name === '/pricing/old')
  assert.equal(e.surface, 'web'); assert.equal(e.userId, '3f2504e0-4f89-11d3-9a0c-0305e82c3301'); assert.equal(e.platform, 'safari')
  // A user id that isn't a uuid is dropped, not stored.
  await post({ surface: 'web', userId: 'not-a-uuid', events: [{ kind: 'error', name: '/x', outcome: 'error' }] }, key)
  assert.equal(t.store.listEvents().find((x) => x.name === '/x').userId, null)
  assert.equal((await post({ surface: 'app', events: [{ kind: 'error', name: '/y' }] }, key)).status, 400, 'the key is for the website only')
  assert.equal((await post({ surface: 'web', events: [{ kind: 'error', name: '/z' }] }, { 'x-quilt-report-key': 'wrong' })).status, 401)
})

test('without a token or key only app reports are taken, with no user, and only a few a minute', async () => {
  const r = await post(batch([{ kind: 'error', name: 'before-sign-in', outcome: 'error', message: 'Couldn\'t reach Quilt (ECONNREFUSED).' }]))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(t.store.listEvents().find((e) => e.name === 'before-sign-in').userId, null)
  assert.equal((await post(batch([{ kind: 'error', name: 'w' }], { surface: 'web' }))).status, 401)
  await post(batch([{ kind: 'error', name: 'two' }]))
  await post(batch([{ kind: 'error', name: 'three' }]))
  assert.equal((await post(batch([{ kind: 'error', name: 'four' }]))).status, 429)
})

test('a bad batch is a 400 and records nothing', async () => {
  const { token } = await linkComputer()
  const auth = { authorization: `Bearer ${token}` }
  const before = t.store.listEvents().length
  for (const body of [
    batch([]), batch('nope'), batch(Array.from({ length: 21 }, () => ({ kind: 'error', name: 'x' }))),
    batch([{ kind: 'nope', name: 'x' }]), batch([{ kind: 'error', name: 'x', outcome: 'meh' }]), batch([{ kind: 'error' }]),
    batch([{ kind: 'error', name: 'ok' }, 'junk'])
  ]) {
    const r = await post(body, auth)
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80))
  }
  assert.equal(t.store.listEvents().length, before)
})

test('with no report key configured, the website header is just a missing key', async () => {
  const bare = await startTestApi()
  try {
    const r = await bare.call('POST', '/v1/issues', { surface: 'web', events: [{ kind: 'error', name: '/x' }] }, null, { 'x-quilt-report-key': '' })
    assert.equal(r.status, 401)
  } finally { await bare.close() }
})
