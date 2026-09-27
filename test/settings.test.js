// The default ("hosted") relay: saved once, then used by `elegy join`,
// the app, and agents; its key is used to create rooms but never shared.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { startServer } from '../src/server.js'
import { normalizeRelay } from '../src/settings.js'
import { decodeInvite } from '../src/runner.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'elegy.js')
const run = promisify(execFile)
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `elegy-settings-${n}-`))

test('relay addresses are normalized', () => {
  assert.equal(normalizeRelay('https://relay.example.com/'), 'wss://relay.example.com')
  assert.equal(normalizeRelay('relay.example.com'), 'wss://relay.example.com')
  assert.equal(normalizeRelay('http://10.0.0.5:4321'), 'ws://10.0.0.5:4321')
  assert.equal(normalizeRelay('wss://x.fly.dev'), 'wss://x.fly.dev')
  assert.throws(() => normalizeRelay(''), /relay address/)
})

test('elegy relay set/check, then elegy join starts on the default relay with its key', async () => {
  const home = tmp('home')
  const env = { ...process.env, HOME: home, ELEGY_SERVER: '', ELEGY_RELAY_KEY: '' }
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, relayKey: 'team-key' })
  const url = `ws://127.0.0.1:${srv.port}`

  const set = await run(process.execPath, [BIN, 'relay', 'set', `http://127.0.0.1:${srv.port}`, '--key', 'team-key'], { env })
  assert.match(set.stdout, /needs a relay key/)
  assert.match(set.stdout, /default relay set/)
  const saved = JSON.parse(fs.readFileSync(path.join(home, '.elegy', 'settings.json'), 'utf8'))
  assert.deepEqual(saved, { relay: url, relayKey: 'team-key' })
  assert.match((await run(process.execPath, [BIN, 'relay'], { env })).stdout, /\(default\).*key saved/)

  // No --server and no invite: uses the default relay, and the key lets it create the room.
  const dir = tmp('proj')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello')
  const child = spawn(process.execPath, [BIN, 'join', '--name', 'me'], { cwd: dir, env })
  let out = ''
  const invite = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('join did not start:\n' + out)), 10000)
    const onData = (d) => {
      out += d
      const m = out.match(/elegy join ([A-Za-z0-9_-]{20,})/)
      if (m) { clearTimeout(t); resolve(m[1]) }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
  })
  assert.match(out, /starting a new session on your default relay/)
  const inv = decodeInvite(invite)
  assert.equal(inv.server, url)
  assert.ok(!Buffer.from(invite, 'base64url').toString().includes('team-key'), 'the relay key is never in invites')
  child.kill('SIGTERM')
  await new Promise((r) => child.on('exit', r))

  await run(process.execPath, [BIN, 'relay', 'clear'], { env })
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.elegy', 'settings.json'), 'utf8')).relay, undefined)
  await srv.close()
})

test('checking a relay that is not there gives a clear error', async () => {
  const env = { ...process.env, HOME: tmp('home2') }
  await assert.rejects(run(process.execPath, [BIN, 'relay', 'check', 'ws://127.0.0.1:9'], { env }), (err) => /couldn't reach|no answer/.test(err.stderr))
})
