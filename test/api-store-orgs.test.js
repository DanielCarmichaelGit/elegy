import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/api/memory-store.js'
import { BUILTIN } from '../src/api/permissions.js'

function setup () {
  const s = createMemoryStore()
  s.addUser('u1', { name: 'Dana', email: 'dana@acme.com' })
  s.addUser('u2', { name: 'Eli', email: 'eli@acme.com', confirmed: false })
  return s
}
const newOrg = (s, name = 'Acme', slug = 'acme', ownerId = 'u1') => s.createOrg({ name, slug, ownerId, grants: BUILTIN })

test('userEmail says whether the address is confirmed', async () => {
  const s = setup()
  assert.deepEqual(await s.userEmail('u1'), { email: 'dana@acme.com', confirmed: true })
  assert.deepEqual(await s.userEmail('u2'), { email: 'eli@acme.com', confirmed: false })
  assert.equal(await s.userEmail('nobody'), null)
})

test('creating an org makes the three built-in roles and the owner as a member', async () => {
  const s = setup()
  const org = await newOrg(s)
  assert.deepEqual([org.name, org.slug, org.ownerId, org.domain, org.domainRequests], ['Acme', 'acme', 'u1', null, false])
  const roles = await s.listRoles(org.id)
  assert.deepEqual(roles.map((r) => [r.name, r.builtin]).sort(), [['Admin', 'admin'], ['Member', 'member'], ['Owner', 'owner']])
  assert.deepEqual(roles.find((r) => r.builtin === 'member').grants, { teams: { r: true } })
  const me = await s.memberOf(org.id, 'u1')
  assert.equal(me.roleId, roles.find((r) => r.builtin === 'owner').id)
  await assert.rejects(newOrg(s, 'Other', 'acme'), (err) => err.code === '23505')
  assert.equal((await s.orgBySlug('acme')).id, org.id)
  assert.equal((await s.orgById(org.id)).slug, 'acme')
  assert.equal(await s.orgBySlug('nope'), null)
})

test('orgsForUser lists each org with the person\'s role, by name', async () => {
  const s = setup()
  const zeta = await newOrg(s, 'Zeta', 'zeta')
  const acme = await newOrg(s, 'Acme', 'acme')
  const list = await s.orgsForUser('u1')
  assert.deepEqual(list.map((o) => o.slug), ['acme', 'zeta'])
  assert.equal(list[1].id, zeta.id)
  assert.equal(list[0].roleId, (await s.memberOf(acme.id, 'u1')).roleId)
  assert.deepEqual(await s.orgsForUser('u2'), [])
})

test('updating an org, and finding orgs open to join requests by domain', async () => {
  const s = setup()
  const org = await newOrg(s)
  assert.equal((await s.updateOrg(org.id, { name: 'Acme Co', domain: 'acme.com' })).name, 'Acme Co')
  assert.deepEqual(await s.orgsByDomain('acme.com'), [], 'requests are off')
  await s.updateOrg(org.id, { domainRequests: true })
  assert.deepEqual((await s.orgsByDomain('acme.com')).map((o) => o.id), [org.id])
  assert.equal((await s.updateOrg(org.id, { domain: null })).domain, null)
})

test('transferring an org: the new owner takes Owner and the old owner becomes Admin', async () => {
  const s = setup()
  const org = await newOrg(s)
  const roles = await s.listRoles(org.id)
  const role = (b) => roles.find((r) => r.builtin === b).id
  await s.addMember({ orgId: org.id, userId: 'u2', roleId: role('member') })
  await s.transferOrg(org.id, 'u2')
  assert.equal((await s.orgById(org.id)).ownerId, 'u2')
  assert.equal((await s.memberOf(org.id, 'u2')).roleId, role('owner'))
  assert.equal((await s.memberOf(org.id, 'u1')).roleId, role('admin'))
})

test('roles: create, update, delete, and in-use checks', async () => {
  const s = setup()
  const org = await newOrg(s)
  const lead = await s.createRole({ orgId: org.id, name: 'Lead', grants: { teams: { c: true } } })
  assert.equal(lead.builtin, null)
  await assert.rejects(s.createRole({ orgId: org.id, name: 'Lead', grants: {} }), (err) => err.code === '23505')
  assert.deepEqual((await s.updateRole(lead.id, { grants: { teams: { r: true } } })).grants, { teams: { r: true } })
  assert.equal((await s.updateRole(lead.id, { name: 'Leads' })).name, 'Leads')
  assert.equal((await s.roleById(org.id, lead.id)).name, 'Leads')
  const other = await newOrg(s, 'Other', 'other')
  assert.equal(await s.roleById(other.id, lead.id), null, 'roles are scoped to their org')
  assert.equal(await s.roleInUse(lead.id), false)
  const m = await s.addMember({ orgId: org.id, userId: 'u2', roleId: lead.id })
  assert.equal(await s.roleInUse(lead.id), true)
  await s.setMemberRole(m.id, (await s.listRoles(org.id)).find((r) => r.builtin === 'member').id)
  assert.equal(await s.roleInUse(lead.id), false)
  await s.deleteRole(lead.id)
  assert.equal(await s.roleById(org.id, lead.id), null)
})

