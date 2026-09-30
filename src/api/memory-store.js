// The accounts API's data, in memory. Used by tests and `quilt api --memory`;
// production uses supabase-store.js, which has the same methods.
import crypto from 'node:crypto'

const uuid = () => crypto.randomUUID()
const pick = (o, drop) => Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k)))
const copy = (o) => (o ? structuredClone(o) : null)
// Postgres's unique-violation code, which the API turns into a 409.
const duplicate = (what) => Object.assign(new Error(`${what} already exists`), { code: '23505' })
// Postgres's foreign-key-violation code, mirrored for the checks the schema enforces with NO ACTION.
const fkViolation = (what) => Object.assign(new Error(`${what} is still referenced`), { code: '23503' })

export function createMemoryStore ({ now = Date.now } = {}) {
  const links = new Map(); const devices = new Map(); const profiles = new Map(); const agents = new Map()
  const users = new Map(); const orgs = new Map(); const roles = new Map(); const members = new Map()
  const teams = new Map(); const teamMembers = new Map(); const invites = new Map(); const requests = new Map()
  const all = (m, keep) => [...m.values()].filter(keep)
  const nameOf = (userId) => profiles.get(userId)?.name || ''
  const findMember = (orgId, userId) => all(members, (m) => m.orgId === orgId && m.userId === userId)[0]
  // Mirrors the composite (role_id, org_id) foreign key: a role from another org can't be attached here.
  const roleInOrg = (roleId, orgId) => roleId == null || roles.get(roleId)?.orgId === orgId
  // Leaving an org also leaves its teams, like the cascade in Postgres.
  const dropMember = (id) => {
    members.delete(id)
    for (const [k, tm] of teamMembers) if (tm.memberId === id) teamMembers.delete(k)
  }

  return {
    addUser (userId, { name = '', email = '', confirmed = true } = {}) {
      profiles.set(userId, { id: userId, name: name || email.split('@')[0] || 'You', color: null, tool: null })
      users.set(userId, { email, confirmed })
    },
    async createLink (l) {
      const row = { id: uuid(), status: 'pending', userId: null, deviceId: null, createdAt: now(), ...l }
      links.set(row.id, row); return { ...row }
    },
    async linkByDeviceCode (h) { const l = [...links.values()].find((x) => x.deviceCodeHash === h); return l ? { ...l } : null },
    async linkByUserCode (c) { const l = [...links.values()].find((x) => x.userCode === c); return l ? { ...l } : null },
    async updateLink (id, patch) { const l = links.get(id); Object.assign(l, patch); return { ...l } },
    // Check-and-set: only flips status if it's still fromStatus, so two concurrent
    // callers can't both win the same link (e.g. handing out a device token twice).
    async claimLink (id, fromStatus, toStatus) {
      const l = links.get(id)
      if (!l || l.status !== fromStatus) return false
      l.status = toStatus
      return true
    },
    // One row per (account, key): someone else approving a link for this key gets
    // their own row, never this one. A relink retires the old token.
    async upsertDevice ({ userId, name, platform, publicKey }) {
      let d = [...devices.values()].find((x) => x.userId === userId && x.publicKey === publicKey)
      if (d) Object.assign(d, { name, platform, tokenHash: null, revokedAt: null })
      else devices.set((d = { id: uuid(), userId, name, platform, publicKey, tokenHash: null, createdAt: now(), lastSeenAt: now(), revokedAt: null }).id, d)
      return { ...d }
    },
    async setDeviceToken (id, tokenHash) { devices.get(id).tokenHash = tokenHash },
    async deviceByToken (h) { const d = [...devices.values()].find((x) => x.tokenHash === h && !x.revokedAt); return d ? { ...d } : null },
    async touchDevice (id) { devices.get(id).lastSeenAt = now() },
    async revokeDevice (id) { Object.assign(devices.get(id), { revokedAt: now(), tokenHash: null }) },
    async profile (userId) { const p = profiles.get(userId); return p ? { ...p } : null },
    async updateProfile (userId, patch) {
      const p = profiles.get(userId)
      for (const k of ['name', 'color', 'tool']) if (patch[k] !== undefined) p[k] = patch[k]
      return { ...p }
    },
    async createAgent (a) {
      const row = { id: uuid(), createdAt: now(), lastUsedAt: null, revokedAt: null, ...a }
      agents.set(row.id, row); return pick(row, ['keyHash', 'privateKeyEnc'])
    },
    async agentByKey (h) { const a = [...agents.values()].find((x) => x.keyHash === h && !x.revokedAt); return a ? { ...a } : null },
    async listAgents (ownerId) { return [...agents.values()].filter((a) => a.ownerId === ownerId).map((a) => pick(a, ['keyHash', 'privateKeyEnc'])) },
    async revokeAgent (ownerId, id) {
      const a = agents.get(id)
      if (!a || a.ownerId !== ownerId) return false
      a.revokedAt = now(); return true
    },
    async deleteUser (userId) {
      profiles.delete(userId); users.delete(userId)
      for (const [id, d] of devices) if (d.userId === userId) devices.delete(id)
      for (const [id, a] of agents) if (a.ownerId === userId) agents.delete(id)
      for (const [id, m] of members) if (m.userId === userId) dropMember(id)
      for (const [id, r] of requests) if (r.userId === userId) requests.delete(id)
    },

    // The address a person signs in with, and whether they've confirmed it.
    async userEmail (userId) { const u = users.get(userId); return u ? { ...u } : null },

    // Orgs. Creating one makes its three built-in roles and its owner together.
    async createOrg ({ name, slug, ownerId, grants }) {
      if (all(orgs, (o) => o.slug === slug).length) throw duplicate('org')
      const org = { id: uuid(), name, slug, ownerId, domain: null, domainRequests: false, createdAt: now() }
      orgs.set(org.id, org)
      let ownerRole
      for (const [builtin, roleName] of [['owner', 'Owner'], ['admin', 'Admin'], ['member', 'Member']]) {
        const r = { id: uuid(), orgId: org.id, name: roleName, builtin, grants: copy(grants[builtin]), createdAt: now() }
        roles.set(r.id, r)
        if (builtin === 'owner') ownerRole = r
      }
      const m = { id: uuid(), orgId: org.id, userId: ownerId, agentId: null, roleId: ownerRole.id, joinedAt: now() }
      members.set(m.id, m)
      return copy(org)
    },
    async orgBySlug (slug) { return copy(all(orgs, (o) => o.slug === slug)[0]) },
    async orgById (id) { return copy(orgs.get(id)) },
    async orgsForUser (userId) {
      return all(members, (m) => m.userId === userId)
        .map((m) => ({ ...copy(orgs.get(m.orgId)), roleId: m.roleId }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    async orgsByDomain (domain) { return all(orgs, (o) => o.domain === domain && o.domainRequests).map(copy) },
    async updateOrg (id, patch) {
      const o = orgs.get(id)
      for (const k of ['name', 'domain', 'domainRequests']) if (patch[k] !== undefined) o[k] = patch[k]
      return copy(o)
    },
    async deleteOrg (id) {
      orgs.delete(id)
      for (const [k, m] of members) if (m.orgId === id) dropMember(k)
      for (const [k, t] of teams) if (t.orgId === id) teams.delete(k)
      for (const [k, r] of roles) if (r.orgId === id) roles.delete(k)
      for (const [k, i] of invites) if (i.orgId === id) invites.delete(k)
      for (const [k, r] of requests) if (r.orgId === id) requests.delete(k)
    },
    // Ownership moves in one step: the old owner becomes an Admin. Mirrors
    // transfer_org's own errcodes (QO002/QO001) for the same two checks.
    async transferOrg (orgId, toUserId) {
      const o = orgs.get(orgId)
      const to = findMember(orgId, toUserId)
      if (!to) throw Object.assign(new Error('target is not a member of this org'), { code: 'QO002' })
      const from = findMember(orgId, o.ownerId)
      if (!from) throw Object.assign(new Error('current owner is not a member of this org'), { code: 'QO001' })
      const builtin = (b) => all(roles, (r) => r.orgId === orgId && r.builtin === b)[0]
      from.roleId = builtin('admin').id
      to.roleId = builtin('owner').id
      o.ownerId = toUserId
    },

    // Roles.
    async listRoles (orgId) { return all(roles, (r) => r.orgId === orgId).map(copy) },
    async roleById (orgId, id) { const r = roles.get(id); return r && r.orgId === orgId ? copy(r) : null },
    async createRole ({ orgId, name, grants }) {
      if (all(roles, (r) => r.orgId === orgId && r.name === name).length) throw duplicate('role')
      const r = { id: uuid(), orgId, name, builtin: null, grants: copy(grants), createdAt: now() }
      roles.set(r.id, r); return copy(r)
    },
    async updateRole (id, { name, grants }) {
      const r = roles.get(id)
      if (name !== undefined && all(roles, (x) => x.orgId === r.orgId && x.name === name && x.id !== id).length) throw duplicate('role')
      if (name !== undefined) r.name = name
      if (grants !== undefined) r.grants = copy(grants)
      return copy(r)
    },
    // A deleted role's closed invites (accepted, cancelled or expired) go with
    // it; an open invite still referencing the role blocks the delete, mirroring
    // the (role_id, org_id) foreign key's NO ACTION in Postgres.
    async deleteRole (id) {
      const t = now()
      for (const [k, i] of invites) {
        if (i.roleId === id && (i.acceptedAt || i.cancelledAt || i.expiresAt <= t)) invites.delete(k)
      }
      if (all(invites, (i) => i.roleId === id).length) throw fkViolation('role')
      roles.delete(id)
    },
    // In use: someone holds it, or an open invite would hand it out.
    async roleInUse (id) {
      return all(members, (m) => m.roleId === id).length > 0 ||
        all(invites, (i) => i.roleId === id && !i.acceptedAt && !i.cancelledAt).length > 0
    },
    // A seam for tests only until the full invites API lands (Task 4's createInvite).
    async createInvite ({ orgId, email, roleId, tokenHash, invitedBy, expiresAt }) {
      const i = { id: uuid(), orgId, email, roleId, tokenHash, invitedBy, expiresAt, acceptedAt: null, cancelledAt: null, createdAt: now() }
      invites.set(i.id, i); return copy(i)
    },

    // Members.
    async memberOf (orgId, userId) { return copy(findMember(orgId, userId)) },
    async memberById (orgId, id) { const m = members.get(id); return m && m.orgId === orgId ? copy(m) : null },
    async listMembers (orgId) { return all(members, (m) => m.orgId === orgId).map((m) => ({ ...copy(m), name: nameOf(m.userId) })).sort((a, b) => a.joinedAt - b.joinedAt) },
    async addMember ({ orgId, userId, roleId }) {
      const existing = findMember(orgId, userId)
      if (existing) return copy(existing)
      if (!roleInOrg(roleId, orgId)) throw fkViolation('role')
      const m = { id: uuid(), orgId, userId, agentId: null, roleId, joinedAt: now() }
      members.set(m.id, m); return copy(m)
    },
    async setMemberRole (id, roleId) {
      const m = members.get(id)
      if (!roleInOrg(roleId, m.orgId)) throw fkViolation('role')
      m.roleId = roleId; return copy(m)
    },
    async removeMember (id) { dropMember(id) }
  }
}
