import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TASK_WORKFLOW, TASK_WORKFLOW_MD, pickupReminder } from '../src/agent-task-workflow.js'
import { AGENT_GUIDE, setup } from '../src/setup.js'
import { MCP_INSTRUCTIONS } from '../src/mcp.js'
import { INSTRUCTIONS, HOSTED_INSTRUCTIONS } from '../src/relay-mcp.js'

const STEPS = [
  [/grok/i, 'grok'],
  [/plan/i, 'plan'],
  [/build/i, 'build'],
  [/test/i, 'test'],
]

function assertWorkflow (text, label) {
  assert.match(text, /pick up a ticket/i, `${label} should mention picking up a ticket`)
  for (const [re, name] of STEPS) {
    assert.match(text, re, `${label} should include ${name}`)
  }
}

test('TASK_WORKFLOW spells grok → plan → build → test', () => {
  assertWorkflow(TASK_WORKFLOW, 'TASK_WORKFLOW')
  assert.doesNotMatch(TASK_WORKFLOW, /\u2014/, 'no em dashes')
})

test('TASK_WORKFLOW_MD lists the four steps', () => {
  assertWorkflow(TASK_WORKFLOW_MD, 'TASK_WORKFLOW_MD')
  assert.match(TASK_WORKFLOW_MD, /\*\*Grok\*\*/)
  assert.match(TASK_WORKFLOW_MD, /\*\*Plan\*\*/)
  assert.match(TASK_WORKFLOW_MD, /\*\*Build\*\*/)
  assert.match(TASK_WORKFLOW_MD, /\*\*Test\*\*/)
})

test('pickupReminder restates the workflow when starting a ticket', () => {
  const text = pickupReminder('Fix login')
  assert.match(text, /^Picked up "Fix login"\./)
  assertWorkflow(text, 'pickupReminder')
})

test('AGENT_GUIDE includes the shared markdown workflow', () => {
  assert.ok(AGENT_GUIDE.includes(TASK_WORKFLOW_MD), 'AGENT_GUIDE embeds TASK_WORKFLOW_MD')
  assertWorkflow(AGENT_GUIDE, 'AGENT_GUIDE')
})

test('local MCP instructions include TASK_WORKFLOW', () => {
  assert.ok(MCP_INSTRUCTIONS.includes(TASK_WORKFLOW), 'MCP_INSTRUCTIONS embeds TASK_WORKFLOW')
  assertWorkflow(MCP_INSTRUCTIONS, 'MCP_INSTRUCTIONS')
})

test('relay MCP instructions include TASK_WORKFLOW', () => {
  assert.ok(INSTRUCTIONS.includes(TASK_WORKFLOW), 'INSTRUCTIONS embeds TASK_WORKFLOW')
  assert.ok(HOSTED_INSTRUCTIONS.includes(TASK_WORKFLOW), 'HOSTED_INSTRUCTIONS embeds TASK_WORKFLOW')
  assertWorkflow(INSTRUCTIONS, 'INSTRUCTIONS')
  assertWorkflow(HOSTED_INSTRUCTIONS, 'HOSTED_INSTRUCTIONS')
})

test('quilt setup writes the workflow into AGENTS.md and CLAUDE.md', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-workflow-'))
  const changed = setup(root)
  assert.ok(changed.some((c) => c.startsWith('AGENTS.md')))
  assert.ok(changed.some((c) => c.startsWith('CLAUDE.md')))
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    assert.ok(text.includes(TASK_WORKFLOW_MD), `${file} should contain TASK_WORKFLOW_MD`)
    assertWorkflow(text, file)
  }
})
