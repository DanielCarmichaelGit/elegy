// An AI agent joins a session on its own through the MCP server, then uses
// the workspace tools. Runs the real `quilt mcp` over stdio.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { encodeInvite } from '../src/runner.js'
import { startTestApi, API_URL } from './api-helpers.js'
import { newPassKeys } from '../src/passes.js'
import { agentJoin } from '../src/agent-join.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'quilt.js')
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-mcp-${n}-`))
let relay, human, client, humanDir, agentCwd, accounts, home
const text = (r) => r.content.map((c) => c.text).join('\n')
const call = async (name, args = {}) => client.callTool({ name, arguments: args })
async function waitFor (fn, ms = 8000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)) }
  throw new Error('timed out')
}

before(async () => {
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  humanDir = tmp('human')
  fs.mkdirSync(path.join(humanDir, 'src'))
  fs.writeFileSync(path.join(humanDir, 'src', 'app.js'), 'console.log("hi")\n')
  human = new Session({ dir: humanDir, server: `ws://127.0.0.1:${relay.port}`, room: 'pair', secret: 's3cret', name: 'dana' })
  await human.start({ waitTimeoutMs: 5000 })
  agentCwd = tmp('agent')
  home = tmp('home')
  // The agent joined Quilt first (as `quilt agent join` does); sessions then use its keys.
  accounts = await startTestApi({ passKey: newPassKeys().privateKey })
  const link = (await accounts.call('POST', '/v1/agent-invites', {}, 'mem')).body.link.replace(API_URL, accounts.api.url)
  await agentJoin({ link, name: 'helper', dir: path.join(home, '.quilt'), log: () => {} })
  client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: agentCwd, env: { ...process.env, HOME: home, QUILT_SERVER: `ws://127.0.0.1:${relay.port}` }, stderr: 'ignore' }))
})

after(async () => {
  await client?.close().catch(() => {})
  await human?.stop()
  await relay?.close()
  await accounts?.close()
})

test('exposes the join and workspace tools', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name)
  for (const n of ['quilt_join_session', 'quilt_start_session', 'quilt_leave_session', 'quilt_session_info', 'quilt_partner_feed', 'quilt_list_files', 'quilt_status', 'quilt_claim']) {
    assert.ok(names.includes(n), n)
  }
})

test('without a session, tools explain how to join', async () => {
  const r = await call('quilt_status')
  assert.equal(r.isError, true)
  assert.match(text(r), /quilt_join_session/)
})

test('an agent refuses invites naming another relay, or a room that is a path', async () => {
  for (const invite of ['https://evil.example/join/..%2F..%2F..#x', 'https://evil.example/join/pair#s3cret', `http://127.0.0.1:${relay.port}/join/..%2F..#x`]) {
    const r = await call('quilt_join_session', { invite })
    assert.equal(r.isError, true, invite)
    assert.equal(text(r), 'Could not join: That invite link is not valid. Copy the whole link they sent.', invite)
  }
  assert.deepEqual(fs.readdirSync(agentCwd), [], 'nothing was synced')
  const { roomFolder } = await import('../src/mcp.js')
  assert.equal(roomFolder(agentCwd, 'room-1a2b'), path.join(agentCwd, 'quilt-room-1a2b'))
  for (const room of ['a/../..', 'x/../../etc', '/../..']) {
    assert.throws(() => roomFolder(agentCwd, room), /That invite link is not valid/, room)
  }
})

test('an agent joins by invite and shows up as an agent', async () => {
  const invite = encodeInvite({ server: `ws://127.0.0.1:${relay.port}`, room: 'pair', secret: 's3cret' })
  const r = await call('quilt_join_session', { invite: `quilt join ${invite}` })
  assert.ok(!r.isError, text(r))
  assert.match(text(r), /Joined room pair/)
  // The empty current folder became the project folder, and files arrived.
  assert.equal(fs.readFileSync(path.join(agentCwd, 'src', 'app.js'), 'utf8'), 'console.log("hi")\n')
  const peer = await waitFor(() => human.status().peers.find((p) => p.kind === 'agent'))
  assert.equal(peer.name, 'helper', 'named after the saved agent')
  assert.equal(peer.tool, 'Claude Code')
  // Joining twice is refused.
  assert.equal((await call('quilt_join_session', { invite })).isError, true)
})

