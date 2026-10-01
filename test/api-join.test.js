import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, API_URL } from './api-helpers.js'
import { generateIdentity } from '../src/identity.js'
import { newToken, hashToken } from '../src/api/tokens.js'
import { joinInstructions, joinNext } from '../src/api/join-text.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())

const PROFILE = { name: 'Larry', provider: 'Anthropic', type: 'coding agent', description: 'Writes tests' }
// A fresh personal invite; returns its token (the path after /v1/join/).
async function invite (who = 'mem', path = '/v1/agent-invites', body = {}) {
  const r = await t.call('POST', path, body, who)
  return { token: r.body.link.split('/v1/join/')[1], id: r.body.invite.id }
}
const join = (token, body = PROFILE) => t.call('POST', `/v1/join/${token}`, body)
const raw = async (path) => {
  const res = await fetch(t.api.url + path)
  return { status: res.status, text: await res.text(), headers: res.headers }
}
const statusOf = async (who, id) => (await t.call('GET', '/v1/agent-invites', null, who)).body.invites.find((i) => i.id === id).status

test('the instructions explain both ways to join, with no em dashes', () => {
  const text = joinInstructions({ link: 'https://api.x/v1/join/qj_abc', apiUrl: 'https://api.x', status: 'waiting', expiresAt: Date.parse('2026-10-01T12:00:00Z') })
  assert.match(text, /Status: this invite is open\. It works once, until 2026-10-01T12:00:00\.000Z\./)
  assert.match(text, /POST https:\/\/api\.x\/v1\/join\/qj_abc/)
  assert.match(text, /"name": /)
  assert.match(text, /GET https:\/\/api\.x\/v1\/join\/qj_abc\?name=/)
  assert.match(text, /POST https:\/\/api\.x\/v1\/agents\/token/)
  assert.match(text, /does not use the invite/)
  for (const [status, line] of [['used', /already used/], ['expired', /has expired/], ['cancelled', /was cancelled/], ['unknown', /isn't valid/]]) {
    assert.match(joinInstructions({ link: 'l', apiUrl: 'a', status }), line, status)
  }
  const next = joinNext({ name: 'Larry', apiUrl: 'https://api.x' })
  assert.match(next, /Larry/)
  assert.match(next, /https:\/\/api\.x\/v1\/agents\/me/)
  for (const s of [text, next]) assert.equal(s.includes('—'), false, 'no em dash')
})

test('an AI joins with POST: a personal agent with its profile and its first keys, once', async () => {
  const { token, id } = await invite('mem')
  const r = await join(token)
  assert.equal(r.status, 200)
  assert.match(r.body.accessKey, /^qa_/)
  assert.match(r.body.refreshKey, /^qr_/)
  assert.ok(r.body.accessExpiresAt > Date.now() && r.body.refreshExpiresAt > r.body.accessExpiresAt)
  assert.deepEqual([r.body.api, r.body.refresh, r.body.mcp], [API_URL, `${API_URL}/v1/agents/token`, `${API_URL}/mcp`])
  assert.match(r.body.next, /Larry/)
  const agent = await t.store.agentById(r.body.agentId)
  assert.deepEqual([agent.name, agent.provider, agent.type, agent.description, agent.ownerUserId, agent.orgId, agent.invitedBy, agent.publicKey], ['Larry', 'Anthropic', 'coding agent', 'Writes tests', 'mem', null, 'mem', null])
  const me = await t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${r.body.accessKey}` })
  assert.deepEqual([me.status, me.body.agent.kind], [200, 'personal'])
  const listed = (await t.call('GET', '/v1/agent-invites', null, 'mem')).body.invites.find((i) => i.id === id)
  assert.deepEqual([listed.status, listed.usedBy], ['used', { id: agent.id, name: 'Larry', provider: 'Anthropic' }])
  const again = await join(token, { ...PROFILE, name: 'Other' })
  assert.deepEqual([again.status, again.body.error], [410, 'this invite was already used; ask for a new one'])
})

test('a plain GET only explains: it never uses the invite, and is not cached or indexed', async () => {
  const { token, id } = await invite('mem')
  const r = await raw(`/v1/join/${token}`)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /^text\/markdown/)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal(r.headers.get('x-robots-tag'), 'noindex')
  assert.match(r.text, /Status: this invite is open/)
  assert.ok(r.text.includes(`POST ${API_URL}/v1/join/${token}`))
  await raw(`/v1/join/${token}`)
  assert.equal(await statusOf('mem', id), 'waiting', 'still open after two previews')
  assert.equal((await join(token)).status, 200)
  const used = await raw(`/v1/join/${token}`)
  assert.equal(used.status, 410)
  assert.match(used.text, /already used/)
})

test('a GET that names the agent joins, for AIs that can only fetch', async () => {
  const { token } = await invite('mem')
  const partial = await raw(`/v1/join/${token}?name=Fetchy&provider=OpenAI`)
  assert.equal(partial.status, 400, 'type is missing')
  assert.equal(partial.headers.get('x-robots-tag'), 'noindex')
  const r = await t.call('GET', `/v1/join/${token}?name=Fetchy&provider=OpenAI&type=chat%20assistant`)
  assert.equal(r.status, 200)
  const agent = await t.store.agentById(r.body.agentId)
  assert.deepEqual([agent.name, agent.provider, agent.type, agent.description], ['Fetchy', 'OpenAI', 'chat assistant', ''])
})

test('a bad request never burns the invite', async () => {
  const { token, id } = await invite('mem')
  assert.equal((await join(token, { name: 'X', type: 'coding agent' })).status, 400, 'no provider')
  assert.equal((await join(token, { ...PROFILE, name: '  ' })).status, 400)
  assert.equal((await join(token, { ...PROFILE, publicKey: 'nope' })).status, 400)
  assert.equal((await t.call('POST', `/v1/join/${token}`)).status, 400, 'no body')
  assert.equal(await statusOf('mem', id), 'waiting')
  const long = await join(token, { ...PROFILE, name: 'n'.repeat(60), description: 'd'.repeat(300) })
  const agent = await t.store.agentById(long.body.agentId)
  assert.deepEqual([agent.name.length, agent.description.length], [40, 180])
})

test('an agent may bring its own public key, which belongs to one agent only', async () => {
  const id = generateIdentity()
  const a = await invite('mem'); const b = await invite('mem')
  const r = await join(a.token, { ...PROFILE, publicKey: id.publicKey })
  assert.equal((await t.store.agentById(r.body.agentId)).publicKey, id.publicKey)
  assert.equal((await join(b.token, { ...PROFILE, publicKey: id.publicKey })).status, 409)
  assert.equal(await statusOf('mem', b.id), 'waiting')
})

test('expired, cancelled and unknown invites are refused, and their GET says why', async () => {
  const expired = newToken('qj_')
  await t.store.createAgentInvite({ tokenHash: hashToken(expired), ownerUserId: 'mem', createdBy: 'mem', expiresAt: Date.now() - 1 })
  const cancelled = await invite('mem')
  await t.call('DELETE', `/v1/agent-invites/${cancelled.id}`, null, 'mem')
  assert.deepEqual([(await join(expired)).status, (await join(expired)).body.error], [410, 'this invite has expired; ask for a new one'])
  assert.equal((await join(cancelled.token)).status, 410)
  assert.equal((await join(newToken('qj_'))).status, 404)
  assert.equal((await join('nonsense')).status, 404)
  const e = await raw(`/v1/join/${expired}`)
  assert.deepEqual([e.status, /has expired/.test(e.text)], [410, true])
  const c = await raw(`/v1/join/${cancelled.token}`)
  assert.deepEqual([c.status, /was cancelled/.test(c.text)], [410, true])
  const u = await raw(`/v1/join/${newToken('qj_')}`)
  assert.deepEqual([u.status, /isn't valid/.test(u.text), u.headers.get('x-robots-tag')], [404, true, 'noindex'])
})

test('an org invite makes an org agent with the role, teams and folders it was given', async () => {
  const o = await makeOrg(t, 'Join Bots Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const web = await t.store.createTeam({ orgId: o.org.id, name: 'Web' })
  const gone = await t.store.createTeam({ orgId: o.org.id, name: 'Gone' })
  const lead = await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: { teams: { r: true } } })
  const { token } = await invite('admin', `/v1/orgs/${o.slug}/agent-invites`, { roleId: lead.id, teams: [{ teamId: core.id, access: 'editor', scopes: ['src'] }, { teamId: web.id }, { teamId: gone.id }] })
  await t.store.deleteTeam(gone.id)
  const r = await join(token, { name: 'Bot', provider: 'OpenAI', type: 'coding agent' })
  assert.equal(r.status, 200)
  const me = (await t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${r.body.accessKey}` })).body
  assert.deepEqual(me.agent.org, { slug: o.slug, name: 'Join Bots Co' })
  assert.deepEqual(me.role, { name: 'Lead' })
  assert.deepEqual(me.teams.map((x) => [x.name, x.access, x.scopes]).sort(), [['Core', 'editor', ['src']], ['Web', 'viewer', []]], 'a team deleted since is skipped')
  const agent = await t.store.agentById(r.body.agentId)
  assert.deepEqual([agent.orgId, agent.ownerUserId, agent.invitedBy], [o.org.id, null, 'admin'])
})