test('members: add once, list with names, change role, remove', async () => {
  const s = setup()
  const org = await newOrg(s)
  const memberRole = (await s.listRoles(org.id)).find((r) => r.builtin === 'member').id
  const a = await s.addMember({ orgId: org.id, userId: 'u2', roleId: memberRole })
  const again = await s.addMember({ orgId: org.id, userId: 'u2', roleId: memberRole })
  assert.equal(again.id, a.id)
  assert.deepEqual((await s.listMembers(org.id)).map((m) => m.name).sort(), ['Dana', 'Eli'])
  assert.equal((await s.memberById(org.id, a.id)).userId, 'u2')
  const other = await newOrg(s, 'Other', 'other')
  assert.equal(await s.memberById(other.id, a.id), null)
  await s.removeMember(a.id)
  assert.equal(await s.memberOf(org.id, 'u2'), null)
})

test('deleting an org removes its roles and members; deleting a person removes their memberships', async () => {
  const s = setup()
  const org = await newOrg(s)
  const other = await newOrg(s, 'Other', 'other', 'u2')
  await s.addMember({ orgId: other.id, userId: 'u1', roleId: (await s.listRoles(other.id)).find((r) => r.builtin === 'member').id })
  await s.deleteOrg(org.id)
  assert.equal(await s.orgById(org.id), null)
  assert.deepEqual(await s.listRoles(org.id), [])
  assert.deepEqual(await s.listMembers(org.id), [])
  await s.deleteUser('u1')
  assert.equal(await s.memberOf(other.id, 'u1'), null)
  assert.equal(await s.userEmail('u1'), null)
})

test('deleting a role clears its closed invites first, and refuses while one is open', async () => {
  const s = setup()
  const org = await newOrg(s)
  const lead = await s.createRole({ orgId: org.id, name: 'Lead', grants: {} })
  await s.createInvite({ orgId: org.id, email: 'x@acme.com', roleId: lead.id, tokenHash: 'h1', invitedBy: 'u1', expiresAt: Date.now() - 1000 })
  await s.deleteRole(lead.id)
  assert.equal(await s.roleById(org.id, lead.id), null, 'a role with only an expired (closed) invite can be deleted')

  const lead2 = await s.createRole({ orgId: org.id, name: 'Lead2', grants: {} })
  await s.createInvite({ orgId: org.id, email: 'y@acme.com', roleId: lead2.id, tokenHash: 'h2', invitedBy: 'u1', expiresAt: Date.now() + 1000 * 60 * 60 })
  assert.equal(await s.roleInUse(lead2.id), true, 'an open invite is reported in use')
  await assert.rejects(s.deleteRole(lead2.id), (err) => err.code === '23503')
  assert.ok(await s.roleById(org.id, lead2.id), 'the role survives the refused delete')
})

test('transferOrg reports QO002/QO001 like transfer_org, instead of throwing a plain error', async () => {
  const s = setup()
  const org = await newOrg(s)
  await assert.rejects(s.transferOrg(org.id, 'u2'), (err) => err.code === 'QO002', 'target not a member')
  const memberRole = (await s.listRoles(org.id)).find((r) => r.builtin === 'member').id
  await s.addMember({ orgId: org.id, userId: 'u2', roleId: memberRole })
  await s.removeMember((await s.memberOf(org.id, 'u1')).id)
  await assert.rejects(s.transferOrg(org.id, 'u2'), (err) => err.code === 'QO001', 'current owner no longer a member')
})

test('a role from another org cannot be attached to a member (composite FK)', async () => {
  const s = setup()
  const org = await newOrg(s)
  const other = await newOrg(s, 'Other', 'other', 'u2')
  const otherRole = (await s.listRoles(other.id)).find((r) => r.builtin === 'member').id
  await assert.rejects(s.addMember({ orgId: org.id, userId: 'u2', roleId: otherRole }), (err) => err.code === '23503')
  const memberRole = (await s.listRoles(org.id)).find((r) => r.builtin === 'member').id
  const m = await s.addMember({ orgId: org.id, userId: 'u2', roleId: memberRole })
  await assert.rejects(s.setMemberRole(m.id, otherRole), (err) => err.code === '23503')
})

test('listMembers is sorted by joinedAt', async () => {
  let t = 1000
  const s = createMemoryStore({ now: () => t })
  s.addUser('u1', { name: 'Dana', email: 'dana@acme.com' })
  s.addUser('u2', { name: 'Eli', email: 'eli@acme.com' })
  s.addUser('u3', { name: 'Cal', email: 'cal@acme.com' })
  const org = await newOrg(s)
  const memberRole = (await s.listRoles(org.id)).find((r) => r.builtin === 'member').id
  t = 3000; await s.addMember({ orgId: org.id, userId: 'u3', roleId: memberRole })
  t = 2000; await s.addMember({ orgId: org.id, userId: 'u2', roleId: memberRole })
  assert.deepEqual((await s.listMembers(org.id)).map((m) => m.userId), ['u1', 'u2', 'u3'])
})
