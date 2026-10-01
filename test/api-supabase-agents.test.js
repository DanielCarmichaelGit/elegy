import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStore } from '../src/api/supabase-store.js'

const ISO = '2026-09-30T00:00:00.000Z'
// A stand-in supabase client: records every query (the table plus the chain of
// calls on it) and answers each with answer(query).
function fakeDb (answer = () => null) {
  const calls = []
  const chain = (q) => new Proxy({}, {
    get (_, op) {
      if (op === 'then') return (res, rej) => Promise.resolve({ data: answer(q), error: null }).then(res, rej)
      return (...args) => { q.ops.push([op, ...args]); return chain(q) }
    }
  })
  const client = { from (table) { const q = { table, ops: [] }; calls.push(q); return chain(q) } }
  return { client, calls }
}
const has = (q, ...call) => q.ops.some((c) => JSON.stringify(c) === JSON.stringify(call))
const agentRow = { id: 'a1', name: 'Larry', provider: 'Anthropic', type: 'coding agent', description: '', public_key: null, owner_user_id: 'u1', org_id: null, invited_by: 'u1', created_at: ISO, last_used_at: null, revoked_at: null }

test('supabase createAgent writes the profile and home, and selects no secrets', async () => {
  const { client, calls } = fakeDb(() => agentRow)
  const a = await createSupabaseStore({ client }).createAgent({ name: 'Larry', provider: 'Anthropic', type: 'coding agent', ownerUserId: 'u1', invitedBy: 'u1' })
  assert.deepEqual([a.id, a.provider, a.ownerUserId, a.orgId, a.createdAt], ['a1', 'Anthropic', 'u1', null, Date.parse(ISO)])
  assert.deepEqual(calls[0].ops.find(([op]) => op === 'insert')[1], { name: 'Larry', provider: 'Anthropic', type: 'coding agent', description: '', public_key: null, owner_user_id: 'u1', org_id: null, invited_by: 'u1' })
  assert.equal(calls[0].ops.find(([op]) => op === 'select')[1], 'id, name, provider, type, description, public_key, owner_user_id, org_id, invited_by, created_at, last_used_at, revoked_at')
})

test("supabase listPersonalAgents reads only the person's live agents; agentByPublicKey skips empty keys", async () => {
  const { client, calls } = fakeDb(() => [agentRow])
  const s = createSupabaseStore({ client })
  const [a] = await s.listPersonalAgents('u1')
  assert.equal(a.name, 'Larry')
  assert.ok(has(calls[0], 'eq', 'owner_user_id', 'u1'))
  assert.ok(has(calls[0], 'is', 'revoked_at', null))
  assert.equal(await s.agentByPublicKey(null), null)
  assert.equal(calls.length, 1, 'no query for an empty key')
})

test('supabase revokeAgent revokes the agent once, then every key it holds', async () => {
  const { client, calls } = fakeDb((q) => (q.table === 'agents' ? [{ id: 'a1' }] : null))
  assert.equal(await createSupabaseStore({ client }).revokeAgent('a1'), true)
  assert.deepEqual(calls.map((c) => c.table), ['agents', 'agent_keys'])
  assert.ok(has(calls[0], 'is', 'revoked_at', null))
  assert.ok(has(calls[1], 'eq', 'agent_id', 'a1'))
  assert.ok(has(calls[1], 'is', 'revoked_at', null))
  assert.equal(await createSupabaseStore({ client: fakeDb(() => []).client }).revokeAgent('a1'), false)
})

test('supabase addAgentMember and memberByAgent work on agent_id', async () => {
  const row = { id: 'm2', org_id: 'o1', user_id: null, agent_id: 'a1', role_id: null, joined_at: ISO }
  const { client, calls } = fakeDb(() => row)
  const s = createSupabaseStore({ client })
  const m = await s.addAgentMember({ orgId: 'o1', agentId: 'a1' })
  assert.deepEqual([m.id, m.agentId, m.roleId], ['m2', 'a1', null])
  assert.deepEqual(calls[0].ops.find(([op]) => op === 'insert')[1], { org_id: 'o1', agent_id: 'a1', role_id: null })
  await s.memberByAgent('o1', 'a1')
  assert.ok(has(calls[1], 'eq', 'org_id', 'o1'))
  assert.ok(has(calls[1], 'eq', 'agent_id', 'a1'))
})

test('supabase member lists name agents from the agents table, with their profile', async () => {
  const { client, calls } = fakeDb((q) => q.table === 'org_members'
    ? [{ id: 'm2', org_id: 'o1', user_id: null, agent_id: 'a1', role_id: null, joined_at: ISO, profiles: null, agents: { name: 'Bot', provider: 'OpenAI', type: 'coding agent' } }]
    : [{ team_id: 't1', member_id: 'm2', access: 'viewer', scopes: ['src'], added_at: ISO, org_members: { user_id: null, agent_id: 'a1', profiles: null, agents: { name: 'Bot' } } }])
  const s = createSupabaseStore({ client })
  const [m] = await s.listMembers('o1')
  assert.deepEqual([m.name, m.provider, m.type, m.agentId, 'agents' in m, 'profiles' in m], ['Bot', 'OpenAI', 'coding agent', 'a1', false, false])
  assert.match(calls[0].ops.find(([op]) => op === 'select')[1], /agents \(name, provider, type\)/)
  const [tm] = await s.listTeamMembers('t1')
  assert.deepEqual([tm.name, tm.kind, tm.scopes], ['Bot', 'agent', ['src']])
})
