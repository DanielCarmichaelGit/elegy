import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

let srv; const seen = []; let answer = 200
before(async () => {
  srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { seen.push({ url: req.url, key: req.headers['x-quilt-report-key'], body: JSON.parse(body) }); res.writeHead(answer); res.end('{}') })
  }).listen(0)
  await new Promise((r) => srv.once('listening', r))
  process.env.QUILT_API_URL = `http://127.0.0.1:${srv.address().port}`
  process.env.QUILT_REPORT_KEY = 'rk_web'
})
after(() => srv.close())

test('cleanPath keeps only the path: no query, no fragment (invite links carry secrets there)', async () => {
  const { cleanPath } = await import('../lib/report.js')
  assert.equal(cleanPath('/join/room-x?x=1#s=secret'), '/join/room-x')
  assert.equal(cleanPath('https://heyquilt.com/pricing/old#top'), '/pricing/old')
  assert.equal(cleanPath(''), '/'); assert.equal(cleanPath(null), '/'); assert.equal(cleanPath(42), '/')
  assert.equal(cleanPath('/' + 'a'.repeat(300)).length, 200)
})

test('uaFamily names the browser family, never the whole user agent', async () => {
  const { uaFamily } = await import('../lib/report.js')
  assert.equal(uaFamily('Mozilla/5.0 (Macintosh) AppleWebKit/605 (KHTML, like Gecko) Version/17 Safari/605'), 'safari')
  assert.equal(uaFamily('Mozilla/5.0 (Windows) AppleWebKit/537 Chrome/120 Safari/537'), 'chrome')
  assert.equal(uaFamily('Mozilla/5.0 (Windows) AppleWebKit/537 Chrome/120 Safari/537 Edg/120'), 'edge')
  assert.equal(uaFamily('Mozilla/5.0 (X11) Gecko/20100101 Firefox/120'), 'firefox')
  assert.equal(uaFamily(''), 'other')
})

test('report posts one web event with the key and the person, and swallows failures', async () => {
  const { report } = await import('../lib/report.js')
  await report({ kind: 'http404', name: '/pricing/old', status: 404, userId: 'u-1', platform: 'safari' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, '/v1/issues'); assert.equal(seen[0].key, 'rk_web')
  assert.deepEqual(seen[0].body.surface, 'web'); assert.equal(seen[0].body.userId, 'u-1'); assert.equal(seen[0].body.platform, 'safari')
  // durationMs is omitted here (not durationMs: undefined): under node:assert/strict,
  // deepEqual is deepStrictEqual, which compares own-key sets exactly, so a key that
  // JSON.stringify dropped (undefined fields aren't serialized) must be absent here too.
  assert.deepEqual(seen[0].body.events[0], { kind: 'http404', name: '/pricing/old', outcome: 'error', status: 404, message: '' })
  answer = 500
  await report({ kind: 'error', name: '/x', message: 'boom' })
  assert.equal(seen.length, 2, 'a failed send is not retried and does not throw')
  answer = 200
  const saved = process.env.QUILT_API_URL
  process.env.QUILT_API_URL = 'http://127.0.0.1:9'
  try { await report({ kind: 'error', name: '/y' }) } finally { process.env.QUILT_API_URL = saved }
})

test('without a report key nothing is sent', async () => {
  const { report } = await import('../lib/report.js')
  const saved = process.env.QUILT_REPORT_KEY
  delete process.env.QUILT_REPORT_KEY
  try {
    const n = seen.length
    await report({ kind: 'error', name: '/z' })
    assert.equal(seen.length, n)
  } finally { process.env.QUILT_REPORT_KEY = saved }
})
