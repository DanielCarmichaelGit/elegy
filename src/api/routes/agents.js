// A person's personal agents. (Task 4 adds the agents' own key and /me routes.)
import { HttpError, needId } from '../http.js'

const agentView = (a) => ({ id: a.id, name: a.name, provider: a.provider, type: a.type, description: a.description, createdAt: a.createdAt, lastUsedAt: a.lastUsedAt })

export function agentRoutes ({ store, user }) {
  return [
    ['GET', /^\/v1\/agents$/, async (req) => {
      const u = await user(req)
      return { agents: (await store.listPersonalAgents(u.userId)).map(agentView) }
    }],

    ['DELETE', /^\/v1\/agents\/([^/]+)$/, async (req, body, [id]) => {
      const u = await user(req)
      const agent = await store.agentById(needId(id, 'agent'))
      // Someone else's agent gets the same answer as a missing one.
      if (!agent || agent.ownerUserId !== u.userId || agent.revokedAt) throw new HttpError(404, 'no such agent')
      await store.revokeAgent(agent.id)
      return { ok: true }
    }]
  ]
}
