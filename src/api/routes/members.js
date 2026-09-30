// An org's people: the member list, changing someone's role, removing or leaving.
import { HttpError, needId } from '../http.js'
import { orgAccess } from '../org-access.js'

export function memberRoutes ({ store, user }) {
  const orgFor = async (req, slug) => { const u = await user(req); return { u, ...(await orgAccess(store, u.userId, slug)) } }

  async function target (a, id) {
    const m = await store.memberById(a.org.id, needId(id, 'member'))
    if (!m) throw new HttpError(404, 'no such member')
    if (m.userId === a.org.ownerId) throw new HttpError(403, 'the owner only changes through a transfer')
    return m
  }

  // You can't act on someone whose role holds checkboxes you don't.
  async function outranks (a, m) {
    const r = m.roleId && await store.roleById(a.org.id, m.roleId)
    if (!a.covers(r?.grants)) throw new HttpError(403, "this person has permissions you don't have")
  }

  return [
    ['GET', /^\/v1\/orgs\/([^/]+)\/members$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('members', 'r')
      const [members, roles] = await Promise.all([store.listMembers(a.org.id), store.listRoles(a.org.id)])
      const roleName = new Map(roles.map((r) => [r.id, r.name]))
      // Team names only for people allowed to see who's in each team.
      const teamsOf = new Map()
      if (a.can('team_members', 'r')) {
        for (const team of await store.listTeams(a.org.id)) {
          for (const tm of await store.listTeamMembers(team.id)) {
            teamsOf.set(tm.memberId, [...(teamsOf.get(tm.memberId) || []), { id: team.id, name: team.name, access: tm.access }])
          }
        }
      }
      const emails = await Promise.all(members.map((m) => (m.userId ? store.userEmail(m.userId) : null)))
      return {
        members: members.map((m, i) => ({
          id: m.id,
          userId: m.userId,
          name: m.name,
          email: emails[i]?.email || '',
          roleId: m.roleId,
          role: roleName.get(m.roleId) || null,
          isOwner: m.userId === a.org.ownerId,
          isYou: m.userId === a.u.userId,
          joinedAt: m.joinedAt,
          teams: teamsOf.get(m.id) || []
        }))
      }
    }],

    ['PUT', /^\/v1\/orgs\/([^/]+)\/members\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      // Assigning a role is Members: Update together with Roles: Update.
      a.need('members', 'u')
      a.need('roles', 'u')
      const m = await target(a, id)
      if (m.userId === a.u.userId) throw new HttpError(403, "you can't change your own role")
      await outranks(a, m)
      const role = await a.assignable(body.roleId || 'missing')
      const saved = await store.setMemberRole(m.id, role.id)
      return { member: { id: saved.id, roleId: saved.roleId } }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)\/members\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      const m = await target(a, id)
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
