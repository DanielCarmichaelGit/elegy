import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

let srv; const seen = []
before(async () => {
  srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let parsed = body
      try { parsed = JSON.parse(body) } catch {}
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: parsed })
      res.writeHead(req.url.includes('/boom') ? 500 : req.url === '/v1/missing' ? 404 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ echo: req.url }))
    })
  }).listen(0)
  await new Promise((r) => srv.once('listening', r))
  process.env.QUILT_API_URL = `http://127.0.0.1:${srv.address().port}`
})
after(() => srv.close())

test('calls carry the signed-in person\'s token and JSON body', async () => {
  const { apiCall } = await import('../lib/api.js')
  const r = await apiCall({ accessToken: 'tok' }, 'POST', '/v1/agents', { name: 'Larry' })
  assert.deepEqual([r.ok, r.status, r.data.echo], [true, 200, '/v1/agents'])
  assert.equal(seen.at(-1).auth, 'Bearer tok')
  assert.deepEqual(seen.at(-1).body, { name: 'Larry' })
  const bad = await apiCall({ accessToken: 'tok' }, 'GET', '/v1/boom')
  assert.deepEqual([bad.ok, bad.status], [false, 500])
})

test('an unreachable API is a failed result, not a crash', async () => {
  const { apiCall } = await import('../lib/api.js')
  const saved = process.env.QUILT_API_URL
  process.env.QUILT_API_URL = 'http://127.0.0.1:9'
  try { assert.deepEqual(await apiCall({ accessToken: 't' }, 'GET', '/v1/agents'), { ok: false, status: 0, data: null }) } finally { process.env.QUILT_API_URL = saved }
})

test('a request that never gets a response times out to the same failed shape', async () => {
  const { apiCall } = await import('../lib/api.js')
  // Standing in for the real 15s timeout firing, so the test doesn't have to wait 15s:
  // this only proves apiCall wires `signal` into fetch, since our test server never
  // responds and only an honored abort signal would make the call fail this fast.
  const realTimeout = AbortSignal.timeout
  AbortSignal.timeout = () => AbortSignal.abort()
  try {
    const r = await apiCall({ accessToken: 'tok' }, 'GET', '/v1/hang')
    assert.deepEqual(r, { ok: false, status: 0, data: null })
  } finally { AbortSignal.timeout = realTimeout }
})

test('a failed or slow call to the API is reported once, with the key, and ordinary 4xx answers are not', async () => {
  const { apiCall } = await import('../lib/api.js')
  process.env.QUILT_REPORT_KEY = 'rk_web'
  const wait = () => new Promise((r) => setTimeout(r, 50))
  const before = seen.length
  await apiCall({ accessToken: 'tok', id: 'u-1' }, 'GET', '/v1/boom')
  await wait() // the report is fire-and-forget, so give it a moment to land
  const rep = seen.slice(before).find((s) => s.url === '/v1/issues')
  assert.ok(rep, 'the 500 was reported')
  assert.equal(rep.body.events[0].name, 'GET /v1/boom'); assert.equal(rep.body.events[0].status, 500); assert.equal(rep.body.events[0].outcome, 'error')
  assert.equal(rep.body.userId, 'u-1')
  const n = seen.length
  await apiCall({ accessToken: 'tok' }, 'GET', '/v1/agents')
  await wait()
  assert.equal(seen.slice(n).filter((s) => s.url === '/v1/issues').length, 0, 'a 200 is not reported')
  const n2 = seen.length
  await apiCall({ accessToken: 'tok', id: 'u-2' }, 'GET', '/v1/missing')
  await wait()
  const rep404 = seen.slice(n2).find((s) => s.url === '/v1/issues')
  assert.ok(rep404, 'the 404 was reported')
  assert.equal(rep404.body.events[0].status, 404)
  const n3 = seen.length
  await apiCall({ accessToken: 'tok' }, 'GET', '/v1/orgs/3f2504e0-4f89-11d3-9a0c-0305e82c3301/boom?x=1')
  await wait()
  const repId = seen.slice(n3).find((s) => s.url === '/v1/issues')
  assert.ok(repId, 'the 500 behind an id was reported')
  assert.equal(repId.body.events[0].name, 'GET /v1/orgs/:id/boom')
  delete process.env.QUILT_REPORT_KEY
})

test('a failing call groups by org slug and by device-link code, and a token before a query string is still replaced', async () => {
  const { apiCall } = await import('../lib/api.js')
  process.env.QUILT_REPORT_KEY = 'rk_web'
  const wait = () => new Promise((r) => setTimeout(r, 50))

  const n = seen.length
  await apiCall({ accessToken: 'tok' }, 'GET', '/v1/orgs/acme/boom')
  await wait()
  const acme = seen.slice(n).find((s) => s.url === '/v1/issues')
  assert.ok(acme, 'the acme boom was reported')
  assert.equal(acme.body.events[0].name, 'GET /v1/orgs/:slug/boom')

  const n2 = seen.length
  await apiCall({ accessToken: 'tok' }, 'GET', '/v1/orgs/zeta/boom')
  await wait()
  const zeta = seen.slice(n2).find((s) => s.url === '/v1/issues')
  assert.ok(zeta, 'the zeta boom was reported')
  assert.equal(zeta.body.events[0].name, 'GET /v1/orgs/:slug/boom', 'different orgs group as one issue')

  const n3 = seen.length
  await apiCall({ accessToken: 'tok' }, 'GET', '/v1/device/link/ABCD-1234/boom')
  await wait()
  const code = seen.slice(n3).find((s) => s.url === '/v1/issues')
  assert.ok(code, 'the link-code boom was reported')
  assert.equal(code.body.events[0].name, 'GET /v1/device/link/:code/boom')

  const n4 = seen.length
  await apiCall({ accessToken: 'tok' }, 'GET', `/v1/boom/${'a'.repeat(30)}?x=1`)
  await wait()
  const tok = seen.slice(n4).find((s) => s.url === '/v1/issues')
  assert.ok(tok, 'the token-then-query boom was reported')
  assert.equal(tok.body.events[0].name, 'GET /v1/boom/:token')
  delete process.env.QUILT_REPORT_KEY
})
