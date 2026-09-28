// Wires cowove into AI coding tools in the current project: registers the MCP
// server for Claude Code / Cursor and adds pairing guidance to the agent
// instruction files. These files live in the project, so they sync to
// everyone in the session.
import fs from 'node:fs'
import path from 'node:path'

const START = '<!-- cowove:start -->'
const END = '<!-- cowove:end -->'

export const AGENT_GUIDE = `${START}
## Live pair session (cowove)

This project is being edited **live by more than one person at once**, each
with their own AI coding tool. Files can change underneath you at any time.

- Before starting a task, check what your collaborators are doing: call the
  \`cowove_status\` MCP tool, or run \`cowove status\` in a shell, or read
  \`.cowove/STATUS.md\`.
- See what a partner's AI is doing with \`cowove_partner_feed\`, and where people
  are working with \`cowove_list_files\` (recent edits and claims).
- Announce what you're working on (\`cowove_set_focus\` / \`cowove focus "..."\`).
- Before a larger change, claim the files (\`cowove_claim\` / \`cowove claim <glob>\`)
  and release them when done. Edits to files someone else has claimed are
  undone automatically, so don't try; send them a message
  (\`cowove_message\` / \`cowove say "..."\`) instead.
- Always re-read a file right before editing it; never rely on an old copy.
- Prefer small, focused edits over rewriting whole files.
- Don't run git commands that rewrite the working tree (checkout, reset,
  stash, rebase) without asking: those changes sync to everyone instantly.
${END}`

function upsertBlock (file, block) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch {}
  const re = new RegExp(`${START}[\\s\\S]*?${END}`)
  const next = re.test(text) ? text.replace(re, block) : (text ? text.replace(/\s*$/, '\n\n') : '') + block + '\n'
  if (next !== text) fs.writeFileSync(file, next)
  return next !== text
}

function upsertMcp (file, key = 'mcpServers') {
  let json = {}
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  json[key] = json[key] || {}
  json[key].cowove = { command: 'cowove', args: ['mcp'] }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = JSON.stringify(json, null, 2) + '\n'
  let prev = ''
  try { prev = fs.readFileSync(file, 'utf8') } catch {}
  if (prev !== text) fs.writeFileSync(file, text)
  return prev !== text
}

export function setup (root) {
  const changed = []
  if (upsertMcp(path.join(root, '.mcp.json'))) changed.push('.mcp.json (Claude Code MCP server)')
  if (upsertMcp(path.join(root, '.cursor', 'mcp.json'))) changed.push('.cursor/mcp.json (Cursor MCP server)')
  if (upsertBlock(path.join(root, 'AGENTS.md'), AGENT_GUIDE)) changed.push('AGENTS.md (Cursor, Codex, and other agents)')
  if (upsertBlock(path.join(root, 'CLAUDE.md'), AGENT_GUIDE)) changed.push('CLAUDE.md (Claude Code)')
  return changed
}
