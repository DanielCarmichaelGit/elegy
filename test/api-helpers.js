// Shared setup for the org API tests: an API over a fresh memory store, a fake
// mailer that keeps what it sends, and a cast of people.
import { startApi } from '../src/api/server.js'
import { createMemoryStore } from '../src/api/memory-store.js'

export const SITE = 'https://quilt.test'
// A bearer "user:<id>" stands in for a website user's JWT.
const verifyUser = async (t) => (t && t.startsWith('user:') ? { userId: t.slice(5), email: '' } : null)

const CAST = [
  ['owner', 'Olive', 'olive@acme.com'], ['admin', 'Ada', 'ada@acme.com'], ['mem', 'Mo', 'mo@acme.com'],
  ['lim', 'Lin', 'lin@acme.com'], ['out', 'Otto', 'otto@else.com'], ['gm', 'Gee', 'gee@gmail.com'],
  ['unconf', 'Una', 'una@acme.com', false]
]

export async function startTestApi (opts = {}) {
  const store = createMemoryStore()
  for (const [id, name, email, confirmed = true] of CAST) store.addUser(id, { name, email, confirmed })
  const sent = []
  const mailer = { send: async (m) => { sent.push(m) } }
  const api = await startApi({ store, verifyUser, siteUrl: SITE, agentKeySecret: 'test-secret', startLimit: 1000, inviteLimit: 1000, inviteSendLimit: 1000, mailer, ...opts })
  const call = async (method, path, body, userId, headers = {}) => {
    const res = await fetch(api.url + path, {
      method,
      headers: { 'content-type': 'application/json', ...(userId ? { authorization: `Bearer user:${userId}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  return { api, store, sent, call, close: () => api.close() }
}

/** An org owned by "owner", with "admin" as Admin and "mem" as Member. */
export async function makeOrg (t, name = 'Acme') {
  const { body } = await t.call('POST', '/v1/orgs', { name }, 'owner')
  const org = await t.store.orgBySlug(body.org.slug)
  const roles = await t.store.listRoles(org.id)
  const role = (b) => roles.find((r) => r.builtin === b)
  const admin = await t.store.addMember({ orgId: org.id, userId: 'admin', roleId: role('admin').id })
  const mem = await t.store.addMember({ orgId: org.id, userId: 'mem', roleId: role('member').id })
  const owner = await t.store.memberOf(org.id, 'owner')
  return { slug: org.slug, org, role, owner, admin, mem }
}
