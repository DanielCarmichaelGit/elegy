import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStore } from '../src/api/supabase-store.js'
import { BUILTIN } from '../src/api/permissions.js'

const ISO = '2026-09-30T00:00:00.000Z'
// A stand-in supabase client: records every query (a table or an rpc, plus the
// chain of calls on it) and answers each with answer(query).
function fakeDb (answer = () => null) {
  const calls = []
  const chain = (q) => new Proxy({}, {
    get (_, op) {
      if (op === 'then') return (res, rej) => Promise.resolve({ data: answer(q), error: null }).then(res, rej)
      return (...args) => { q.ops.push([op, ...args]); return chain(q) }
    }
  })
  const users = {
    u1: { id: 'u1', email: 'dana@acme.com', email_confirmed_at: ISO },
    u2: { id: 'u2', email: 'eli@acme.com', email_confirmed_at: null }
  }
  const client = {
    from (table) { const q = { table, ops: [] }; calls.push(q); return chain(q) },
    rpc (fn, args) { const q = { rpc: fn, args, ops: [] }; calls.push(q); return chain(q) },
    auth: {
      admin: {
        getUserById: async (id) => users[id]
          ? { data: { user: users[id] }, error: null }
          : { data: { user: null }, error: { status: 404, message: 'User not found' } }
      }
    }
  }
  return { client, calls }
}
const has = (q, ...call) => q.ops.some((c) => JSON.stringify(c) === JSON.stringify(call))
const orgRow = (id, name) => ({ id, name, slug: name.toLowerCase(), owner_id: 'u1', domain: null, domain_requests: false, created_at: ISO })

test('supabase userEmail reads the auth user; unknown people are null', async () => {
  const s = createSupabaseStore({ client: fakeDb().client })
  assert.deepEqual(await s.userEmail('u1'), { email: 'dana@acme.com', confirmed: true })
  assert.deepEqual(await s.userEmail('u2'), { email: 'eli@acme.com', confirmed: false })
  assert.equal(await s.userEmail('u3'), null)
})

test('supabase createOrg and transferOrg go through the one-transaction functions', async () => {
  const { client, calls } = fakeDb((q) => (q.rpc === 'create_org' ? orgRow('o1', 'Acme') : null))
  const s = createSupabaseStore({ client })
  const org = await s.createOrg({ name: 'Acme', slug: 'acme', ownerId: 'u1', grants: BUILTIN })
  assert.deepEqual(calls[0].args, { p_name: 'Acme', p_slug: 'acme', p_owner: 'u1', p_owner_grants: BUILTIN.owner, p_admin_grants: BUILTIN.admin, p_member_grants: BUILTIN.member })
  assert.deepEqual([org.id, org.ownerId, org.domainRequests, org.createdAt], ['o1', 'u1', false, Date.parse(ISO)])
  await s.transferOrg('o1', 'u2')
  assert.deepEqual([calls[1].rpc, calls[1].args], ['transfer_org', { p_org: 'o1', p_to: 'u2' }])
})

test('supabase orgsForUser flattens the embedded org and sorts by name', async () => {
  const { client, calls } = fakeDb(() => [{ role_id: 'r2', orgs: orgRow('o2', 'Zeta') }, { role_id: 'r1', orgs: orgRow('o1', 'Acme') }])
  const s = createSupabaseStore({ client })
  const list = await s.orgsForUser('u1')
  assert.deepEqual(list.map((o) => [o.name, o.roleId]), [['Acme', 'r1'], ['Zeta', 'r2']])
  assert.ok(has(calls[0], 'eq', 'user_id', 'u1'))
})

test('supabase listMembers flattens the embedded profile name', async () => {
  const { client } = fakeDb(() => [{ id: 'm1', org_id: 'o1', user_id: 'u1', agent_id: null, role_id: 'r1', joined_at: ISO, profiles: { name: 'Dana' } }])
  const [m] = await createSupabaseStore({ client }).listMembers('o1')
  assert.deepEqual([m.id, m.userId, m.name, m.joinedAt, 'profiles' in m], ['m1', 'u1', 'Dana', Date.parse(ISO), false])
})

test('supabase addMember returns the existing row when the person is already in', async () => {
  const row = { id: 'm1', org_id: 'o1', user_id: 'u2', agent_id: null, role_id: 'r1', joined_at: ISO }
  const { client, calls } = fakeDb((q) => (q.ops.some(([op]) => op === 'upsert') ? null : row))
  const m = await createSupabaseStore({ client }).addMember({ orgId: 'o1', userId: 'u2', roleId: 'r1' })
  assert.equal(m.id, 'm1')
  const upsert = calls[0].ops.find(([op]) => op === 'upsert')
  assert.deepEqual(upsert[2], { onConflict: 'org_id,user_id', ignoreDuplicates: true })
})

test('supabase roleInUse counts members, then open invites only', async () => {
  const { client, calls } = fakeDb((q) => (q.table === 'org_invites' ? [{ id: 'i1' }] : []))
  assert.equal(await createSupabaseStore({ client }).roleInUse('r1'), true)
  const invites = calls.find((q) => q.table === 'org_invites')
  assert.ok(has(invites, 'is', 'accepted_at', null) && has(invites, 'is', 'cancelled_at', null))
})
