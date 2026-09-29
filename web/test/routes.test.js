// Builds the site, runs `next start`, and checks what each route answers.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'
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
  for (const path of ['/', '/pricing']) assert.equal((await get(path)).status, 200, path)
})

test('private pages send signed-out people to sign in, and come back after', async () => {
  for (const path of ['/dashboard', '/settings', '/link?code=AAAA-BBBB']) {
    const res = await get(path)
    assert.equal(res.status, 307, path)
    const to = new URL(res.headers.get('location'), base)
    assert.equal(to.pathname, '/signin')
    assert.equal(to.searchParams.get('next'), path)
  }
})

test('the sign-in page renders with the email form', async () => {
  const html = await (await get('/signin')).text()
  assert.match(html, /type="email"/)
})
