import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, makeAgent } from './api-helpers.js'
import { keyStatus, REUSED } from '../src/api/agent-auth.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const me = (key) => t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${key}` })
const refresh = (refreshKey) => t.call('POST', '/v1/agents/token', { refreshKey })

test('keyStatus: active while a key can refresh, reused after a family revoke, otherwise expired', () => {
  assert.equal(REUSED, "This key was already used, so this agent's keys were revoked. Invite it again.")
  assert.equal(keyStatus([{ revokedAt: null, refreshExpiresAt: 2000 }], 1000), 'active')
  assert.equal(keyStatus([{ revokedAt: 500, refreshExpiresAt: 2000 }], 1000), 'reused')
  assert.equal(keyStatus([{ revokedAt: null, refreshExpiresAt: 900 }], 1000), 'expired')
  assert.equal(keyStatus([], 1000), 'expired')
})

test('an access key signs a personal agent in; /me says who it is', async () => {
  const { agent, accessKey } = await makeAgent(t, { name: 'Larry', description: 'Writes tests', ownerUserId: 'mem' })
  const r = await me(accessKey)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { agent: { id: agent.id, name: 'Larry', provider: 'Anthropic', type: 'coding agent', description: 'Writes tests', kind: 'personal', org: null }, teams: [], role: null })
  assert.ok((await t.store.agentById(agent.id)).lastUsedAt > 0, 'last used is recorded')
  assert.equal((await me('qa_nope')).status, 401)
  assert.equal((await t.call('GET', '/v1/agents/me', null, 'mem')).status, 401, "a person's sign-in is not an agent's")
})

test('last used is written at most once a minute', async () => {
  const { accessKey } = await makeAgent(t, { ownerUserId: 'mem' })
  let touches = 0
  const counting = { ...t.store, touchAgent: async (id) => { touches++; return t.store.touchAgent(id) } }
  const t2 = await startTestApi({ store: counting })
  try {
    for (let i = 0; i < 3; i++) assert.equal((await t2.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${accessKey}` })).status, 200)
  } finally { await t2.close() }
  assert.equal(touches, 1)
})

test('/me for an org agent lists its org, role and teams with folders', async () => {
  const o = await makeOrg(t, 'Agent Me Co')
  const lead = await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: { teams: { r: true } } })
  const { agent, accessKey } = await makeAgent(t, { name: 'Bot', provider: 'OpenAI', orgId: o.org.id })
  const m = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id, roleId: lead.id })
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  await t.store.addTeamMember({ teamId: core.id, memberId: m.id, access: 'editor', scopes: ['src'] })
  assert.deepEqual((await me(accessKey)).body, {
    agent: { id: agent.id, name: 'Bot', provider: 'OpenAI', type: 'coding agent', description: '', kind: 'org', org: { slug: o.slug, name: 'Agent Me Co' } },
    teams: [{ id: core.id, name: 'Core', access: 'editor', scopes: ['src'] }],
    role: { name: 'Lead' }
  })
})

test('expired or revoked access keys are refused', async () => {
  const stale = await makeAgent(t, { ownerUserId: 'mem', accessTtl: -1 })
  assert.equal((await me(stale.accessKey)).status, 401)
  const { agent, accessKey } = await makeAgent(t, { ownerUserId: 'mem' })
  await t.store.revokeAgent(agent.id)
  assert.equal((await me(accessKey)).status, 401)
})

test('a refresh key swaps for a new pair once, and the new pair works', async () => {
  const { agent, refreshKey } = await makeAgent(t, { ownerUserId: 'mem' })
  const r = await refresh(refreshKey)
  assert.equal(r.status, 200)
  assert.equal(r.body.agentId, agent.id)
  assert.match(r.body.accessKey, /^qa_[A-Za-z0-9_-]{43}$/)
  assert.match(r.body.refreshKey, /^qr_[A-Za-z0-9_-]{43}$/)
  const at = Date.now()
  assert.ok(Math.abs(r.body.accessExpiresAt - (at + 60 * 60 * 1000)) < 5000, 'access: 1 hour')
  assert.ok(Math.abs(r.body.refreshExpiresAt - (at + 30 * 24 * 60 * 60 * 1000)) < 5000, 'refresh: 30 days')
  assert.equal((await me(r.body.accessKey)).status, 200)
  assert.equal((await refresh(r.body.refreshKey)).status, 200, 'the new refresh key works in turn')
  const rows = await t.store.listAgentKeys(agent.id)
  assert.equal(new Set(rows.map((k) => k.familyId)).size, 1, 'refreshing stays in one family')
  assert.equal(JSON.stringify(rows).includes(r.body.accessKey), false, 'only hashes are stored')
})

test('reusing a spent refresh key revokes the whole family, and the list says so', async () => {
  const { agent, refreshKey } = await makeAgent(t, { name: 'Leaky', ownerUserId: 'lim' })
  const fresh = (await refresh(refreshKey)).body
  const reused = await refresh(refreshKey)
  assert.deepEqual([reused.status, reused.body.error], [401, REUSED])
  assert.equal((await me(fresh.accessKey)).status, 401, 'the newer access key died too')
  assert.equal((await refresh(fresh.refreshKey)).status, 401, 'and the newer refresh key')
  const listed = (await t.call('GET', '/v1/agents', null, 'lim')).body.agents.find((a) => a.id === agent.id)
  assert.equal(listed.status, 'reused')
})

test('two refreshes racing with one key: at most one gets a pair, and no pair survives', async () => {
  const { refreshKey } = await makeAgent(t, { ownerUserId: 'mem' })
  const results = await Promise.all([refresh(refreshKey), refresh(refreshKey)])
  assert.ok(results.some((r) => r.status === 401), 'the second use is a reuse')
  // A copied key means nobody keeps the family, whichever request finished first.
  for (const r of results.filter((x) => x.status === 200)) assert.equal((await me(r.body.accessKey)).status, 401)
})

test('bad, expired and revoked refresh keys are 401s', async () => {
  assert.equal((await t.call('POST', '/v1/agents/token', {})).status, 401)
  assert.equal((await refresh('qr_nope')).status, 401)
  assert.equal((await refresh(42)).status, 401)
  const stale = await makeAgent(t, { ownerUserId: 'mem', refreshTtl: -1 })
  assert.equal((await refresh(stale.refreshKey)).status, 401)
  const gone = await makeAgent(t, { ownerUserId: 'mem' })
  assert.equal((await t.call('DELETE', `/v1/agents/${gone.agent.id}`, null, 'mem')).status, 200)
  assert.equal((await refresh(gone.refreshKey)).status, 401, 'revoking the agent revokes its keys')
})

test('the personal agents list shows the profile, when each was added and last used, and its key status', async () => {
  const { agent } = await makeAgent(t, { name: 'Listed', provider: 'Cursor', type: 'editor agent', description: 'Fixes lint', ownerUserId: 'out' })
  const [a] = (await t.call('GET', '/v1/agents', null, 'out')).body.agents
  assert.deepEqual([a.id, a.name, a.provider, a.type, a.description, a.status, a.lastUsedAt], [agent.id, 'Listed', 'Cursor', 'editor agent', 'Fixes lint', 'active', null])
  assert.ok(a.createdAt > 0)
})

test('key refreshes are rate-limited per address', async () => {
  const limited = await startTestApi({ tokenLimit: 2 })
  try {
    for (const want of [401, 401, 429]) assert.equal((await limited.call('POST', '/v1/agents/token', { refreshKey: 'qr_x' })).status, want)
  } finally { await limited.close() }
})
