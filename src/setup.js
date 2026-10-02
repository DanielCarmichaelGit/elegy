// Wires quilt into AI coding tools in the current project: registers the MCP
// server for Claude Code / Cursor and adds pairing guidance to the agent
// instruction files. These files live in the project, so they sync to
// everyone in the session.
import fs from 'node:fs'
import path from 'node:path'
import { hookSettings, HOOK_COMMAND } from './hooks.js'
import { TASK_WORKFLOW_MD } from './agent-task-workflow.js'

const START = '<!-- quilt:start -->'
const END = '<!-- quilt:end -->'

export const AGENT_GUIDE = `${START}
## Live pair session (quilt)

This project is being edited **live by more than one person at once**, each
with their own AI coding tool. Files can change underneath you at any time.

- Before starting a task, check what your collaborators are doing: call the
  \`quilt_status\` MCP tool, or run \`quilt status\` in a shell, or read
  \`.quilt/STATUS.md\`.
- The session has a shared task board (To do, In progress, Done). Read it with
  \`quilt_tasks\`. Add work with \`quilt_add_task\`. Move a task to In progress
  when you start it and to Done when you finish (\`quilt_move_task\`).
${TASK_WORKFLOW_MD}
- See what a partner's AI is doing with \`quilt_partner_feed\`, and where people
  are working with \`quilt_list_files\` (recent edits and claims).
- Announce what you're working on (\`quilt_set_focus\` / \`quilt focus "..."\`).
- Files must be claimed before they are edited. In Claude Code this is automatic:
  Quilt claims each file for you as you edit it and releases those claims when you
  finish. In other tools, claim first (\`quilt_claim\` / \`quilt claim <path>\`) and
  release when done (\`quilt_release\` / \`quilt release <path>\`).
- If a file is claimed by someone else, your edit is refused or undone. Don't retry
  or work around it: send them a direct message (\`quilt_message\` with "to" /
  \`quilt say @name "..."\`) saying what you wanted to change and asking for help,
  then carry on with other work.
- Answer collaborators' messages (\`quilt_read_messages\`): help with their change,
  hand the file over, or say when you'll be done.
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
  json[key].quilt = { command: 'quilt', args: ['mcp'] }
  delete json[key].cowove // the old name (renamed to Quilt)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = JSON.stringify(json, null, 2) + '\n'
  let prev = ''
  try { prev = fs.readFileSync(file, 'utf8') } catch {}
  if (prev !== text) fs.writeFileSync(file, text)
  return prev !== text
}

/**
 * Puts Quilt's hooks into the project's .claude/settings.json (shared with everyone
 * in the session), replacing earlier Quilt entries and leaving other hooks alone.
 * Returns true when the file changed.
 */
export function installHooks (root) {
  const file = path.join(root, '.claude', 'settings.json')
  let prev = ''
  try { prev = fs.readFileSync(file, 'utf8') } catch {}
  let json = {}
  try { json = JSON.parse(prev) || {} } catch {}
  if (typeof json !== 'object' || Array.isArray(json)) json = {}
  const hooks = (json.hooks && typeof json.hooks === 'object' && !Array.isArray(json.hooks)) ? json.hooks : {}
  const ours = (h) => h && typeof h.command === 'string' && h.command.startsWith(HOOK_COMMAND)
  for (const [event, entries] of Object.entries(hookSettings())) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : [])
      .map((e) => (e && Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.filter((h) => !ours(h)) } : e))
      .filter((e) => e && (!Array.isArray(e.hooks) || e.hooks.length))
    hooks[event] = [...kept, ...entries]
  }
  json.hooks = hooks
  const text = JSON.stringify(json, null, 2) + '\n'
  if (prev === text) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return true
}

export function setup (root) {
  const changed = []
  if (upsertMcp(path.join(root, '.mcp.json'))) changed.push('.mcp.json (Claude Code MCP server)')
  if (installHooks(root)) changed.push('.claude/settings.json (Claude Code hooks: claim files as you edit them)')
  if (upsertMcp(path.join(root, '.cursor', 'mcp.json'))) changed.push('.cursor/mcp.json (Cursor MCP server)')
  if (upsertBlock(path.join(root, 'AGENTS.md'), AGENT_GUIDE)) changed.push('AGENTS.md (Cursor, Codex, and other agents)')
  if (upsertBlock(path.join(root, 'CLAUDE.md'), AGENT_GUIDE)) changed.push('CLAUDE.md (Claude Code)')
  return changed
}