test('two joins racing on one invite: only one agent is made', async () => {
  const { token } = await invite('mem')
  const [a, b] = await Promise.all([join(token, { ...PROFILE, name: 'A' }), join(token, { ...PROFILE, name: 'B' })])
  assert.deepEqual([a.status, b.status].sort(), [200, 410])
})

test('a join that fails part way removes the half-made agent and reopens the invite', async () => {
  const o = await makeOrg(t, 'Join Flaky Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const { token, id } = await invite('admin', `/v1/orgs/${o.slug}/agent-invites`, { teams: [{ teamId: core.id }] })
  const broken = await startTestApi({ store: { ...t.store, addTeamMember: async () => { throw new Error('db down') } } })
  try {
    assert.equal((await broken.call('POST', `/v1/join/${token}`, { ...PROFILE, name: 'Half' })).status, 500)
  } finally { await broken.close() }
  const after = await t.store.agentInviteById(id)
  assert.deepEqual([after.usedAt, after.usedByAgentId], [null, null])
  assert.equal((await t.store.listMembers(o.org.id)).some((m) => m.name === 'Half'), false, 'the half-made agent is gone')
  assert.equal((await join(token)).status, 200, 'and the link still works')
})

test('joining is rate-limited per address', async () => {
  const limited = await startTestApi({ joinLimit: 2 })
  try {
    for (const want of [404, 404, 429]) assert.equal((await fetch(`${limited.api.url}/v1/join/qj_nope`)).status, want)
  } finally { await limited.close() }
})
