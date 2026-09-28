// Commit timing: people ask the host for a commit, the host sees who is still
// working, and commits once everyone is idle.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'
import { startControl, call } from '../src/control.js'

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `cowove-cm-${n}-`))
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}

test('commit requests, busy people, and the host committing', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  const server = `ws://127.0.0.1:${srv.port}`
  const hostDir = tmp('host')
  const git = (...args) => execFileSync('git', args, { cwd: hostDir, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'host@example.com')
  git('config', 'user.name', 'Host')
  fs.writeFileSync(path.join(hostDir, 'app.js'), 'v1\n')
  git('add', '-A'); git('commit', '-q', '-m', 'first')

  const host = new Session({ dir: hostDir, server, room: 'cm', secret: 's', name: 'hana', identity: generateIdentity() })
  await host.start({ waitTimeoutMs: 5000 })
  const guestDir = tmp('guest')
  const guest = new Session({ dir: guestDir, server, room: 'cm', secret: 's', name: 'gus', kind: 'agent', identity: generateIdentity() })
  await guest.start({ waitTimeoutMs: 5000 })
  await waitFor(() => fs.existsSync(path.join(guestDir, 'app.js')))

  // The guest's agent is busy, then asks for a commit.
  guest.setWork('working', 'wiring up login')
  await waitFor(() => host.commitStatus().busy.some((b) => b.name === 'gus'))
  assert.equal(host.commitStatus().ready, false)
  assert.throws(() => guest.requestCommit('  '), /say what the commit is for/)
  fs.writeFileSync(path.join(guestDir, 'app.js'), 'v2\n')
  guest.requestCommit('login works end to end')
  await waitFor(() => host.commitStatus().open.length === 1)
  assert.equal(host.commitStatus().open[0].by, 'gus')
  guest.setWork('done')
  await waitFor(() => host.commitStatus().ready)
  await waitFor(() => fs.readFileSync(path.join(hostDir, 'app.js'), 'utf8') === 'v2\n')

  // Only the host (the folder with git, who started it) can commit through the control API.
  const hostCtl = await startControl(host, {})
  const guestCtl = await startControl(guest, { joined: true })
  const d = (c, s) => JSON.parse(fs.readFileSync(path.join(s.stateDir, 'daemon.json'), 'utf8'))
  const status = await call(d(hostCtl, host), 'GET', '/commits')
  assert.equal(status.host, true)
  assert.equal((await call(d(guestCtl, guest), 'GET', '/commits')).host, false)
  await assert.rejects(call(d(guestCtl, guest), 'POST', '/commit', {}), /Only the session host can commit/)
  const r = await call(d(hostCtl, host), 'POST', '/commit', {})
  assert.equal(r.subject, 'login works end to end', 'uses the open requests as the message')
  assert.match(git('log', '-1', '--format=%s'), /login works end to end/)
  await waitFor(() => guest.commitStatus().open.length === 0)
  assert.equal(guest.commitStatus().recent[0].hash, r.hash)

  await hostCtl.close(); await guestCtl.close()
  await guest.stop(); await host.stop(); await srv.close()
})
