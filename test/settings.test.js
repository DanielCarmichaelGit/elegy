// Settings: your colour, AI tool and session defaults. There is one relay now;
// relay settings from before are ignored and dropped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getSettings, saveSettings, relayUrl, isHostedRelay, ranOnLocalRelay, HOSTED_RELAY } from '../src/settings.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'quilt.js')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-settings-home-'))
process.env.HOME = home
delete process.env.QUILT_SERVER

test('relay settings from before are ignored, and dropped the next time settings are saved', () => {
  const file = path.join(home, '.quilt', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ relay: 'wss://mine.example.com', relayKey: 'k', relayMode: 'local', publicUrl: 'wss://tunnel.example.com', tool: 'Cursor' }))
  assert.deepEqual(getSettings(), { tool: 'Cursor' })
  saveSettings({ color: '#3b6a9a' })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { tool: 'Cursor', color: '#3b6a9a' })
})

test('Quilt uses the hosted relay unless QUILT_SERVER says otherwise', () => {
  assert.equal(HOSTED_RELAY, 'wss://relay.heyquilt.com')
  assert.equal(relayUrl(), HOSTED_RELAY)
  process.env.QUILT_SERVER = 'ws://127.0.0.1:4999'
  try {
    assert.equal(relayUrl(), 'ws://127.0.0.1:4999')
    assert.equal(ranOnLocalRelay('ws://127.0.0.1:4999'), false, 'the development relay in use still reopens')
  } finally {
    delete process.env.QUILT_SERVER
  }
})

test("the hosted relay under either address, and sessions that ran on a computer's own relay", () => {
  assert.equal(isHostedRelay('wss://relay.heyquilt.com'), true)
  assert.equal(isHostedRelay('wss://cowove-relay.fly.dev/'), true)
  assert.equal(isHostedRelay('wss://relay.example.com'), false)
  assert.equal(ranOnLocalRelay('ws://127.0.0.1:4321'), true)
  assert.equal(ranOnLocalRelay('ws://192.168.1.4:4321'), true)
  assert.equal(ranOnLocalRelay('wss://cowove-relay.fly.dev'), false)
  assert.equal(ranOnLocalRelay(undefined), false)
})

test('quilt relay is gone', () => {
  const r = spawnSync(process.execPath, [BIN, 'relay', 'set', 'wss://x.example.com'], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unknown command: relay/)
})
