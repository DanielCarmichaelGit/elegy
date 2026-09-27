import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elegy-home-'))
process.env.HOME = home // keep recent.json and relay data out of the real home

const { startUi } = await import('../src/ui-server.js')
let ui, base
let shutdowns = 0

before(async () => {
  ui = await startUi({ port: 0, relayPort: 0, onShutdown: () => { shutdowns++ } })
  base = `http://127.0.0.1:${ui.port}`
})
after(async () => { await ui.close() })

const api = (method, p, body) => fetch(base + p, {
  method,
  headers: { 'x-elegy-token': ui.token, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))

test('serves the app and logo without a token', async () => {
  const page = await fetch(base + '/')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<script type="module" src="\/app.js">/)
  assert.equal((await fetch(base + '/logo.svg')).headers.get('content-type'), 'image/svg+xml')
})

test('API requires the launch token', async () => {
  const r = await fetch(base + '/api/state')
  assert.equal(r.status, 401)
})

test('rejects requests for other hostnames (DNS rebinding)', async () => {
  const http = await import('node:http')
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: ui.port, path: '/api/state', headers: { host: 'evil.example.com', 'x-elegy-token': ui.token } }, (res) => resolve(res.statusCode))
  })
  assert.equal(status, 403)
})

test('create a hosted session, chat, send a file, stop', async () => {
  const dir = path.join(home, 'proj')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello')
  const created = await api('POST', '/api/sessions', { mode: 'create', dir, name: 'alice', tool: 'Claude Code', hostRelay: true })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const id = created.body.id
  assert.ok(created.body.invite)
  assert.equal(created.body.status.me.name, 'alice')

  const said = await api('POST', `/api/sessions/${id}/say`, { text: 'hi' })
  assert.equal(said.body.text, 'hi')

  const up = await fetch(`${base}/api/sessions/${id}/send`, {
    method: 'POST',
    headers: { 'x-elegy-token': ui.token, 'x-filename': encodeURIComponent('notes.txt'), 'x-text': encodeURIComponent('see notes') },
    body: 'some notes'
  })
  const sent = await up.json()
  assert.equal(sent.file.name, 'notes.txt')
  const dl = await fetch(`${base}/api/sessions/${id}/files/${sent.id}?t=${ui.token}`)
  assert.equal(await dl.text(), 'some notes')

  const { body: { messages } } = await api('GET', `/api/sessions/${id}/messages`)
  assert.deepEqual(messages.map((m) => m.text), ['hi', 'see notes'])

  const state = await api('GET', '/api/state')
  assert.equal(state.body.sessions.length, 1)
  await api('POST', `/api/sessions/${id}/stop`)
  const after = await api('GET', '/api/state')
  assert.equal(after.body.sessions.length, 0)
  assert.equal(after.body.recent[0].dir, dir, 'stopped session shows up under Recent')
})

test('bad invite gives a friendly error', async () => {
  const r = await api('POST', '/api/sessions', { mode: 'join', dir: path.join(home, 'x'), invite: 'nonsense' })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /invite code is not valid/)
})

test('shut down asks the host to stop everything', async () => {
  const r = await api('POST', '/api/shutdown')
  assert.equal(r.status, 200)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(shutdowns, 1)
})
