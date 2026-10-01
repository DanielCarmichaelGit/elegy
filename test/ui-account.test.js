// The app's sign-in: until this computer is linked to an account the app only
// offers to sign in. Signing out, or being signed out from the website, brings
// that back.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-account-'))
process.env.HOME = home

const { startUi } = await import('../src/ui-server.js')
const { startServer } = await import('../src/server.js')
const { startTestApi, SITE } = await import('./api-helpers.js')
const { newPassKeys } = await import('../src/passes.js')

const accountFile = path.join(home, '.quilt', 'account.json')
const SIGNED_OUT = { signedIn: false, account: null, reason: null, link: null }
let ui, accounts, relay
before(async () => {
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  ui = await startUi({ port: 0 })
})
after(async () => { await ui.close(); await relay.close(); await accounts.close() })

const call = (app, method, p, body) => fetch(`http://127.0.0.1:${app.port}${p}`, {
  method,
  headers: { 'x-quilt-token': app.token, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))
const api = (method, p, body) => call(ui, method, p, body)
async function waitFor (fn, ms = 10000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error('timed out')
}
const tokenOnDisk = () => JSON.parse(fs.readFileSync(accountFile, 'utf8')).token
const revoke = (token) => accounts.call('POST', '/v1/me/signout', {}, null, { authorization: `Bearer ${token}` })

/** Signs this computer in through the app, approving it on the "website" as Mo. */
async function signIn () {
  const started = await api('POST', '/api/account/start')
  assert.equal(started.status, 200, JSON.stringify(started.body))
  await accounts.call('POST', '/v1/device/approve', { userCode: started.body.link.userCode, approve: true }, 'mem')
  return waitFor(async () => { const r = await api('GET', '/api/account'); return r.body.signedIn && r.body })
}

test('signed out, the app only offers to sign in', async () => {
  assert.deepEqual((await api('GET', '/api/account')).body, SIGNED_OUT)
  for (const [method, p, body] of [['GET', '/api/state'], ['GET', '/api/settings'], ['POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'x') }]]) {
    const r = await api(method, p, body)
    assert.equal(r.status, 401, p)
    assert.deepEqual(r.body, { error: 'Sign in to Quilt first.', signedOut: true }, p)
  }
  assert.match(await (await fetch(`http://127.0.0.1:${ui.port}/app.js`)).text(), /renderSignIn/)
  const screen = await (await fetch(`http://127.0.0.1:${ui.port}/signin.js`)).text()
  for (const copy of ['Sign in to Quilt', 'New to Quilt? <a', 'Create an account', 'https://heyquilt.com/signup', 'Approve this computer in your browser', 'Cancel', 'Open the page again']) {
    assert.ok(screen.includes(copy), copy)
  }
})

test('starting to sign in shows a code to approve, and cancelling forgets it', async () => {
  const started = await api('POST', '/api/account/start')
  assert.equal(started.body.link.state, 'waiting')
  assert.match(started.body.link.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  assert.equal(started.body.link.verificationUrl, `${SITE}/link?code=${started.body.link.userCode}`)
  assert.equal((await api('POST', '/api/account/cancel')).body.link, null)
  assert.deepEqual((await api('GET', '/api/account')).body, SIGNED_OUT)
})

test('approving on the website signs the app in; your name is your account name', async () => {
  const acc = await signIn()
  assert.deepEqual(acc.account, { id: 'mem', name: 'Mo', email: 'mo@acme.com' })
  assert.equal(fs.statSync(accountFile).mode & 0o777, 0o600)
  assert.equal((await api('GET', '/api/settings')).body.name, 'Mo')
  const renamed = await api('POST', '/api/settings', { name: 'Someone else' })
  assert.equal(renamed.status, 400)
  assert.equal(renamed.body.error, 'Change your name on heyquilt.com.')
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'proj') })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.equal(s.body.status.me.name, 'Mo')
  await api('POST', `/api/sessions/${s.body.id}/stop`)
})

test('signing out revokes this computer, stops its sessions and deletes account.json', async () => {
  const token = tokenOnDisk()
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'proj2') })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.deepEqual((await api('POST', '/api/account/signout')).body, { ok: true })
  assert.equal(fs.existsSync(accountFile), false)
  assert.equal((await accounts.call('GET', '/v1/me', null, null, { authorization: `Bearer ${token}` })).status, 401, 'revoked on the server')
  assert.deepEqual((await api('GET', '/api/account')).body, SIGNED_OUT)
  await waitFor(() => [...relay.rooms.values()].every((r) => r.conns.size === 0))
})

test('a computer signed out from the website goes back to sign-in, saying so', async () => {
  await signIn()
  await revoke(tokenOnDisk())
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'proj3') })
  assert.equal(s.status, 401)
  assert.equal(s.body.signedOut, true)
  assert.equal(fs.existsSync(accountFile), false)
  assert.deepEqual((await api('GET', '/api/account')).body, { ...SIGNED_OUT, reason: 'revoked' })
})

test('opening the app notices a sign-out that happened while it was closed', async () => {
  await signIn()
  await revoke(tokenOnDisk())
  const again = await startUi({ port: 0 })
  try {
    const r = await call(again, 'GET', '/api/account')
    assert.deepEqual(r.body, { ...SIGNED_OUT, reason: 'revoked' })
    assert.equal(fs.existsSync(accountFile), false)
  } finally {
    await again.close()
  }
})
