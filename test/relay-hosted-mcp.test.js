// Hosted agents: an AI with no computer joins a session through the relay's /mcp with a
// pass from the accounts API (no key), waits for the owner like anyone else, and then
// reads and writes the shared files, messages and claims as its own member.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'
import { signPass, PASS_TTL_MS } from '../src/passes.js'
import { PASS_KEYS, testPasses } from './pass-helpers.js'

process.env.HOME = process.env.USERPROFILE = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-hm-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-hm-${n}-`))
async function waitFor (fn, ms = 8000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const out = (r) => r.content.map((c) => c.text).join('\n')
const GROK = 'agent:agent-grok'
const hostedPass = (over = {}) => signPass({ v: 1, sub: 'agent-grok', kind: 'agent', name: 'Grok-Bot', key: '', exp: Date.now() + PASS_TTL_MS, ...over }, PASS_KEYS.privateKey)

let srv, http, carl, carlDir, grok
async function client (pass, headers = {}) {
  const c = new Client({ name: 'grok', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`${http}/mcp`), { requestInit: { headers: { ...(pass ? { 'x-quilt-pass': pass } : {}), ...headers } } }))
  return c
}
const call = (name, args = {}) => grok.callTool({ name, arguments: args })

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  http = `http://127.0.0.1:${srv.port}`
  const id = generateIdentity()
  carlDir = tmp('carl')
  fs.writeFileSync(path.join(carlDir, 'README.md'), '# Project\n')
  carl = new Session({ dir: carlDir, server: `ws://127.0.0.1:${srv.port}`, room: 'hm-1', secret: 's', viewSecret: 'v', name: 'Carl', tool: 'Claude Code', identity: id, passes: testPasses(id, { name: 'Carl', sub: 'user-carl' }) })
  await carl.start({ waitTimeoutMs: 5000 })
  await waitFor(() => carl.isOwner)
  grok = await client(hostedPass())
})
after(async () => { await grok?.close(); await carl.stop(); await srv.close() })

test('without a pass the hosted MCP is refused; with one, the tools are there', async () => {
  await assert.rejects(client(''), /sign in to continue/)
  const tools = (await grok.listTools()).tools.map((t) => t.name)
  for (const t of ['quilt_join_session', 'quilt_session_info', 'quilt_leave_session', 'quilt_status', 'quilt_read_file', 'quilt_write_file', 'quilt_message', 'quilt_claim', 'quilt_share']) assert.ok(tools.includes(t), t)
  const { TASK_WORKFLOW } = await import('../src/agent-task-workflow.js')
  const instructions = grok.getInstructions()
  assert.ok(instructions && instructions.includes(TASK_WORKFLOW), 'hosted MCP instructions embed TASK_WORKFLOW')
  assert.match(instructions, /grok the codebase/i)
})

