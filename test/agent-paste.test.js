// The text the app hands you to paste into an AI so it joins as your agent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentPaste } from '../src/ui/invite.js'

const LINK = 'https://api.heyquilt.com/v1/join/qj_abc'
const INVITE = 'https://join.heyquilt.com/room-1a2b#s3cret'

test('with a session, the paste registers the agent and then joins that session', () => {
  const text = agentPaste({ link: LINK, invite: INVITE })
  assert.match(text, /^Join Quilt as my AI agent\./)
  assert.ok(text.includes(`quilt agent join ${LINK} --name my-agent`), 'register command')
  assert.ok(text.includes(`quilt_join_session tool with ${INVITE}`), 'MCP tool')
  assert.ok(text.includes(`quilt join ${INVITE} --agent my-agent`), 'CLI fallback')
  assert.ok(text.includes('within an hour'))
})

test('without a session, the paste only registers, and says how to join later', () => {
  const text = agentPaste({ link: LINK, name: 'claude' })
  assert.ok(text.includes(`quilt agent join ${LINK} --name claude`))
  assert.ok(text.includes('quilt join <invite link> --agent <name>'))
  assert.equal(text.includes('join.heyquilt.com'), false)
})
