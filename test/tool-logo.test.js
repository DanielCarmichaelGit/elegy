import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolLogo, toolLabel, resolveToolKey } from '../src/ui/tool-logo.js'

test('toolLabel falls back to AI', () => {
  assert.equal(toolLabel(''), 'AI')
  assert.equal(toolLabel(null), 'AI')
  assert.equal(toolLabel('Cursor'), 'Cursor')
})

test('resolveToolKey matches known tools and aliases', () => {
  assert.equal(resolveToolKey('Claude Code'), 'Claude Code')
  assert.equal(resolveToolKey('claude'), 'Claude Code')
  assert.equal(resolveToolKey('CURSOR'), 'Cursor')
  assert.equal(resolveToolKey('GitHub Copilot'), 'GitHub Copilot')
  assert.equal(resolveToolKey('copilot'), 'GitHub Copilot')
  assert.equal(resolveToolKey('MysteryBot'), null)
  assert.equal(resolveToolKey(''), null)
})

test('toolLogo renders an SVG mark with accessible name', () => {
  const html = toolLogo('Claude Code')
  assert.match(html, /aria-label="Claude Code"/)
  assert.match(html, /title="Claude Code"/)
  assert.match(html, /<svg[\s\S]*<\/svg>/)
  assert.match(html, /class="tool-logo"/)
  assert.doesNotMatch(html, />Claude Code</)
})

test('toolLogo uses a generic mark for unknown tools but keeps the label', () => {
  const html = toolLogo('MysteryBot')
  assert.match(html, /aria-label="MysteryBot"/)
  assert.match(html, /<svg[\s\S]*<\/svg>/)
})

test('toolLogo empty tool is labeled AI', () => {
  const html = toolLogo('')
  assert.match(html, /aria-label="AI"/)
  assert.match(html, /<svg/)
})

test('each known TOOLS name has a distinct logo', () => {
  const tools = ['Claude Code', 'Cursor', 'Codex', 'Windsurf', 'GitHub Copilot', 'Zed', 'Aider']
  const marks = tools.map((t) => toolLogo(t))
  // Every logo includes an svg; marks should not all be identical.
  for (const m of marks) assert.match(m, /<svg/)
  assert.equal(new Set(marks).size, marks.length)
})
