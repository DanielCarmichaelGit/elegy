// Builds the site, runs `next start`, and checks what each route answers.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const env = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_test',
  QUILT_API_URL: process.env.QUILT_API_URL || 'http://127.0.0.1:9'
}
const cwd = fileURLToPath(new URL('..', import.meta.url))
const nextBin = fileURLToPath(new URL('../node_modules/.bin/next', import.meta.url))
let server; let base
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)) }) })

before(async () => {
  execFileSync(nextBin, ['build'], { cwd, env, stdio: 'ignore' })
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  server = spawn(nextBin, ['start', '-p', String(port)], { cwd, env, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) { try { await fetch(base); return } catch { await new Promise((r) => setTimeout(r, 200)) } }
  throw new Error('next start did not come up')
})
after(() => server?.kill())

const get = (path) => fetch(base + path, { redirect: 'manual' })

test('public pages render', async () => {
  for (const path of ['/', '/pricing', '/join/room-abc']) assert.equal((await get(path)).status, 200, path)
})

test('private pages send signed-out people to sign in, and come back after', async () => {
  for (const path of ['/dashboard', '/settings', '/link?code=AAAA-BBBB', '/reset', '/org/acme', '/org/acme/people', '/org/acme/roles', '/org/acme/teams', '/org/acme/invites', '/org/acme/settings', '/invite/qi_test']) {
    const res = await get(path)
    assert.equal(res.status, 307, path)
    const to = new URL(res.headers.get('location'), base)
    assert.equal(to.pathname, '/signin')
    assert.equal(to.searchParams.get('next'), path)
  }
})

test('/orgs/new redirects to the org sign-up page (orgs are only made by signing up as one)', async () => {
  const res = await get('/orgs/new')
  assert.equal(res.status, 307)
  assert.equal(new URL(res.headers.get('location'), base).pathname, '/signup/org')
})

test('the sign-in page renders with the email form', async () => {
  const html = await (await get('/signin')).text()
  assert.match(html, /type="email"/)
})

test('the sign-up page renders with a password field, and a link to the org sign-up', async () => {
  const html = await (await get('/signup')).text()
  assert.match(html, /type="password"/)
  assert.doesNotMatch(html, /Just me/)
  assert.match(html, /signup\/org/)
})

test('the org sign-up page renders with a password field and an org name field', async () => {
  const html = await (await get('/signup/org')).text()
  assert.match(html, /type="password"/)
  assert.match(html, /name="org"/)
})

test('the forgot-password page renders with an email field', async () => {
  const html = await (await get('/forgot')).text()
  assert.match(html, /type="email"/)
})

// Like get(), but with a Host header, the way requests for join.heyquilt.com arrive.
const getAs = (host, path) => new Promise((resolve, reject) => {
  http.get({ hostname: '127.0.0.1', port: new URL(base).port, path, headers: { host } }, (res) => {
    let body = ''
    res.on('data', (c) => { body += c })
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
  }).on('error', reject)
})

test('join.heyquilt.com/<room> shows the invite page, sending no referrer and kept out of search', async () => {
  for (const [host, path] of [['join.heyquilt.com', '/room-abc'], ['join.heyquilt.com', '/room-abc/'], [new URL(base).host, '/join/room-abc']]) {
    const res = await getAs(host, path)
    assert.equal(res.status, 200, `${host}${path}`)
    assert.match(res.body, /invited to a Quilt session/)
    assert.match(res.body, /quilt-mac-arm64\.dmg|quilt-windows-x64\.exe/, 'download buttons')
    assert.equal(res.headers['referrer-policy'], 'no-referrer', `${host}${path}`)
    assert.equal(res.headers['x-robots-tag'], 'noindex', `${host}${path}`)
  }
})

test('anything else on join.heyquilt.com goes to the home page; a bad room is not found', async () => {
  for (const path of ['/', '/a/b']) {
    const res = await getAs('join.heyquilt.com', path)
    assert.ok([307, 308].includes(res.status), path)
    assert.equal(res.headers.location, 'https://heyquilt.com/')
  }
  assert.equal((await get('/join/bad%20room')).status, 404)
})

test('the join host has no relative nav links (R3): the site Header would try to open them as room invites', async () => {
  const res = await getAs('join.heyquilt.com', '/room-abc')
  assert.doesNotMatch(res.body, /href="\/pricing"/)
  assert.doesNotMatch(res.body, /href="\/signin"/)
})

// skipTrailingSlashRedirect (next.config.mjs) is needed so the join host's own rewrite can
// accept a trailing slash; proxy.js brings the redirect back for every other host.
test('a trailing slash redirects to the canonical path, except on the join host', async () => {
  const res = await get('/pricing/')
  assert.equal(res.status, 308)
  assert.equal(new URL(res.headers.get('location'), base).pathname, '/pricing')

  const stillJoins = await getAs('join.heyquilt.com', '/room-abc/')
  assert.equal(stillJoins.status, 200)
})

test('signed-out /dashboard/ ends up at /signin with no trailing slash anywhere in the chain', async () => {
  const first = await get('/dashboard/')
  assert.equal(first.status, 308)
  const noSlash = new URL(first.headers.get('location'), base)
  assert.equal(noSlash.pathname, '/dashboard')

  const second = await fetch(noSlash, { redirect: 'manual' })
  assert.equal(second.status, 307)
  const signin = new URL(second.headers.get('location'), base)
  assert.equal(signin.pathname, '/signin')
  assert.equal(signin.searchParams.get('next'), '/dashboard')
})
