// Flat teams inside an org, and who's in each: people and agents with editor or
// viewer access, and for agents, optional folders.
import { HttpError, needId, cleanName } from '../http.js'
import { orgAccess } from '../org-access.js'
import { accessOf, cleanScopes } from '../team-access.js'

const kindOf = (m) => (m.agentId ? 'agent' : 'person')
const memberView = (tm) => ({ memberId: tm.memberId, access: tm.access, scopes: tm.scopes || [] })

export function teamRoutes ({ store, user }) {
  const orgFor = async (req, slug) => { const u = await user(req); return { u, ...(await orgAccess(store, u.userId, slug)) } }

  async function teamIn (a, id) {
    const team = await store.teamById(a.org.id, needId(id, 'team'))
    if (!team) throw new HttpError(404, 'no such team')
    return team
  }

  // Folders only limit agents; a person in a team always reaches all of it.
  // undefined means "leave the folders as they are".
  function foldersFor (m, raw) {
    if (raw === undefined) return undefined
    const scopes = cleanScopes(raw)
    if (scopes.length && !m.agentId) throw new HttpError(400, 'Folders are only for agents.')
    return scopes
  }

  return [
    ['GET', /^\/v1\/orgs\/([^/]+)\/teams$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      const mine = new Map((await store.teamsOfMember(a.me.id)).map((x) => [x.teamId, x.access]))
      // Teams: Read shows every team; everyone sees the teams they're in.
      const teams = (await store.listTeams(a.org.id)).filter((t) => a.can('teams', 'r') || mine.has(t.id))
      return {
        teams: await Promise.all(teams.map(async (t) => ({
          id: t.id,
          name: t.name,
          createdAt: t.createdAt,
          access: mine.get(t.id) || null,
          members: a.can('team_members', 'r') || mine.has(t.id)
            ? (await store.listTeamMembers(t.id)).map((m) => ({ memberId: m.memberId, name: m.name, access: m.access, kind: m.kind, scopes: m.scopes || [] }))
            : null
        }))),
        // The people and agents you could add, for those who add to teams.
        people: a.can('team_members', 'c')
          ? (await store.listMembers(a.org.id)).map((m) => ({ memberId: m.id, name: m.name, kind: kindOf(m) }))
          : null
      }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/teams$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('teams', 'c')
      return { team: await store.createTeam({ orgId: a.org.id, name: cleanName(body.name, 60, 'give the team a name') }) }
    }],

    ['PUT', /^\/v1\/orgs\/([^/]+)\/teams\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('teams', 'u')
      const team = await teamIn(a, id)
      return { team: await store.renameTeam(team.id, cleanName(body.name, 60, 'give the team a name')) }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)\/teams\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('teams', 'd')
      await store.deleteTeam((await teamIn(a, id)).id)
      return { ok: true }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/teams\/([^/]+)\/members$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('team_members', 'c')
      const team = await teamIn(a, id)
      const access = accessOf(body.access ?? 'viewer')
      const m = await store.memberById(a.org.id, needId(body.memberId, 'member'))
      if (!m) throw new HttpError(404, 'no such member')
      const scopes = foldersFor(m, body.scopes) ?? []
      // addTeamMember upserts; without this, Create alone could restyle someone's
      // access by re-adding them, which is Team membership: Update's job.
      if ((await store.listTeamMembers(team.id)).some((x) => x.memberId === m.id)) throw new HttpError(409, 'That person is already in this team.')
      return { member: memberView(await store.addTeamMember({ teamId: team.id, memberId: m.id, access, scopes })) }
    }],

    ['PUT', /^\/v1\/orgs\/([^/]+)\/teams\/([^/]+)\/members\/([^/]+)$/, async (req, body, [slug, id, memberId]) => {
      const a = await orgFor(req, slug)
      a.need('team_members', 'u')
      const team = await teamIn(a, id)
      const m = await store.memberById(a.org.id, needId(memberId, 'member'))
      if (!m) throw new HttpError(404, "that person isn't in this team")
      const tm = await store.setTeamAccess(team.id, m.id, accessOf(body.access), foldersFor(m, body.scopes))
      if (!tm) throw new HttpError(404, "that person isn't in this team")
      return { member: memberView(tm) }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)\/teams\/([^/]+)\/members\/([^/]+)$/, async (req, body, [slug, id, memberId]) => {
      const a = await orgFor(req, slug)
      a.need('team_members', 'd')
      const team = await teamIn(a, id)
      if (!await store.removeTeamMember(team.id, needId(memberId, 'member'))) throw new HttpError(404, "that person isn't in this team")
      return { ok: true }
    }]
  ]
}
