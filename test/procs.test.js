import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cowove.js')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cowove-home-'))
const env = { ...process.env, HOME: home }

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('cowove stop shuts down a running relay', async () => {
  const relay = spawn(process.execPath, [BIN, 'serve', '--port', '0', '--data', path.join(home, 'data')], { env, stdio: 'ignore' })
  const exited = new Promise((resolve) => relay.on('exit', resolve))
  const procs = path.join(home, '.cowove', 'procs')
  await waitFor(() => fs.existsSync(path.join(procs, `${relay.pid}.json`)))

  const out = execFileSync(process.execPath, [BIN, 'stop'], { env, encoding: 'utf8' })
  assert.match(out, new RegExp(`relay on :\\d+ \\(pid ${relay.pid}\\)`))
  await exited
  assert.deepEqual(fs.readdirSync(procs), [], 'registry is cleaned up')

  const again = execFileSync(process.execPath, [BIN, 'stop'], { env, encoding: 'utf8' })
  assert.match(again, /nothing to stop/)
})

test('stale registry entries are ignored and removed', async () => {
  const procs = path.join(home, '.cowove', 'procs')
  fs.mkdirSync(procs, { recursive: true })
  fs.writeFileSync(path.join(procs, '999999.json'), JSON.stringify({ pid: 999999, kind: 'relay', port: 1, startedAt: 0 }))
  const { listProcesses } = await import('../src/procs.js')
  process.env.HOME = home
  assert.deepEqual(listProcesses(), [])
  assert.equal(fs.existsSync(path.join(procs, '999999.json')), false)
})
