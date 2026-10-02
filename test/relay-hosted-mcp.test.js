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

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-hm-home-'))
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
async function client (pass) {
  const c = new Client({ name: 'grok', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`${http}/mcp`), { requestInit: { headers: pass ? { 'x-quilt-pass': pass } : {} } }))
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
