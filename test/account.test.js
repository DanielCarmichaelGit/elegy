// This computer's sign-in: account.json, and linking through the website.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestApi } from './api-helpers.js'
import { readAccount, saveAccount, clearAccount, startLink, pollLink, waitForLink, fetchMe, signOut, accountFromProfile } from '../src/account.js'
import { generateIdentity } from '../src/identity.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-account-'))
const sample = { token: 'qd_test', account: { id: 'mem', name: 'Mo', email: 'mo@acme.com' }, signedInAt: 1 }

test('account.json is written privately and atomically, and never through a symlink', () => {
  const dir = tmp()
  const file = path.join(dir, 'account.json')
  saveAccount(sample, file)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(readAccount(file), sample)
  assert.deepEqual(fs.readdirSync(dir), ['account.json'], 'no temp files left behind')

  const target = path.join(dir, 'elsewhere.json')
  fs.writeFileSync(target, '{}')
  const link = path.join(dir, 'linked.json')
  fs.symlinkSync(target, link)
  assert.throws(() => saveAccount(sample, link), /symlink/)
  assert.equal(fs.readFileSync(target, 'utf8'), '{}', 'the target was not written')
  fs.writeFileSync(target, JSON.stringify(sample))
  assert.equal(readAccount(link), null, 'a symlinked account.json is not trusted')

  clearAccount(file)
  assert.equal(readAccount(file), null)
  fs.writeFileSync(file, 'not json')
  assert.equal(readAccount(file), null)
})

test('linking this computer: start, approve on the website, collect the token and profile, sign out', async () => {
  const identity = generateIdentity()
  const link = await startLink({ identity, api: t.api.url })
  assert.match(link.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  assert.equal((await pollLink({ identity, deviceCode: link.deviceCode, api: t.api.url })).status, 'pending')
  await t.call('POST', '/v1/device/approve', { userCode: link.userCode, approve: true }, 'mem')
  const r = await waitForLink({ identity, link: { ...link, interval: 0 }, api: t.api.url })
  assert.match(r.token, /^qd_/)
  assert.deepEqual(accountFromProfile(r.profile), { id: 'mem', name: 'Mo', email: 'mo@acme.com' })
  assert.equal((await fetchMe({ token: r.token, api: t.api.url })).email, 'mo@acme.com')

  const file = path.join(tmp(), 'account.json')
  saveAccount({ token: r.token, account: accountFromProfile(r.profile), signedInAt: Date.now() }, file)
  await signOut({ token: r.token, api: t.api.url, file })
  assert.equal(fs.existsSync(file), false)
  await assert.rejects(fetchMe({ token: r.token, api: t.api.url }), (err) => err.status === 401)
})

test('a declined or expired link ends the wait clearly', async () => {
  const identity = generateIdentity()
  const declined = await startLink({ identity, api: t.api.url })
  await t.call('POST', '/v1/device/approve', { userCode: declined.userCode, approve: false }, 'mem')
  await assert.rejects(waitForLink({ identity, link: { ...declined, interval: 0 }, api: t.api.url }), (err) => err.denied === true)
  const expired = await startLink({ identity, api: t.api.url })
  let clock = Date.now()
  await assert.rejects(waitForLink({ identity, link: { ...expired, interval: 0 }, api: t.api.url, now: () => (clock += 60_000) }), (err) => err.expired === true)
  let stop = false
  const cancelled = waitForLink({ identity, link: { ...expired, interval: 0 }, api: t.api.url, stopped: () => stop })
  stop = true
  await assert.rejects(cancelled, (err) => err.cancelled === true)
})

test('signing out forgets the token even when Quilt cannot be reached', async () => {
  const file = path.join(tmp(), 'account.json')
  saveAccount(sample, file)
  await signOut({ token: sample.token, api: 'http://127.0.0.1:9', file })
  assert.equal(fs.existsSync(file), false)
})
