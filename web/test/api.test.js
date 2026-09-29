import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

let srv; const seen = []
before(async () => {
  srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
      res.writeHead(req.url === '/v1/boom' ? 500 : 200, { 'content-type': 'application/json' })
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
  assert.equal(seen.at(-1).body, '{"name":"Larry"}')
  const bad = await apiCall({ accessToken: 'tok' }, 'GET', '/v1/boom')
  assert.deepEqual([bad.ok, bad.status], [false, 500])
})

test('an unreachable API is a failed result, not a crash', async () => {
  const { apiCall } = await import('../lib/api.js')
  const saved = process.env.QUILT_API_URL
  process.env.QUILT_API_URL = 'http://127.0.0.1:9'
  try { assert.deepEqual(await apiCall({ accessToken: 't' }, 'GET', '/v1/agents'), { ok: false, status: 0, data: null }) } finally { process.env.QUILT_API_URL = saved }
})
