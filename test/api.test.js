// test/api.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startApi } from '../src/api/server.js'
import { createMemoryStore } from '../src/api/memory-store.js'
import { generateIdentity } from '../src/identity.js'

let api, store
const SITE = 'https://quilt.test'
// Website users are recognised by their JWT; here a bearer "user:<id>" stands in for one.
const verifyUser = async (t) => (t && t.startsWith('user:') ? { userId: t.slice(5), email: `${t.slice(5)}@x.test` } : null)
const call = async (method, path, body, token) => {
  const res = await fetch(api.url + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), origin: SITE },
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers }
}

before(async () => {
  store = createMemoryStore()
  store.addUser('u1', { name: 'Dana' }); store.addUser('u2', { name: 'Eli' })
  api = await startApi({ store, verifyUser, siteUrl: SITE, agentKeySecret: 'test-secret' })
})
after(() => api.close())

test('health', async () => {
  assert.equal((await call('GET', '/healthz')).body.ok, true)
})

test('linking a computer: start, see it on the website, approve, then the app gets its token once', async () => {
  const { publicKey } = generateIdentity()
  const start = await call('POST', '/v1/device/start', { publicKey, deviceName: "Dana's MacBook", platform: 'darwin' })
  assert.equal(start.status, 200)
  assert.match(start.body.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  assert.equal(start.body.verificationUrl, `${SITE}/link?code=${start.body.userCode}`)
  assert.equal(start.body.interval, 3)
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: start.body.deviceCode })).status, 202)

  assert.equal((await call('GET', `/v1/device/link/${start.body.userCode}`)).status, 401, 'needs sign-in')
  const seen = await call('GET', `/v1/device/link/${start.body.userCode.replace('-', '').toLowerCase()}`, null, 'user:u1')
  assert.equal(seen.body.deviceName, "Dana's MacBook")

  assert.equal((await call('POST', '/v1/device/approve', { userCode: start.body.userCode, approve: true }, 'user:u1')).status, 200)
  const done = await call('POST', '/v1/device/poll', { deviceCode: start.body.deviceCode })
  assert.equal(done.status, 200)
  assert.match(done.body.token, /^qd_/)
  assert.equal(done.body.profile.name, 'Dana')
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: start.body.deviceCode })).status, 410, 'the token is handed out once')
})

test('two polls racing on the same approved link: only one wins a token', async () => {
  // Wrap the store so linkByDeviceCode awaits a tick, giving both concurrent
  // polls time to read 'approved' before either claims it, like a real DB round-trip.
  const slow = { ...store, linkByDeviceCode: async (h) => { const l = await store.linkByDeviceCode(h); await new Promise((r) => setImmediate(r)); return l } }
  const raceApi = await startApi({ store: slow, verifyUser, siteUrl: SITE, agentKeySecret: 'test-secret' })
  try {
    const raceCall = async (method, path, body, token) => {
      const res = await fetch(raceApi.url + path, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), origin: SITE },
        body: body ? JSON.stringify(body) : undefined
      })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const { publicKey } = generateIdentity()
    const start = await raceCall('POST', '/v1/device/start', { publicKey, deviceName: 'Race', platform: 'linux' })
    await raceCall('POST', '/v1/device/approve', { userCode: start.body.userCode, approve: true }, 'user:u1')
    const [a, b] = await Promise.all([
      raceCall('POST', '/v1/device/poll', { deviceCode: start.body.deviceCode }),
      raceCall('POST', '/v1/device/poll', { deviceCode: start.body.deviceCode })
    ])
    const statuses = [a.status, b.status].sort()
    assert.deepEqual(statuses, [200, 410])
    const winner = a.status === 200 ? a : b
    assert.match(winner.body.token, /^qd_/)
  } finally {
    await raceApi.close()
  }
})

test('a denied or expired link never yields a token', async () => {
  const { publicKey } = generateIdentity()
  const a = await call('POST', '/v1/device/start', { publicKey, deviceName: 'X', platform: 'linux' })
  await call('POST', '/v1/device/approve', { userCode: a.body.userCode, approve: false }, 'user:u1')
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: a.body.deviceCode })).status, 403)
  const b = await call('POST', '/v1/device/start', { publicKey, deviceName: 'X', platform: 'linux' })
  const l = await store.linkByUserCode(b.body.userCode)
  await store.updateLink(l.id, { expiresAt: Date.now() - 1 })
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: b.body.deviceCode })).status, 410)
  assert.equal((await call('POST', '/v1/device/approve', { userCode: b.body.userCode, approve: true }, 'user:u1')).status, 410)
})

test('bad requests are refused', async () => {
  assert.equal((await call('POST', '/v1/device/start', { publicKey: 'nope', deviceName: 'X' })).status, 400)
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: 'nope' })).status, 404)
  assert.equal((await call('GET', '/v1/device/link/AAAA-AAAA', null, 'user:u1')).status, 404)
})
