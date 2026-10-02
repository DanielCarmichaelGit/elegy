import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-home-'))
process.env.HOME = home // keep recent.json, account.json and the identity out of the real home

const { startUi } = await import('../src/ui-server.js')
const { startServer } = await import('../src/server.js')
const { startTestApi, linkDevice } = await import('./api-helpers.js')
const { newPassKeys } = await import('../src/passes.js')
const { loadIdentity } = await import('../src/identity.js')
const { saveAccount } = await import('../src/account.js')
let ui, base, relay, accounts
let shutdowns = 0

before(async () => {
  // A signed-in computer: an accounts API that signs passes, a relay that needs them, and account.json.
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  const { token } = await linkDevice(accounts, 'mem', loadIdentity())
  saveAccount({ token, account: { id: 'mem', name: 'Mo', email: 'mo@acme.com' }, signedInAt: Date.now() })
  ui = await startUi({ port: 0, onShutdown: () => { shutdowns++ } })
  base = `http://127.0.0.1:${ui.port}`
})
after(async () => { await ui.close(); await relay.close(); await accounts.close() })

const api = (method, p, body) => fetch(base + p, {
  method,
  headers: { 'x-quilt-token': ui.token, 'content-type': 'application/json' },
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
    http.get({ host: '127.0.0.1', port: ui.port, path: '/api/state', headers: { host: 'evil.example.com', 'x-quilt-token': ui.token } }, (res) => resolve(res.statusCode))
  })
  assert.equal(status, 403)
})

