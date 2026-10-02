// An org's people and agents: the member list, changing a role, removing or leaving.
import { HttpError, needId } from '../http.js'
import { orgAccess } from '../org-access.js'

export function memberRoutes ({ store, user }) {
  const orgFor = async (req, slug) => { const u = await user(req); return { u, ...(await orgAccess(store, u.userId, slug)) } }

  async function target (a, id) {
    const m = await store.memberById(a.org.id, needId(id, 'member'))
    if (!m) throw new HttpError(404, 'no such member')
    if (m.userId && m.userId === a.org.ownerId) throw new HttpError(403, 'the owner only changes through a transfer')
    return m
  }

  // You can't act on someone (or an agent) whose role holds checkboxes you don't.
  async function outranks (a, m) {
    const r = m.roleId && await store.roleById(a.org.id, m.roleId)
    if (!a.covers(r?.grants)) throw new HttpError(403, m.agentId ? "this agent has permissions you don't have" : "this person has permissions you don't have")
  }

  return [
    ['GET', /^\/v1\/orgs\/([^/]+)\/members$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      // One list: people for Members: Read, agents for Agents: Read.
      const seePeople = a.can('members', 'r')
      const seeAgents = a.can('agents', 'r')
      if (!seePeople && !seeAgents) a.need('members', 'r')
      const [everyone, roles] = await Promise.all([store.listMembers(a.org.id), store.listRoles(a.org.id)])
      const members = everyone.filter((m) => (m.agentId ? seeAgents : seePeople))
      const roleName = new Map(roles.map((r) => [r.id, r.name]))
      // Team names only for people allowed to see who's in each team.
      const teamsOf = new Map()
      if (a.can('team_members', 'r')) {
        for (const team of await store.listTeams(a.org.id)) {
          for (const tm of await store.listTeamMembers(team.id)) {
            teamsOf.set(tm.memberId, [...(teamsOf.get(tm.memberId) || []), { id: team.id, name: team.name, access: tm.access, scopes: tm.scopes || [] }])
          }
        }
      }
      const emails = await Promise.all(members.map((m) => (m.userId ? store.userEmail(m.userId) : null)))
      return {
        members: members.map((m, i) => ({
          id: m.id,
          kind: m.agentId ? 'agent' : 'person',
          userId: m.userId ?? null,
          agentId: m.agentId ?? null,
          name: m.name,
          provider: m.provider ?? null,
          type: m.type ?? null,
          // Only for an agent; whether it has a key, never the key itself.
          canJoinSessions: m.agentId ? !!m.publicKey : null,
          email: emails[i]?.email || '',
          roleId: m.roleId,
          role: roleName.get(m.roleId) || null,
          isOwner: !!m.userId && m.userId === a.org.ownerId,
          isYou: !!m.userId && m.userId === a.u.userId,
          joinedAt: m.joinedAt,
          teams: teamsOf.get(m.id) || []
        }))
      }
    }],

    ['PUT', /^\/v1\/orgs\/([^/]+)\/members\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      const m = await target(a, id)
      if (m.agentId) {
        // An agent's role is Agents: Update, and it may have none (team access only).
        a.need('agents', 'u')
        await outranks(a, m)
        // roleId must be given explicitly: a body that omits it is never read as "clear
        // the role", so a partial PUT (e.g. missing a field a future client meant to send)
        // can't silently wipe one.
        if (!('roleId' in body)) throw new HttpError(400, 'roleId is required; use null to clear the role')
        const role = body.roleId ? await a.assignable(body.roleId) : null
        const saved = await store.setMemberRole(m.id, role ? role.id : null)
        return { member: { id: saved.id, roleId: saved.roleId } }
      }
      // Assigning a person's role is Members: Update together with Roles: Update.
      a.need('members', 'u')
      a.need('roles', 'u')
      if (m.userId === a.u.userId) throw new HttpError(403, "you can't change your own role")
      await outranks(a, m)
      const role = await a.assignable(body.roleId || 'missing')
      const saved = await store.setMemberRole(m.id, role.id)
      return { member: { id: saved.id, roleId: saved.roleId } }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)\/members\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      const m = await target(a, id)
      if (m.agentId) {
        // An org agent has nowhere else to be, so removing it revokes it.
        a.need('agents', 'd')
        await outranks(a, m)
        await store.revokeAgent(m.agentId)
        await store.removeMember(m.id)
        return { ok: true }
      }
      // Anyone may leave; removing someone else needs Members: Delete.
      if (m.userId !== a.u.userId) {
        a.need('members', 'd')
        await outranks(a, m)
      }
      await store.removeMember(m.id)
      return { ok: true }
    }]
  ]
}
