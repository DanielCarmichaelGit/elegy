// The accounts API's /mcp: a hosted agent signs in with its access key, and the API
// hands each request to the relay with a pass for the agent. A cloud AI needs nothing
// but that URL and its key to take part in sessions.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startTestApi, makeAgent } from './api-helpers.js'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'
import { newPassKeys } from '../src/passes.js'
import { testPasses } from './pass-helpers.js'

process.env.HOME = process.env.USERPROFILE = process.env.USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-am-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-am-${n}-`))
async function waitFor (fn, ms = 8000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const out = (r) => r.content.map((c) => c.text).join('\n')

let t, relay, dana, danaDir
const keys = newPassKeys()
before(async () => {
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey })
  t = await startTestApi({ passKey: keys.privateKey, relayUrl: `ws://127.0.0.1:${relay.port}` })
  const id = generateIdentity()
  danaDir = tmp('dana')
  dana = new Session({ dir: danaDir, server: `ws://127.0.0.1:${relay.port}`, room: 'am-1', secret: 's', name: 'Dana', identity: id, passes: testPasses(id, { keys }) })
  await dana.start({ waitTimeoutMs: 5000 })
})
after(async () => { await dana.stop(); await t.close(); await relay.close() })

async function client (accessKey) {
  const c = new Client({ name: 'cloud-ai', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`${t.api.url}/mcp`), { requestInit: { headers: accessKey ? { authorization: `Bearer ${accessKey}` } : {} } }))
  return c
}

test('/mcp needs an agent access key', async () => {
  await assert.rejects(client(''), /send your agent access key/)
  await assert.rejects(client('qa_nope'), /sign the agent in first/)
})

test('a key-less (hosted) agent joins a session through /mcp and works on its files', async () => {
  const { agent, accessKey } = await makeAgent(t, { name: 'Grok-Bot', provider: 'xAI', ownerUserId: 'mem' })
  const me = (await t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${accessKey}` })).body
  assert.equal(me.agent.hosted, true)
  assert.equal(me.agent.canJoinSessions, true)
  assert.equal(me.mcp, 'https://api.quilt.test/mcp')

  const c = await client(accessKey)
  try {
    const tools = (await c.listTools()).tools.map((x) => x.name)
    assert.ok(tools.includes('quilt_join_session') && tools.includes('quilt_write_file'))
    const r = await c.callTool({ name: 'quilt_join_session', arguments: { invite: 'https://join.heyquilt.com/am-1#s' } })
    assert.equal(r.isError, undefined, out(r))
    assert.match(out(r), /Joined room am-1 as Grok-Bot \(editor\)/)
    await c.callTool({ name: 'quilt_write_file', arguments: { path: 'from-cloud.txt', content: 'hi from the cloud' } })
    await waitFor(() => { try { return fs.readFileSync(path.join(danaDir, 'from-cloud.txt'), 'utf8') === 'hi from the cloud' } catch { return false } })
    assert.match(out(await c.callTool({ name: 'quilt_status', arguments: {} })), /- Dana \(/)
    assert.ok(agent.id)
  } finally { await c.close() }
})

test('a revoked agent is turned away at /mcp', async () => {
  const { agent, accessKey } = await makeAgent(t, { name: 'Gone', ownerUserId: 'mem' })
  await t.store.revokeAgent(agent.id)
  await assert.rejects(client(accessKey), /revoked/)
})
