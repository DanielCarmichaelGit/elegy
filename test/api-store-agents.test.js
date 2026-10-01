import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/api/memory-store.js'
import { BUILTIN } from '../src/api/permissions.js'

const setup = () => { const s = createMemoryStore(); s.addUser('u1', { name: 'Dana' }); s.addUser('u2', { name: 'Eli' }); return s }
const org = (s, slug = 'acme') => s.createOrg({ name: 'Acme', slug, ownerId: 'u1', grants: BUILTIN })
const profile = (name, extra = {}) => ({ name, provider: 'Anthropic', type: 'coding agent', ...extra })

test('agents belong to one person or one org, carry a profile, and a key belongs to one agent', async () => {
  const s = setup()
  const o = await org(s)
  const mine = await s.createAgent(profile('Larry', { description: 'Writes tests', publicKey: 'pk1', ownerUserId: 'u1', invitedBy: 'u1' }))
  assert.deepEqual(
    [mine.name, mine.provider, mine.type, mine.description, mine.ownerUserId, mine.orgId, mine.invitedBy, mine.revokedAt, mine.lastUsedAt],
    ['Larry', 'Anthropic', 'coding agent', 'Writes tests', 'u1', null, 'u1', null, null]
  )
  const theirs = await s.createAgent(profile('Bot', { orgId: o.id, invitedBy: 'u1' }))
  assert.deepEqual([theirs.orgId, theirs.publicKey, theirs.description], [o.id, null, ''])
  await s.createAgent(profile('NoKey', { ownerUserId: 'u2' }))
  await assert.rejects(s.createAgent(profile('Dup', { publicKey: 'pk1', ownerUserId: 'u2' })), (err) => err.code === '23505')
  await assert.rejects(s.createAgent(profile('Both', { ownerUserId: 'u1', orgId: o.id })), (err) => err.code === '23514')
  await assert.rejects(s.createAgent(profile('Neither')), (err) => err.code === '23514')
  assert.equal((await s.agentById(mine.id)).name, 'Larry')
  assert.equal((await s.agentByPublicKey('pk1')).id, mine.id)
  assert.equal(await s.agentByPublicKey('nope'), null)
  assert.equal(await s.agentByPublicKey(null), null)
  assert.deepEqual((await s.listPersonalAgents('u1')).map((a) => a.id), [mine.id], 'org agents are not personal')
})

test('touching and revoking an agent; revoked agents leave the personal list', async () => {
  const s = setup()
  const a = await s.createAgent(profile('Larry', { ownerUserId: 'u1', invitedBy: 'u1' }))
  await s.touchAgent(a.id)
  assert.ok((await s.agentById(a.id)).lastUsedAt > 0)
  assert.equal(await s.revokeAgent(a.id), true)
  assert.equal(await s.revokeAgent(a.id), false, 'once')
  assert.ok((await s.agentById(a.id)).revokedAt > 0)
  assert.deepEqual(await s.listPersonalAgents('u1'), [])
})

test('org agents join as members with no role, named after the agent, in their own org only', async () => {
  const s = setup()
  const o = await org(s); const other = await org(s, 'other')
  const bot = await s.createAgent(profile('Bot', { orgId: o.id, invitedBy: 'u1' }))
  const mine = await s.createAgent(profile('Larry', { ownerUserId: 'u1', invitedBy: 'u1' }))
  const m = await s.addAgentMember({ orgId: o.id, agentId: bot.id, roleId: null })
  assert.deepEqual([m.agentId, m.userId, m.roleId], [bot.id, null, null])
  await assert.rejects(s.addAgentMember({ orgId: other.id, agentId: bot.id }), (err) => err.code === '23503')
  await assert.rejects(s.addAgentMember({ orgId: o.id, agentId: mine.id }), (err) => err.code === '23503', 'a personal agent')
  await assert.rejects(s.addAgentMember({ orgId: o.id, agentId: bot.id }), (err) => err.code === '23505', 'once per org')
  assert.equal((await s.memberByAgent(o.id, bot.id)).id, m.id)
  assert.deepEqual((await s.listMembers(o.id)).map((x) => [x.name, x.provider, x.type]), [['Dana', null, null], ['Bot', 'Anthropic', 'coding agent']])
  const team = await s.createTeam({ orgId: o.id, name: 'Core' })
  await s.addTeamMember({ teamId: team.id, memberId: m.id, access: 'viewer' })
  await s.addTeamMember({ teamId: team.id, memberId: (await s.memberOf(o.id, 'u1')).id, access: 'editor' })
  assert.deepEqual((await s.listTeamMembers(team.id)).map((x) => [x.name, x.kind]), [['Bot', 'agent'], ['Dana', 'person']])
})

test('deleting an agent, its org or its person removes it and its membership', async () => {
  const s = setup()
  const o = await org(s)
  const bot = await s.createAgent(profile('Bot', { orgId: o.id, invitedBy: 'u2' }))
  await s.addAgentMember({ orgId: o.id, agentId: bot.id })
  await s.deleteAgent(bot.id)
  assert.equal(await s.agentById(bot.id), null)
  assert.equal(await s.memberByAgent(o.id, bot.id), null)
  const bot2 = await s.createAgent(profile('Bot', { orgId: o.id, invitedBy: 'u2' }))
  await s.addAgentMember({ orgId: o.id, agentId: bot2.id })
  const larry = await s.createAgent(profile('Larry', { ownerUserId: 'u2', invitedBy: 'u2' }))
  await s.deleteUser('u2')
  assert.equal(await s.agentById(larry.id), null, "a person's own agents go with them")
  assert.equal((await s.agentById(bot2.id)).invitedBy, null, 'org agents stay; the inviter is forgotten')
  await s.deleteOrg(o.id)
  assert.equal(await s.agentById(bot2.id), null)
})
