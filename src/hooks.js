// `quilt hook`: Claude Code hooks that make claims automatic. Before every
// edit, the file is claimed for this person (or the edit is refused when
// someone else holds it, with a nudge to ask them for help); claims the hooks
// made are released when Claude finishes. Direct messages, mentions and tasks
// handed over by collaborators are shown to Claude so it can answer requests
// like "can you help with X?" and take work that is given to it.
//
// Reads the hook event as JSON on stdin and answers on stdout, as Claude Code
// expects. Without a running session it does nothing, so the hooks are harmless
// in a folder that isn't in a Quilt session.
import fs from 'node:fs'
import path from 'node:path'
import { findDaemon } from './control.js'
import { migrateDir } from './legacy.js'
import { describeEvent } from './inbox.js'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TIMEOUT_MS = 5000

/** Settings for .claude/settings.json: every hook runs `quilt hook`. */
export const HOOK_COMMAND = 'quilt hook'
export function hookSettings () {
  const run = { type: 'command', command: HOOK_COMMAND, timeout: 10 }
  return {
    SessionStart: [{ hooks: [run] }],
    PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [run] }],
    PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [run] }],
    Stop: [{ hooks: [run] }],
    SessionEnd: [{ hooks: [run] }]
  }
}

/**
 * Handles one hook event. Returns { output?, exitCode } where `output` is the
 * JSON object to print. `daemon` and `call` can be injected for tests.
 */
export async function handleHook (event, { findDaemon: find = findDaemon, call = callWithTimeout } = {}) {
  const cwd = event.cwd || process.cwd()
  const d = find(cwd)
  if (!d) return { exitCode: 0 }
  const api = (method, route, body) => call(d, method, route, body)
  const state = hookState(d.dir, event.session_id)
  switch (event.hook_event_name) {
    case 'SessionStart': return sessionStart(api, state)
    case 'PreToolUse': return preEdit(event, d, api, state)
    case 'PostToolUse': return postEdit(api, state)
    case 'Stop': return stop(event, api, state)
    case 'SessionEnd': return sessionEnd(api, state)
    default: return { exitCode: 0 }
  }
}

async function sessionStart (api, state) {
  const st = await api('GET', '/status')
  // Only what arrives from now on is for this Claude; what came before is for quilt_inbox.
  const { seq } = await api('POST', '/inbox', { after: 0 }).catch(() => ({ seq: 0 }))
  state.update((s) => { s.after = seq || 0 })
  const who = st.peers.length ? st.peers.map((p) => p.name + (p.kind === 'agent' ? ' (AI agent)' : '')).join(', ') : 'nobody else yet'
  const parts = [
    `This folder is in a live Quilt session (room ${st.room}) with ${who}. Files can change underneath you at any time; re-read a file right before editing it.`,
    'Quilt claims each file for you the moment you edit it, and releases those claims when you finish. ' +
    'If a file is claimed by someone else, your edit is refused: do not retry or work around it. ' +
    'Send them a direct message with quilt_message saying what you wanted to change and asking for help, then carry on with other work.',
    'Messages from collaborators, mentions of you and tasks handed to you are shown to you as you work; answer with quilt_message and take a task with quilt_move_task.'
  ]
  const merges = mergesContext(st.merges)
  if (merges) parts.push(merges)
  return { exitCode: 0, output: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n') } } }
}

/** One short paragraph naming the files still open for merging, or null when there are none. */
function mergesContext (merges) {
  const open = (merges || []).filter((m) => m.state !== 'done')
  if (!open.length) return null
  const describe = (m) => {
    const action = m.oursDeleted ? 'deleted it offline' : 'changed it offline'
    const other = (m.others && m.others[0]) || m.claimedBy
    return `\`${m.path}\` (${m.by} ${action}${other ? `, ${other} in the session` : ''})`
  }
  const shown = open.slice(0, 5).map(describe).join(', ')
  const more = open.length > 5 ? `, and ${open.length - 5} more` : ''
  return `${open.length} file(s) need merging: ${shown}${more}. Run quilt_merges before editing those files; settle one with quilt_resolve_merge.`
}

async function preEdit (event, d, api, state) {
  if (!EDIT_TOOLS.has(event.tool_name)) return { exitCode: 0 }
  const input = event.tool_input || {}
  const file = input.file_path || input.notebook_path
  if (!file) return { exitCode: 0 }
  const abs = path.resolve(event.cwd || d.dir, String(file))
  const rel = path.relative(d.dir, abs).split(path.sep).join('/')
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { exitCode: 0 } // not in the project
  const info = await api('POST', '/claim-for', { path: rel })
  if (!info.shared) return { exitCode: 0 } // Quilt doesn't sync it, so nobody can clash on it
  if (info.claim && info.mine) return { exitCode: 0 }
  if (info.claim) return deny(rel, info.claim, 'PreToolUse')
  // Nobody holds it: claim it for this person while they work.
  try {
    await api('POST', '/claim', { pattern: rel, note: info.focus ? `editing: ${info.focus}` : 'editing' })
  } catch (err) {
    const again = await api('POST', '/claim-for', { path: rel }).catch(() => null)
    if (again && again.claim && !again.mine) return deny(rel, again.claim, 'PreToolUse')
    if (again && again.claim && again.mine) return { exitCode: 0 }
    return deny(rel, null, 'PreToolUse', err.message)
  }
  state.update((s) => { if (!s.claims.includes(rel)) s.claims.push(rel) })
  return { exitCode: 0 }
}

/** The refusal Claude sees: who holds the file, and what to do instead of retrying. */
function deny (rel, claim, hookEventName, error) {
  const holder = claim ? claim.by : 'someone else'
  const why = claim ? (claim.note ? ` (${claim.note})` : '') : error ? ` (${error})` : ''
  const covered = claim && claim.pattern !== rel ? `, as part of their claim on ${claim.pattern}` : ''
  const reason = `${rel} is claimed by ${holder}${why}${covered}, so Quilt refused this edit and would undo it. ` +
    `Do not retry or work around it. Instead, send ${holder} a direct message with quilt_message (to: "${holder}") saying ` +
    `what you wanted to change in ${rel} and why, and ask them to make the change or hand the file over. ` +
    'Then carry on with other work and check quilt_read_messages for their answer.'
  return { exitCode: 0, output: { hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason: reason } } }
}

