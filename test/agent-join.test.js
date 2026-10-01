import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { startTestApi, API_URL } from './api-helpers.js'
import { agentJoin, agentWhoami, agentFile, describeAgent, parseJoinLink, DEFAULTS } from '../src/agent-join.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-agent-'))
// A fresh personal invite link, pointed at the test API instead of the public address.
const newLink = async (who = 'mem') => (await t.call('POST', '/v1/agent-invites', {}, who)).body.link.replace(API_URL, t.api.url)

test('quilt agent join uses the link once and saves its keys privately', async () => {
  const dir = tmp()
  const lines = []
  const saved = await agentJoin({ link: await newLink(), name: 'larry', dir, log: (l) => lines.push(l) })
  assert.match(lines[0], /Joined Quilt as larry/)
  assert.match(saved.accessKey, /^qa_/)
  const file = agentFile('larry', dir)
  assert.equal(file, path.join(dir, 'agents', 'larry.json'))
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual([onDisk.agentId, onDisk.api, !!onDisk.identity.privateKey, onDisk.refreshKey], [saved.agentId, t.api.url, true, saved.refreshKey])
  const agent = await t.store.agentById(saved.agentId)
  assert.deepEqual([agent.name, agent.provider, agent.type, agent.publicKey], ['larry', DEFAULTS.provider, DEFAULTS.type, onDisk.identity.publicKey])
})

test('quilt agent whoami says who the agent is, refreshing an expired access key first', async () => {
  const dir = tmp()
  const saved = await agentJoin({ link: await newLink(), name: 'whoami-bot', provider: 'Anthropic', type: 'coding', dir, log: () => {} })
  const me = await agentWhoami({ name: 'whoami-bot', dir })
  assert.deepEqual([me.agent.id, me.agent.kind], [saved.agentId, 'personal'])
  assert.equal(describeAgent(me), 'whoami-bot (Anthropic, coding): your personal agent')
  const file = agentFile('whoami-bot', dir)
  fs.writeFileSync(file, JSON.stringify({ ...saved, accessExpiresAt: Date.now() - 1 }))
  await agentWhoami({ name: 'whoami-bot', dir })
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.notEqual(after.refreshKey, saved.refreshKey, 'the refresh key rotated')
  assert.ok(after.accessExpiresAt > Date.now())
  // The old refresh key is spent: using it again revokes the agent's keys.
  assert.equal((await t.call('POST', '/v1/agents/token', { refreshKey: saved.refreshKey })).status, 401)
  await assert.rejects(agentWhoami({ name: 'whoami-bot', dir }), /revoked/)
})

test('describeAgent lists an org agent, its role and its teams', () => {
  const me = { agent: { name: 'Bot', provider: 'OpenAI', type: 'coding agent', kind: 'org', org: { slug: 'acme', name: 'Acme' } }, role: { name: 'Lead' }, teams: [{ name: 'Core', access: 'editor', scopes: ['src', 'docs'] }, { name: 'Web', access: 'viewer', scopes: [] }] }
  assert.equal(describeAgent(me), 'Bot (OpenAI, coding agent): an agent in Acme\nRole: Lead\nTeam Core: editor, folders src, docs\nTeam Web: viewer')
})

test('used and malformed links, bad names and unknown agents are refused clearly', async () => {
  const link = await newLink()
  await agentJoin({ link, name: 'first', dir: tmp(), log: () => {} })
  await assert.rejects(agentJoin({ link, name: 'second', dir: tmp(), log: () => {} }), /already used/)
  for (const bad of ['nope', 'https://api.heyquilt.com/v1/agents', 'ftp://x/v1/join/qj_a']) assert.throws(() => parseJoinLink(bad), /invite link/, bad)
  assert.deepEqual(parseJoinLink('https://api.heyquilt.com/v1/join/qj_abc'), { api: 'https://api.heyquilt.com', token: 'qj_abc' })
  assert.throws(() => agentFile('../evil', tmp()), /--name/)
  await assert.rejects(agentWhoami({ name: 'nobody', dir: tmp() }), /quilt agent join <link> --name nobody/)
})

test('quilt agent needs a subcommand, a link to join, and a name', () => {
  const bin = new URL('../bin/quilt.js', import.meta.url).pathname
  for (const args of [['agent'], ['agent', 'join', '--name', 'x'], ['agent', 'join', 'https://x/v1/join/qj_a'], ['agent', 'whoami'], ['agent', 'dance', '--name', 'x']]) {
    const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 1, args.join(' '))
    assert.match(r.stderr, /quilt agent join <link> --name <name>/)
  }
})
