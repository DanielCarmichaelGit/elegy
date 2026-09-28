// An AI agent joins a session on its own through the MCP server, then uses
// the workspace tools. Runs the real `cowove mcp` over stdio.
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

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cowove.js')
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `cowove-mcp-${n}-`))
let relay, human, client, humanDir, agentCwd
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
  const home = tmp('home')
  client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: agentCwd, env: { ...process.env, HOME: home }, stderr: 'ignore' }))
})

after(async () => {
  await client?.close().catch(() => {})
  await human?.stop()
  await relay?.close()
})

test('exposes the join and workspace tools', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name)
  for (const n of ['cowove_join_session', 'cowove_start_session', 'cowove_leave_session', 'cowove_session_info', 'cowove_partner_feed', 'cowove_list_files', 'cowove_status', 'cowove_claim']) {
    assert.ok(names.includes(n), n)
  }
})

test('without a session, tools explain how to join', async () => {
  const r = await call('cowove_status')
  assert.equal(r.isError, true)
  assert.match(text(r), /cowove_join_session/)
})

test('an agent joins by invite and shows up as an agent', async () => {
  const invite = encodeInvite({ server: `ws://127.0.0.1:${relay.port}`, room: 'pair', secret: 's3cret' })
  const r = await call('cowove_join_session', { invite: `cowove join ${invite}` })
  assert.ok(!r.isError, text(r))
  assert.match(text(r), /Joined room pair/)
  // The empty current folder became the project folder, and files arrived.
  assert.equal(fs.readFileSync(path.join(agentCwd, 'src', 'app.js'), 'utf8'), 'console.log("hi")\n')
  const peer = await waitFor(() => human.status().peers.find((p) => p.kind === 'agent'))
  assert.equal(peer.name, 'Claude Code agent')
  assert.equal(peer.tool, 'Claude Code')
  // Joining twice is refused.
  assert.equal((await call('cowove_join_session', { invite })).isError, true)
})

test('the agent can read a partner\'s AI feed and the file tree', async () => {
  human.pushAgentEntries([
    { id: 'p', tool: 'Cursor', conv: 'c', kind: 'prompt', text: 'Refactor the auth module', ts: Date.now() },
    { id: 'a', tool: 'Cursor', conv: 'c', kind: 'action', text: 'Edited src/auth.js', ts: Date.now() }
  ])
  human.claim('src/auth', 'refactoring')
  const list = await waitFor(async () => { const t = text(await call('cowove_partner_feed')); return t.includes('dana') && t })
  assert.match(list, /dana/)
  const feed = await waitFor(async () => { const t = text(await call('cowove_partner_feed', { who: 'dana' })); return t.includes('Refactor') && t })
  assert.match(feed, /dana asked: Refactor the auth module/)
  assert.match(feed, /· Edited src\/auth.js/)
  const files = text(await call('cowove_list_files'))
  assert.match(files, /src\/app\.js/)
  assert.match(files, /Claims: src\/auth \(dana: refactoring\)/)
  assert.match(text(await call('cowove_status')), /dana/)
})

test('agent edits sync back to people, and leaving removes the agent', async () => {
  fs.writeFileSync(path.join(agentCwd, 'src', 'app.js'), 'console.log("hi from the agent")\n')
  await waitFor(() => fs.readFileSync(path.join(humanDir, 'src', 'app.js'), 'utf8').includes('agent'))
  const info = text(await call('cowove_session_info'))
  assert.match(info, /Invite code/)
  assert.match(text(await call('cowove_leave_session')), /Left the session/)
  await waitFor(() => !human.status().peers.some((p) => p.kind === 'agent'))
})
