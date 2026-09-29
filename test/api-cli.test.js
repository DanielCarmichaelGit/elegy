import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BIN = new URL('../bin/quilt.js', import.meta.url).pathname

// Runs `quilt api ...` until it prints `until` (or exits), then stops it.
function run (args, env = {}, until = /listening/) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-api-cli-'))
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SUPABASE_|AGENT_KEY_SECRET|QUILT_)/.test(k)))
  const child = spawn(process.execPath, [BIN, 'api', ...args], { env: { ...clean, HOME: home, ...env } })
  let out = ''
  return new Promise((resolve) => {
    const done = (code) => { child.kill(); resolve({ out, code }) }
    const onData = (d) => { out += d; if (until.test(out)) done(null) }
    child.stdout.on('data', onData); child.stderr.on('data', onData)
    child.on('exit', (code) => resolve({ out, code }))
    setTimeout(() => done('timeout'), 10_000)
  })
}

test('quilt api --memory listens on localhost only, since anyone can use "Bearer local"', async () => {
  const { out } = await run(['--memory', '--port', '0'])
  assert.match(out, /listening on http:\/\/127\.0\.0\.1:\d+/)
})

test('quilt api --memory --host still lets you choose the address', async () => {
  const { out } = await run(['--memory', '--port', '0', '--host', '0.0.0.0'])
  assert.match(out, /listening on http:\/\/0\.0\.0\.0:\d+/)
})

const prodEnv = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', QUILT_SITE_URL: 'https://quilt.test' }

test('quilt api refuses a weak AGENT_KEY_SECRET', async () => {
  for (const secret of ['short', Buffer.alloc(16, 1).toString('base64'), 'not base64 at all!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!']) {
    const { out, code } = await run(['--port', '0'], { ...prodEnv, AGENT_KEY_SECRET: secret })
    assert.equal(code, 1, `exit for ${secret}`)
    assert.match(out, /AGENT_KEY_SECRET/)
    assert.match(out, /openssl rand -base64 32/)
  }
})

test('quilt api accepts a 32-byte base64 AGENT_KEY_SECRET', async () => {
  const { out } = await run(['--port', '0', '--host', '127.0.0.1'], { ...prodEnv, AGENT_KEY_SECRET: Buffer.alloc(32, 7).toString('base64') })
  assert.match(out, /listening on/)
})