test('the agent can read a partner\'s AI feed and the file tree', async () => {
  human.pushAgentEntries([
    { id: 'p', tool: 'Cursor', conv: 'c', kind: 'prompt', text: 'Refactor the auth module', ts: Date.now() },
    { id: 'a', tool: 'Cursor', conv: 'c', kind: 'action', text: 'Edited src/auth.js', ts: Date.now() }
  ])
  await human.claim('src/auth', 'refactoring')
  const list = await waitFor(async () => { const t = text(await call('quilt_partner_feed')); return t.includes('dana') && t })
  assert.match(list, /dana/)
  const feed = await waitFor(async () => { const t = text(await call('quilt_partner_feed', { who: 'dana' })); return t.includes('Refactor') && t })
  assert.match(feed, /dana asked: Refactor the auth module/)
  assert.match(feed, /· Edited src\/auth.js/)
  const files = text(await call('quilt_list_files'))
  assert.match(files, /src\/app\.js/)
  assert.match(files, /Claims: src\/auth \(dana: refactoring\)/)
  assert.match(text(await call('quilt_status')), /dana/)
})

test('agent edits sync back to people, and leaving removes the agent', async () => {
  fs.writeFileSync(path.join(agentCwd, 'src', 'app.js'), 'console.log("hi from the agent")\n')
  await waitFor(() => fs.readFileSync(path.join(humanDir, 'src', 'app.js'), 'utf8').includes('agent'))
  const info = text(await call('quilt_session_info'))
  assert.match(info, /Invite link.*\/join\/pair#s3cret/)
  assert.match(text(await call('quilt_leave_session')), /Left the session/)
  await waitFor(() => !human.status().peers.some((p) => p.kind === 'agent'))
})

const rx = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

test("an agent started in a person's folder works in its own copy and leaves theirs alone", async (t) => {
  // Dana's own folder for the room, from the app: saved, but not being synced right now.
  const personDir = tmp('person')
  fs.mkdirSync(path.join(personDir, '.quilt'))
  fs.writeFileSync(path.join(personDir, 'notes.md'), 'mine\n')
  const saved = { server: `ws://127.0.0.1:${relay.port}`, room: 'pair', secret: 's3cret', name: 'dana', tool: 'Cursor' }
  fs.writeFileSync(path.join(personDir, '.quilt', 'config.json'), JSON.stringify(saved))
  const c2 = new Client({ name: 'claude-code', version: '1.0.0' })
  await c2.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: personDir, env: { ...process.env, HOME: home, QUILT_SERVER: `ws://127.0.0.1:${relay.port}` }, stderr: 'ignore' }))
  t.after(() => c2.close().catch(() => {}))
  const call2 = (name, args = {}) => c2.callTool({ name, arguments: args })
  const invite = encodeInvite({ server: `ws://127.0.0.1:${relay.port}`, room: 'pair', secret: 's3cret' })

  // Before: the agent synced Dana's folder itself, and Rejoin in her app failed with
  // "already being synced by another quilt process" until the agent left.
  const r = await call2('quilt_join_session', { invite })
  assert.ok(!r.isError, text(r))
  const copy = path.join(home, 'quilt', 'quilt-pair')
  assert.match(text(r), rx(`Files are synced into ${copy}`))
  assert.match(text(r), rx(`(${personDir} is a person's own copy of this session on this computer and stays theirs`))
  await waitFor(() => fs.existsSync(path.join(copy, 'src', 'app.js')))
  assert.equal(JSON.parse(fs.readFileSync(path.join(copy, '.quilt', 'config.json'), 'utf8')).kind, 'agent')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(personDir, '.quilt', 'config.json'), 'utf8')), saved, "Dana's saved session is untouched")
  assert.equal(fs.existsSync(path.join(personDir, '.quilt', 'daemon.json')), false, 'nothing runs in her folder')
  assert.equal(fs.existsSync(path.join(personDir, 'src')), false, 'nothing is synced into it')
  assert.match(text(await call2('quilt_leave_session')), /Left the session/)

  // Starting a new session from her folder would hand it to another room: refused.
  const s = await call2('quilt_start_session', {})
  assert.equal(s.isError, true)
  assert.match(text(s), /already belongs to a session a person started on this computer/)

  // Naming her folder outright, or the agent's own copy, both land in the copy.
  for (const folder of [personDir, copy]) {
    const again = await call2('quilt_join_session', { invite, folder })
    assert.ok(!again.isError, text(again))
    assert.match(text(again), rx(`Files are synced into ${copy}`))
    if (folder === copy) assert.doesNotMatch(text(again), /stays theirs/)
    assert.match(text(await call2('quilt_leave_session')), /Left the session/)
  }
})
