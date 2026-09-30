import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentSetup } from '../lib/agent-setup.js'

test('agent setup snippets carry the key and the MCP address', () => {
  const s = agentSetup('qa_TESTKEY')
  assert.match(s.claudeCode, /^claude mcp add --transport http quilt https:\/\/api\.heyquilt\.com\/mcp --header "Authorization: Bearer qa_TESTKEY"$/)
  const cursor = JSON.parse(s.cursor)
  assert.equal(cursor.mcpServers.quilt.url, 'https://api.heyquilt.com/mcp')
  assert.equal(cursor.mcpServers.quilt.headers.Authorization, 'Bearer qa_TESTKEY')
})