test('before joining, tools say to join; a bad invite is refused without touching the room', async () => {
  const r = await call('quilt_status')
  assert.equal(r.isError, true)
  assert.match(out(r), /quilt_join_session/)
  assert.match(out(await call('quilt_join_session', { invite: 'https://join.heyquilt.com/hm-1#wrong' })), /Wrong room secret/)
  assert.match(out(await call('quilt_join_session', { invite: 'https://join.heyquilt.com/hm-nope#s' })), /isn't running/)
  assert.match(out(await call('quilt_join_session', { invite: 'nonsense' })), /not valid/)
})

test('joining puts the agent on the owner\'s list; the owner lets it in and it becomes an editor', async () => {
  const r = await call('quilt_join_session', { invite: 'https://join.heyquilt.com/hm-1#s' })
  assert.equal(r.isError, undefined)
  assert.match(out(r), /Asked to join room hm-1 as an editor/)
  await waitFor(() => carl.waiting.some((p) => p.key === GROK))
  assert.deepEqual(carl.waiting.map((p) => [p.key, p.name, p.kind, p.invitedAs]), [[GROK, 'Grok-Bot', 'agent', 'editor']])
  const waiting = await call('quilt_status')
  assert.equal(waiting.isError, true)
  assert.match(out(waiting), /not let you in yet/)
  assert.match(out(await call('quilt_session_info')), /not let you in yet/)

  await carl.approve(GROK, { role: 'editor' })
  await waitFor(() => carl.members.some((m) => m.key === GROK))
  assert.match(out(await call('quilt_session_info')), /you are Grok-Bot, an editor/)
  assert.equal(carl.waiting.length, 0)
  const status = out(await call('quilt_status'))
  assert.match(status, /You are Grok-Bot in a live quilt session \(room hm-1\)/)
  assert.match(status, /- Carl \(Claude Code\)/)
  // Joining again while a member is just a no-op.
  assert.match(out(await call('quilt_join_session', { invite: 'https://join.heyquilt.com/hm-1#s' })), /Joined room hm-1 as Grok-Bot \(editor\)/)
})

test('moving a task to In progress reminds the agent to grok → plan → build → test', async () => {
  const added = await call('quilt_add_task', { title: 'Wire agent workflow' })
  assert.ok(!added.isError, out(added))
  const id = out(added).split('\n').find((l) => /^[0-9a-f]{16}$/.test(l.trim()))
  assert.ok(id, `expected task id in:\n${out(added)}`)
  const moved = await call('quilt_move_task', { id: id.trim(), column: 'doing' })
  assert.ok(!moved.isError, out(moved))
  assert.match(out(moved), /Picked up "Wire agent workflow"/)
  assert.match(out(moved), /grok the codebase/i)
  assert.match(out(moved), /implement a plan/i)
  assert.match(out(moved), /build the change/i)
  assert.match(out(moved), /test it/i)
  assert.match(out(moved), /no "Verifying a change" section/)
  // Done needs evidence; "tested" is not evidence.
  const refused = await call('quilt_move_task', { id: id.trim(), column: 'done' })
  assert.ok(refused.isError)
  assert.match(out(refused), /needs `verified`/)
  assert.ok((await call('quilt_move_task', { id: id.trim(), column: 'done', verified: 'tested' })).isError)
  const done = await call('quilt_move_task', { id: id.trim(), column: 'done', verified: 'npm test passed (3 tests); opened the board and the new column rendered' })
  assert.ok(!done.isError, out(done))
  assert.match(out(done), /Moved "Wire agent workflow" to Done\. Verified: npm test passed/)
  assert.match(out(await call('quilt_tasks')), /verified: npm test passed \(3 tests\)/)
})

test('picking up a task briefs the agent: files, their recent changes, claims and the project checks', async () => {
  // The owner's AGENTS.md carries the project's checks; it syncs to the room like any file.
  fs.writeFileSync(path.join(carlDir, 'AGENTS.md'), '# Notes\n\n## Verifying a change\n\n- Run `npm test`.\n- Open the app and click through the board.\n\n## Other\n\nignored\n')
  fs.writeFileSync(path.join(carlDir, 'src.txt'), 'v1\n')
  await waitFor(async () => out(await call('quilt_read_file', { path: 'src.txt' })) === 'v1\n')
  assert.ok(!(await call('quilt_claim', { pattern: 'docs/**', note: 'rewriting the guide' })).isError)
  await waitFor(() => carl.claims.has('docs/**'))
  const added = out(await call('quilt_add_task', { title: 'Bump src', files: ['src.txt', 'docs/a.md'] }))
  const id = added.split('\n').find((l) => /^[0-9a-f]{16}$/.test(l.trim())).trim()
  const brief = out(await call('quilt_move_task', { id, column: 'doing' }))
  assert.match(brief, /^Picked up "Bump src" \[[0-9a-f]{16}\]\.\nFiles: src\.txt, docs\/a\.md/)
  assert.match(brief, /Recent changes to these files[^\n]*\n- \[\d+s ago\] Carl created src\.txt \(\+1 -0\)/)
  assert.doesNotMatch(brief, /AGENTS\.md \(/, 'changes to other files are left out')
  assert.doesNotMatch(brief, /Claims to respect/, 'my own claim is not a warning')
  assert.match(brief, /This project's checks \(from AGENTS\.md\):\n- Run `npm test`\.\n- Open the app and click through the board\./)
  assert.doesNotMatch(brief, /ignored/)
  assert.match(brief, /grok the codebase/i)
  // Another person's claim on one of the files is called out.
  await carl.claim('src.txt', 'mine for a minute')
  await waitFor(() => carl.claims.has('src.txt'))
  await call('quilt_move_task', { id, column: 'todo' })
  assert.match(out(await call('quilt_move_task', { id, column: 'doing' })), /Claims to respect[^\n]*\n- src\.txt by Carl \(mine for a minute\)/)
  // The refusal quotes the checks too.
  assert.match(out(await call('quilt_move_task', { id, column: 'done' })), /Run `npm test`/)
  await carl.release('src.txt')
  await call('quilt_release', { pattern: 'docs/**' })
  fs.rmSync(path.join(carlDir, 'AGENTS.md'))
})

test('the agent reads what the owner has, and what it writes lands on the owner\'s disk', async () => {
  assert.equal(out(await call('quilt_read_file', { path: 'README.md' })), '# Project\n')
  assert.match(out(await call('quilt_read_file', { path: 'missing.txt' })), /no file called missing.txt/)
  assert.match(out(await call('quilt_read_file', { path: '../etc/passwd' })), /not a path inside the project/)

  assert.match(out(await call('quilt_write_file', { path: './hello.md', content: 'hello from Grok\n' })), /Created hello.md/)
  await waitFor(() => read(carlDir, 'hello.md') === 'hello from Grok\n')
  assert.match(out(await call('quilt_write_file', { path: 'hello.md', content: 'hello from Grok\nand again\n' })), /Updated hello.md \(\+1 -0 lines\)/)
  await waitFor(() => read(carlDir, 'hello.md') === 'hello from Grok\nand again\n')

  fs.writeFileSync(path.join(carlDir, 'notes.txt'), 'owner notes')
  await waitFor(async () => out(await call('quilt_read_file', { path: 'notes.txt' })) === 'owner notes')
  const list = out(await call('quilt_list_files'))
  for (const f of ['README.md', 'hello.md', 'notes.txt']) assert.match(list, new RegExp(`- ${f}`))
  const status = out(await call('quilt_status'))
  assert.match(status, /Grok-Bot created hello.md|Grok-Bot edited hello.md/)
  // The owner sees the agent as a member who is online.
  await waitFor(() => carl.members.find((m) => m.key === GROK)?.online === true)
})

test('the chronology records hosted and local changes with diffs, and is queryable', async () => {
  // The owner is working a task; Grok has none in progress.
  const task = carl.addTask({ title: 'Owner notes', assignee: 'me', column: 'doing' })
  fs.writeFileSync(path.join(carlDir, 'notes.txt'), 'owner notes\nmore\n')
  await waitFor(() => carl.history.entries().some((e) => e.path === 'notes.txt' && /\+more/.test(e.diff)))

  const all = out(await call('quilt_history'))
  // Grok's two writes within seconds fold into one entry; so do Carl's two saves of notes.txt.
  assert.match(all, /Grok-Bot created hello\.md \(\+2 -0\)/)
  assert.match(all, /Carl created notes\.txt \(\+2 -0\) for "Owner notes" \[/)
  const mine = out(await call('quilt_history', { by: 'grok-bot', with_diff: true }))
  assert.match(mine, /hello\.md/)
  assert.doesNotMatch(mine, /notes\.txt/)
  assert.match(mine, /\+hello from Grok/)
  assert.match(out(await call('quilt_history', { path: 'notes.txt', task: task.id })), /Carl created notes\.txt/)
  assert.equal(out(await call('quilt_history', { path: 'src/**' })), 'No changes match.')
  assert.match(out(await call('quilt_history', { since: 'soonish' })), /since: use a duration/)
  // The owner's local query sees the same record.
  assert.ok(carl.historyQuery({ by: 'Grok-Bot' }).every((e) => e.by === 'Grok-Bot'))
  assert.ok(carl.historyQuery({ since: '1h' }).length >= 2)
  assert.throws(() => carl.historyQuery({ since: 'nope' }), /since: use a duration/)
  carl.deleteTask(task.id)
})

test('messages, shares and claims reach the owner, and claims are respected', async () => {
  await call('quilt_message', { text: 'hello from the cloud' })
  await waitFor(() => carl.chat.toArray().some((m) => m.by === 'Grok-Bot' && m.text === 'hello from the cloud'))
  await call('quilt_share', { request: 'Write the docs', summary: 'Plan: a README section.' })
  await waitFor(() => carl.agentFeedFor('Grok-Bot').length === 2)

  assert.match(out(await call('quilt_claim', { pattern: 'docs/**', note: 'writing docs' })), /Claimed docs\/\*\*/)
  await waitFor(() => [...carl.claims.values()].some((c) => c.pattern === 'docs/**' && c.by === 'Grok-Bot'))
  const again = await call('quilt_claim', { pattern: 'docs/**' })
  assert.equal(again.isError, undefined, 'a claim of your own is fine')
  assert.match(out(await call('quilt_release', { pattern: 'docs/**' })), /Released docs\/\*\*/)
  await waitFor(() => ![...carl.claims.values()].some((c) => c.pattern === 'docs/**'))

  // The owner claims a file: the agent may not write it.
  await carl.claim('README.md', 'mine')
  await waitFor(async () => /README.md is claimed by Carl/.test(out(await call('quilt_write_file', { path: 'README.md', content: 'x' }))))
  await carl.release('README.md')
})

test('quilt_inbox shows mentions, direct messages and tasks handed to the hosted agent since it joined', async () => {
  carl.say('@Grok-Bot the README needs a usage section')
  carl.say('between us: keep it short', { to: 'Grok-Bot' })
  carl.say('nothing for the bot here')
  const task = carl.addTask({ title: 'Write the usage section', assignee: 'Grok-Bot', files: ['README.md'] })
  await waitFor(async () => /Write the usage section/.test(out(await call('quilt_tasks'))))
  const inbox = out(await call('quilt_inbox'))
  assert.match(inbox, /- Carl mentioned you in chat: @Grok-Bot the README needs a usage section/)
  assert.match(inbox, /- Carl sent you a direct message: between us: keep it short/)
  assert.match(inbox, new RegExp(`- Carl handed you a task: "Write the usage section" \\(id ${task.id}\\)\\. Files: README\\.md`))
  assert.doesNotMatch(inbox, /nothing for the bot here/)
  assert.doesNotMatch(inbox, /hello from the cloud/, 'its own messages')
  assert.equal(out(await call('quilt_inbox')), 'Nothing new for you.')
  carl.deleteTask(task.id)
})

test('an agent that sends an old image is told to update in every answer; quilt_check_update answers for any image', async () => {
  const names = (await grok.listTools()).tools.map((t) => t.name)
  assert.ok(names.includes('quilt_check_update'))
  assert.match(out(await call('quilt_check_update')), /^Quilt \d+\.\d+\.\d+ is current \(the newest release is \d+\.\d+\.\d+\)\./, 'no image given: the relay checks its own')
  assert.match(out(await call('quilt_check_update', { image: '0.0.1' })), /^You must update your app: you run Quilt 0\.0\.1 and \d+\.\d+\.\d+ is out\. Update Quilt/)
  assert.doesNotMatch(out(await call('quilt_status')), /update your app/)
  const old = await client(hostedPass(), { 'x-quilt-image': '0.0.1' })
  try {
    const r = await old.callTool({ name: 'quilt_status', arguments: {} })
    assert.match(out(r), /You are Grok-Bot in a live quilt session/)
    assert.match(out(r), /\n⚠️ You must update your app: you run Quilt 0\.0\.1 and \d+\.\d+\.\d+ is out/)
    assert.match(out(await old.callTool({ name: 'quilt_check_update', arguments: {} })), /^You must update your app: you run Quilt 0\.0\.1/)
  } finally {
    await old.close()
  }
})

test('the owner can limit the agent to folders, make it a viewer, or remove it', async () => {
  await carl.setMember(GROK, { scopes: ['docs'] })
  await waitFor(async () => /only change files in docs/.test(out(await call('quilt_write_file', { path: 'src/x.js', content: 'x' }))))
  assert.match(out(await call('quilt_write_file', { path: 'docs/guide.md', content: 'guide' })), /Created docs\/guide.md/)
  await waitFor(() => read(carlDir, 'docs/guide.md') === 'guide')

  await carl.setMember(GROK, { role: 'viewer', scopes: [] })
  await waitFor(async () => /only view this session/.test(out(await call('quilt_write_file', { path: 'docs/guide.md', content: 'nope' }))))
  assert.equal(out(await call('quilt_read_file', { path: 'docs/guide.md' })), 'guide', 'viewers still read')

  await carl.removeMember(GROK)
  await waitFor(async () => { const r = await call('quilt_status'); return r.isError && /no longer in that session/.test(out(r)) })
  assert.match(out(await call('quilt_leave_session')), /Left room hm-1/)
  assert.match(out(await call('quilt_session_info')), /not in a session/)
})

test('a hosted agent in an uncontrolled room (no owner) is an editor straight away', async () => {
  const id = generateIdentity()
  const dir = tmp('dana')
  const dana = new Session({ dir, server: `ws://127.0.0.1:${srv.port}`, room: 'hm-open', secret: 's', name: 'Dana', identity: id, passes: testPasses(id) })
  await dana.start({ waitTimeoutMs: 5000 })
  try {
    assert.match(out(await call('quilt_join_session', { invite: 'https://join.heyquilt.com/hm-open#s' })), /Joined room hm-open as Grok-Bot \(editor\)/)
    await call('quilt_write_file', { path: 'open.txt', content: 'open' })
    await waitFor(() => read(dir, 'open.txt') === 'open')
  } finally { await dana.stop() }
})

test('a hosted agent whose room pass has a grant gets straight in, with that access', async () => {
  const access = { files: 'edit', folders: [], foldersExcept: ['secrets'], talk: false }
  const gem = await client(hostedPass({ sub: 'agent-gem', name: 'Gem', room: 'hm-1', access }))
  const gemCall = (name, args = {}) => gem.callTool({ name, arguments: args })
  try {
    assert.match(out(await gemCall('quilt_join_session', { invite: 'https://join.heyquilt.com/hm-1#v' })), /Joined room hm-1 as Gem \(editor\)/)
    await waitFor(() => carl.members.some((m) => m.key === 'agent:agent-gem' && m.talk === false))
    assert.ok(!carl.waiting.some((p) => p.key === 'agent:agent-gem'), 'no prompt for the owner')
    assert.match(out(await gemCall('quilt_session_info')), /an editor, not in secrets, and you may not post/)
    assert.match(out(await gemCall('quilt_status')), /You may not post in this session/)
    const said = await gemCall('quilt_message', { text: 'hello' })
    assert.deepEqual([said.isError, out(said)], [true, "You can't post in this session."])
    assert.equal(out(await gemCall('quilt_share', { summary: 'plan' })), "You can't post in this session.")
    assert.equal(out(await gemCall('quilt_write_file', { path: 'secrets/token.txt', content: 'x' })), 'You may not change files in secrets.')
    assert.match(out(await gemCall('quilt_write_file', { path: 'gem.txt', content: 'from Gem' })), /Created gem.txt/)
    await waitFor(() => read(carlDir, 'gem.txt') === 'from Gem')
    assert.match(out(await gemCall('quilt_claim', { pattern: 'gem/**', note: 'everyone, read this' })), /Claimed gem/)
    assert.equal(srv.rooms.get('hm-1').meta.claims['gem/**'].note, '', 'a claim, but not its note')
  } finally { await gem.close() }
})

test('a granted agent whose pass names no room is asked to call again, never told it was removed', async () => {
  // Gem joined hm-1 by its grant (above). Its pass from an API that just restarted names no room.
  const rpc = (name, args = {}) => fetch(`${http}/mcp`, { method: 'POST', headers: { 'x-quilt-pass': hostedPass({ sub: 'agent-gem', name: 'Gem' }), 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const res = await rpc('quilt_status')
  assert.equal(res.headers.get('x-quilt-room'), 'hm-1')
  assert.equal(res.headers.get('x-quilt-retry'), 'room-pass', 'the API retries with a pass for that room')
  const body = await res.text()
  assert.match(body, /Call the same tool again/)
  assert.doesNotMatch(body, /no longer in that session/)
  // With a pass for the room, the same call works.
  const gem = await client(hostedPass({ sub: 'agent-gem', name: 'Gem', room: 'hm-1', access: { files: 'edit', folders: [], foldersExcept: ['secrets'], talk: false } }))
  try { assert.match(out(await gem.callTool({ name: 'quilt_status', arguments: {} })), /Carl/) } finally { await gem.close() }
})

test('the relay tells the accounts API which session a hosted agent is in', async () => {
  const pass = hostedPass({ sub: 'agent-gem', name: 'Gem' })
  const res = await fetch(`${http}/mcp`, { method: 'POST', headers: { 'x-quilt-pass': pass, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
  assert.equal(res.headers.get('x-quilt-room'), 'hm-1')
  const other = await fetch(`${http}/mcp`, { method: 'POST', headers: { 'x-quilt-pass': hostedPass({ sub: 'agent-new', name: 'New' }), 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
  assert.equal(other.headers.get('x-quilt-room'), null, 'in no session')
})
