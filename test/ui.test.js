import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cowove-home-'))
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
  headers: { 'x-cowove-token': ui.token, 'content-type': 'application/json' },
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
    http.get({ host: '127.0.0.1', port: ui.port, path: '/api/state', headers: { host: 'evil.example.com', 'x-cowove-token': ui.token } }, (res) => resolve(res.statusCode))
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
    headers: { 'x-cowove-token': ui.token, 'x-filename': encodeURIComponent('notes.txt'), 'x-text': encodeURIComponent('see notes') },
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

test('agent feed workspace: tree, file, folder claim, sharing, feed', async () => {
  const dir = path.join(home, 'workspace')
  fs.mkdirSync(path.join(dir, 'src', 'auth'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'auth', 'login.ts'), 'export const login = 1\n')
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0, 1, 2, 3]))
  // A Claude Code conversation in this folder, so the reader has something to share.
  const { slugFor } = await import('../src/agents/claude-code.js')
  const tdir = path.join(home, '.claude', 'projects', slugFor(dir))
  fs.mkdirSync(tdir, { recursive: true })
  fs.writeFileSync(path.join(tdir, 't.jsonl'), [
    { type: 'user', uuid: 'u1', sessionId: 't', cwd: dir, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Add a login form' } },
    { type: 'assistant', uuid: 'a1', sessionId: 't', cwd: dir, timestamp: new Date().toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(dir, 'src/auth/login.ts') } }, { type: 'text', text: 'Added it.' }] } }
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')

  const created = await api('POST', '/api/sessions', { mode: 'create', dir, name: 'sam', tool: 'Claude Code', hostRelay: true })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const id = created.body.id

  const tree = await api('GET', `/api/sessions/${id}/tree`)
  const byPath = Object.fromEntries(tree.body.files.map((f) => [f.path, f]))
  assert.ok(byPath['src/auth/login.ts'])
  assert.equal(byPath['logo.png'].binary, true)
  assert.equal(byPath['src/auth/login.ts'].edited.by, 'sam')

  const text = await api('GET', `/api/sessions/${id}/file?path=${encodeURIComponent('src/auth/login.ts')}`)
  assert.equal(text.body.text, 'export const login = 1\n')
  const bin = await api('GET', `/api/sessions/${id}/file?path=logo.png`)
  assert.deepEqual(bin.body, { path: 'logo.png', binary: true, size: 6 })
  for (const bad of ['../secret', '/etc/passwd', 'src/../../x', 'nope.txt', '.cowove/config.json']) {
    const r = await api('GET', `/api/sessions/${id}/file?path=${encodeURIComponent(bad)}`)
    assert.equal(r.status, 404, bad)
  }

  const claim = await api('POST', `/api/sessions/${id}/claim`, { pattern: 'src/auth', note: 'rewriting auth' })
  assert.equal(claim.status, 200)
  const tree2 = await api('GET', `/api/sessions/${id}/tree`)
  assert.equal(tree2.body.files.find((f) => f.path === 'src/auth/login.ts').claim.pattern, 'src/auth')

  // The transcript was picked up and shared.
  let feed
  for (let i = 0; i < 40; i++) {
    feed = await api('GET', `/api/sessions/${id}/feed?who=sam`)
    if (feed.body.entries.length >= 3) break
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.deepEqual(feed.body.entries.map((e) => [e.kind, e.text]), [
    ['prompt', 'Add a login form'], ['action', 'Edited src/auth/login.ts'], ['reply', 'Added it.']
  ])

  assert.deepEqual((await api('POST', `/api/sessions/${id}/sharing`, { on: false })).body, { on: false })
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.cowove', 'config.json'), 'utf8'))
  assert.equal(cfg.shareAgent, false, 'pause is remembered')
  const st = await api('GET', '/api/state')
  assert.equal(st.body.sessions.find((s) => s.id === id).status.me.agent.sharing, false)
  await api('POST', `/api/sessions/${id}/sharing`, { on: true })
  feed = await api('GET', `/api/sessions/${id}/feed?who=sam`)
  assert.deepEqual(feed.body.entries.slice(-2).map((e) => e.kind), ['paused', 'resumed'])
  await api('POST', `/api/sessions/${id}/stop`)
})