test('create a session, chat, send a file, stop', async () => {
  const dir = path.join(home, 'proj')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello')
  const created = await api('POST', '/api/sessions', { mode: 'create', dir, tool: 'Claude Code' })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const id = created.body.id
  assert.ok(created.body.invite)
  assert.equal(created.body.status.me.name, 'Mo', 'named after the account')

  const said = await api('POST', `/api/sessions/${id}/say`, { text: 'hi' })
  assert.equal(said.body.text, 'hi')

  const up = await fetch(`${base}/api/sessions/${id}/send`, {
    method: 'POST',
    headers: { 'x-quilt-token': ui.token, 'x-filename': encodeURIComponent('notes.txt'), 'x-text': encodeURIComponent('see notes') },
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
  assert.match(r.body.error, /invite link is not valid/)
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

  const created = await api('POST', '/api/sessions', { mode: 'create', dir, tool: 'Claude Code' })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const id = created.body.id

  const tree = await api('GET', `/api/sessions/${id}/tree`)
  const byPath = Object.fromEntries(tree.body.files.map((f) => [f.path, f]))
  assert.ok(byPath['src/auth/login.ts'])
  assert.equal(byPath['logo.png'].binary, true)
  assert.equal(byPath['src/auth/login.ts'].edited.by, 'Mo')

  const text = await api('GET', `/api/sessions/${id}/file?path=${encodeURIComponent('src/auth/login.ts')}`)
  assert.equal(text.body.text, 'export const login = 1\n')
  const bin = await api('GET', `/api/sessions/${id}/file?path=logo.png`)
  assert.deepEqual(bin.body, { path: 'logo.png', binary: true, size: 6 })
  for (const bad of ['../secret', '/etc/passwd', 'src/../../x', 'nope.txt', '.quilt/config.json']) {
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
    feed = await api('GET', `/api/sessions/${id}/feed?who=Mo`)
    if (feed.body.entries.length >= 3) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.deepEqual(feed.body.entries.map((e) => [e.kind, e.text]), [
    ['prompt', 'Add a login form'], ['action', 'Edited src/auth/login.ts'], ['reply', 'Added it.']
  ])

  assert.deepEqual((await api('POST', `/api/sessions/${id}/sharing`, { on: false })).body, { on: false })
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.quilt', 'config.json'), 'utf8'))
  assert.equal(cfg.shareAgent, false, 'pause is remembered')
  const st = await api('GET', '/api/state')
  assert.equal(st.body.sessions.find((s) => s.id === id).status.me.agent.sharing, false)
  await api('POST', `/api/sessions/${id}/sharing`, { on: true })
  feed = await api('GET', `/api/sessions/${id}/feed?who=Mo`)
  assert.deepEqual(feed.body.entries.slice(-2).map((e) => e.kind), ['paused', 'resumed'])
  await api('POST', `/api/sessions/${id}/stop`)
})

test("a session that ran on this computer's own relay is marked, and can't be reopened", async () => {
  const dir = path.join(home, 'old-local')
  fs.mkdirSync(path.join(dir, '.quilt'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.quilt', 'config.json'), JSON.stringify({ server: 'ws://127.0.0.1:4321', room: 'room-old', secret: 's', name: 'me' }))
  const recentFile = path.join(home, '.quilt', 'recent.json')
  const list = fs.existsSync(recentFile) ? JSON.parse(fs.readFileSync(recentFile, 'utf8')) : []
  fs.writeFileSync(recentFile, JSON.stringify([{ dir, room: 'room-old', server: 'ws://127.0.0.1:4321', name: 'me', tool: 'Cursor', lastUsed: Date.now() }, ...list]))
  const st = await api('GET', '/api/state')
  assert.equal(st.body.recent.find((r) => r.dir === dir).unsupported, true)
  assert.equal(st.body.relay, undefined, 'no relay settings any more')
  assert.ok(st.body.recent.filter((r) => r.dir !== dir).every((r) => r.unsupported === false))
  const r = await api('POST', '/api/sessions', { mode: 'rejoin', dir })
  assert.equal(r.status, 400)
  assert.equal(r.body.error, "This session ran on your computer's own relay, which Quilt no longer supports. Your files are untouched.")
  assert.ok(fs.existsSync(path.join(dir, '.quilt', 'config.json')), 'the folder is untouched')
  assert.equal((await api('POST', '/api/relay/check', { url: 'ws://127.0.0.1:9' })).status, 404)
})

test('a session on a tunnel to a computer\'s own relay is unsupported too', async () => {
  const dir = path.join(home, 'old-tunnel')
  const server = 'wss://quiet-fox.trycloudflare.com'
  fs.mkdirSync(path.join(dir, '.quilt'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.quilt', 'config.json'), JSON.stringify({ server, room: 'room-tun', secret: 's', name: 'me' }))
  const recentFile = path.join(home, '.quilt', 'recent.json')
  const list = fs.existsSync(recentFile) ? JSON.parse(fs.readFileSync(recentFile, 'utf8')) : []
  fs.writeFileSync(recentFile, JSON.stringify([{ dir, room: 'room-tun', server, name: 'me', tool: 'Cursor', lastUsed: Date.now() }, ...list]))
  const st = await api('GET', '/api/state')
  assert.equal(st.body.recent.find((r) => r.dir === dir).unsupported, true)
  assert.equal(st.body.defaults.relay, process.env.QUILT_SERVER, 'the app knows which relay invites may name')
  const r = await api('POST', '/api/sessions', { mode: 'rejoin', dir })
  assert.equal(r.status, 400)
  assert.equal(r.body.error, "This session ran on your computer's own relay, which Quilt no longer supports. Your files are untouched.")
})

test('a crafted invite can\'t name another relay, or put the folder outside the join folder', async () => {
  const invalid = 'That invite link is not valid. Copy the whole link they sent.'
  const before = fs.readdirSync(home).sort()
  for (const invite of ['https://evil.example/join/..%2F..%2F..#x', 'https://evil.example/join/room-ok#x', `http://127.0.0.1:${relay.port}/join/..%2F..#x`]) {
    const r = await api('POST', '/api/sessions', { mode: 'join', invite })
    assert.equal(r.status, 400, invite)
    assert.equal(r.body.error, invalid, invite)
  }
  assert.deepEqual(fs.readdirSync(home).sort(), before, 'no folder was made or synced')
  const { underJoinDir } = await import('../src/ui-server.js')
  const root = path.join(home, 'Quilt')
  assert.equal(underJoinDir(root, 'room-1a2b'), path.join(root, 'room-1a2b'))
  for (const name of ['..', '../..', '../../etc', '/etc', 'a/b', '', '.']) {
    assert.throws(() => underJoinDir(root, name), (err) => err.status === 400 && err.message === invalid, JSON.stringify(name))
  }
})

test('settings: colour and AI tool are saved and used by new sessions; the name comes from the account', async () => {
  assert.equal((await api('POST', '/api/settings', { color: 'red' })).status, 400)
  assert.equal((await api('POST', '/api/settings', { tool: 'Notepad' })).status, 400)
  const renamed = await api('POST', '/api/settings', { name: 'Robin' })
  assert.equal(renamed.status, 400)
  assert.equal(renamed.body.error, 'Change your name on heyquilt.com.')
  const saved = await api('POST', '/api/settings', { color: '#3b6a9a', tool: 'Cursor', shareAgent: false })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.name, 'Mo')
  assert.equal(saved.body.shareAgent, false)
  assert.equal((await api('GET', '/api/state')).body.profile.color, '#3b6a9a')

  const dir = path.join(home, 'profiled')
  const s = await api('POST', '/api/sessions', { mode: 'create', dir })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.equal(s.body.status.me.name, 'Mo')
  assert.equal(s.body.status.me.tool, 'Cursor')
  assert.equal(s.body.status.me.color, '#3b6a9a')
  assert.equal(s.body.status.me.agent.sharing, false, 'sharing follows the setting')
  await api('POST', `/api/sessions/${s.body.id}/stop`)

  const forgot = await api('POST', '/api/recent/forget', { dir })
  assert.ok(!forgot.body.recent.some((r) => r.dir === dir))
  assert.ok(fs.existsSync(path.join(dir, '.quilt', 'config.json')), 'forgetting leaves the folder alone')
})

test('the owner can end a session for everyone from the app', async () => {
  const dir = path.join(home, 'ending')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'bye')
  const created = await api('POST', '/api/sessions', { mode: 'create', dir, tool: 'Claude Code' })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const id = created.body.id
  for (let i = 0; i < 50; i++) {
    const state = await api('GET', '/api/state')
    const s = state.body.sessions.find((s) => s.id === id)
    if (s?.status?.access?.owner) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const r = await api('POST', `/api/sessions/${id}/end`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body, { ok: true })
  const state = await api('GET', '/api/state')
  assert.equal(state.body.sessions.filter((s) => s.id === id).length, 0, 'stopped locally')
})

test('GET /api/version: this version, its notes, and whether GitHub has a newer build', async () => {
  const http = await import('node:http')
  const { currentVersion } = await import('../src/releases.js')
  const gh = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://github.com/x/releases/tag/v99.0.0', published_at: '2027-01-01T00:00:00Z', body: "**What's new in 99.0.0**\n\nEverything.\n\n- **Teleports.**\n\n**Downloads**\n- x" }))
  })
  await new Promise((r) => gh.listen(0, '127.0.0.1', r))
  process.env.QUILT_RELEASES_URL = `http://127.0.0.1:${gh.address().port}/latest`
  try {
    const r = await api('GET', '/api/version')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.version, currentVersion())
    assert.equal(r.body.releases[0].version, currentVersion())
    assert.ok(r.body.releases[0].items.length > 0)
    assert.equal(r.body.unseen, true, 'notes for this version have not been shown yet')
    assert.equal(r.body.outOfDate, true)
    assert.deepEqual(r.body.latest, { version: '99.0.0', url: 'https://github.com/x/releases/tag/v99.0.0', date: '2027-01-01', summary: 'Everything.', items: ['**Teleports.**'] })
    assert.match(r.body.downloadUrl, /^https:\/\/github\.com\/DanielCarmichaelGit\/heyquilt\/releases\/latest/)

    const seen = await api('POST', '/api/version/seen')
    assert.deepEqual(seen.body, { ok: true })
    const again = await api('GET', '/api/version')
    assert.equal(again.body.unseen, false)
  } finally {
    delete process.env.QUILT_RELEASES_URL
    gh.close()
  }
})