async function postEdit (api, state) {
  const events = await unseenEvents(api, state)
  if (!events.length) return { exitCode: 0 }
  state.update((s) => { for (const e of events) s.seen.push(e.id) })
  const text = renderAsks(events)
  return { exitCode: 0, output: { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } } }
}

async function stop (event, api, state) {
  if (!event.stop_hook_active) {
    const events = await unseenEvents(api, state)
    if (events.length) {
      state.update((s) => { for (const e of events) s.seen.push(e.id) })
      return { exitCode: 0, output: { decision: 'block', reason: `${renderAsks(events)}\nReply with quilt_message, and take or decline a task you were handed, before you finish (and release files you no longer need with quilt_release), then finish.` } }
    }
  }
  await releaseAll(api, state)
  return { exitCode: 0 }
}

async function sessionEnd (api, state) {
  await releaseAll(api, state)
  state.remove()
  return { exitCode: 0 }
}

/**
 * Inbox events (direct messages, mentions, tasks handed over) since this Claude session
 * started that it hasn't been shown yet. The person's own unread state is untouched.
 */
async function unseenEvents (api, state) {
  const s = state.read()
  const { events } = await api('POST', '/inbox', { after: s.after || 0 })
  const seen = new Set(s.seen)
  return events.filter((e) => e && e.id && !seen.has(e.id))
}

function renderAsks (events) {
  const lines = events.map((e) => `- ${describeEvent(e)}`)
  return `Quilt: collaborators wrote to you, or handed you work, while you were working:\n${lines.join('\n')}\n` +
    'If a message asks about a file you hold, reply with quilt_message (to: their name): help with the change, hand the file over ' +
    '(quilt_release the file, then tell them), or say when you will be done. Take a task you were handed with quilt_move_task when you are free, or say in chat why not.'
}

/** Releases every claim the hooks made for this Claude session. */
async function releaseAll (api, state) {
  const s = state.read()
  for (const pattern of s.claims) await api('POST', '/release', { pattern }).catch(() => {})
  state.update((x) => { x.claims = [] })
}

/** Per-Claude-session state in .quilt/hooks/<session>.json: the claims it made and the messages it has seen. */
export function hookState (projectDir, sessionId) {
  const dir = path.join(migrateDir(projectDir), 'hooks')
  const file = path.join(dir, `${String(sessionId || 'default').replace(/[^\w.-]/g, '_')}.json`)
  const read = () => {
    try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return { claims: s.claims || [], seen: s.seen || [], after: s.after || 0 } } catch { return { claims: [], seen: [], after: 0 } }
  }
  return {
    file,
    read,
    update (fn) {
      const s = read()
      fn(s)
      if (s.seen.length > 500) s.seen = s.seen.slice(-500)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(s))
    },
    remove () { try { fs.rmSync(file) } catch {} }
  }
}

/**
 * Releases claims left behind by hooks of Claude sessions that ended without
 * telling us (a crash, a closed laptop). Run when a session starts for the folder.
 */
export async function releaseLeftoverHookClaims (session) {
  const dir = path.join(session.stateDir, 'hooks')
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')) } catch { return 0 }
  let released = 0
  for (const n of names) {
    const st = hookState(session.root, n.slice(0, -5))
    for (const pattern of st.read().claims) {
      try { released += await session.release(pattern) } catch {}
    }
    st.remove()
  }
  return released
}

async function callWithTimeout (daemon, method, route, body) {
  const res = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}

/** The CLI entry: stdin JSON in, JSON (if any) out. Never fails loudly: a broken hook must not block someone's editor. */
export async function runHook ({ stdin = process.stdin, stdout = process.stdout } = {}) {
  let raw = ''
  for await (const chunk of stdin) raw += chunk
  let event
  try { event = JSON.parse(raw) } catch { return 0 }
  try {
    const r = await handleHook(event)
    if (r.output) stdout.write(JSON.stringify(r.output) + '\n')
    return r.exitCode
  } catch (err) {
    process.stderr.write(`quilt hook: ${err.message}\n`)
    return 0
  }
}
