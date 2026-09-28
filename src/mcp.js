// MCP server (stdio) that lets any MCP-capable agent (Claude Code, Cursor,
// Windsurf, Codex, ...) take part in a live session: see what collaborators
// and their AIs are doing, coordinate, and even join or start a session by
// itself. It forwards to the local `cowove join` process for the project, or
// runs the session itself when the agent joins on its own.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findDaemon, call } from './control.js'
import { renderMessage } from './status.js'
import { runSession, decodeInvite, newConn, readConfig, runningElsewhere } from './runner.js'
import { defaultRelay, normalizeRelay, keyFor } from './settings.js'
import { toolLabel } from './agents/common.js'

export { toolLabel }

const NOT_RUNNING = 'There is no live cowove session for this project. If the user gave you an invite link, join with ' +
  'cowove_join_session. To start a new session, use cowove_start_session. A person can also run `cowove join` or `cowove ui`.'

export async function runMcp () {
  const server = new McpServer(
    { name: 'cowove', version: '0.1.0' },
    {
      instructions: 'cowove lets several people (and their AI agents) edit one project live, each in their own tool. ' +
        'If you are given a cowove invite link, join with cowove_join_session. In a session, files may change underneath ' +
        'you at any time. Call cowove_status before starting a task; use cowove_partner_feed to see what a partner\'s AI is ' +
        'doing; announce your task with cowove_set_focus; claim files or folders before larger changes and do not edit files ' +
        'someone else has claimed. Always re-read a file right before you edit it.'
    }
  )

  // A session this MCP server runs itself, when the agent joined or started one.
  let joined = null // { run, dir, invite }
  let logs = []
  const clientTool = () => toolLabel(server.server.getClientVersion()?.name)

  const withDaemon = async (fn) => {
    const d = findDaemon(joined ? joined.dir : undefined)
    if (!d) return { content: [{ type: 'text', text: NOT_RUNNING }], isError: true }
    try {
      return { content: [{ type: 'text', text: await fn(d) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
    }
  }

  server.registerTool('cowove_status', {
    description: 'See who else is in the live session, what they are working on, which files they recently edited or claimed, and recent messages. Call this before starting work.',
    inputSchema: {}
  }, () => withDaemon(async (d) => (await call(d, 'GET', '/status')).markdown))

  server.registerTool('cowove_set_focus', {
    description: 'Tell collaborators what you are working on right now (e.g. "adding dark mode to the settings page"). Shown to them live.',
    inputSchema: { focus: z.string().describe('Short description of the current task') }
  }, ({ focus }) => withDaemon(async (d) => {
    await call(d, 'POST', '/focus', { text: focus })
    return `Focus set: ${focus}`
  }))

  server.registerTool('cowove_claim', {
    description: 'Claim files so only you can change them while you work: cowove undoes anyone else\'s edits there. Accepts a file path, a folder (it need not exist yet), or a glob like "src/auth/**". Fails if it overlaps someone else\'s claim.',
    inputSchema: {
      pattern: z.string().describe('File path, folder, or glob'),
      reason: z.string().optional().describe('What you are doing there')
    }
  }, ({ pattern, reason }) => withDaemon(async (d) => {
    await call(d, 'POST', '/claim', { pattern, note: reason || '' })
    return `Claimed ${pattern}. Only you can change it until you release it.`
  }))

  server.registerTool('cowove_release', {
    description: 'Release a claim you made (or "*" for all of yours) once you are done.',
    inputSchema: { pattern: z.string().describe('The claimed pattern, or "*"') }
  }, ({ pattern }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/release', { pattern })
    return `Released ${r.released} claim(s).`
  }))

  server.registerTool('cowove_message', {
    description: 'Send a chat message to collaborators, e.g. to ask a question, hand off work, or warn about a breaking change. Set "to" to message one person directly.',
    inputSchema: {
      text: z.string(),
      to: z.string().optional().describe('Name of one collaborator for a direct message; omit to message everyone')
    }
  }, ({ text, to }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/say', { text, to })
    return to && !r.recipientOnline ? `Sent. (${to} is offline and will see it when they reconnect.)` : 'Sent.'
  }))

  server.registerTool('cowove_read_messages', {
    description: 'Read chat messages from collaborators, including direct messages and shared files (with the local path each file was saved to). By default returns only unread messages.',
    inputSchema: {
      all: z.boolean().optional().describe('Return recent messages, not just unread ones'),
      limit: z.number().int().min(1).max(200).optional()
    }
  }, ({ all, limit }) => withDaemon(async (d) => {
    const { messages } = await call(d, 'POST', '/messages', { unreadOnly: !all, limit: limit || 30 })
    if (!messages.length) return all ? 'No messages yet.' : 'No unread messages.'
    const me = (await call(d, 'GET', '/status')).me.name
    return messages.map((m) => `- ${renderMessage(m, me)}`).join('\n')
  }))

  server.registerTool('cowove_send_file', {
    description: 'Send a file from this project to collaborators through chat, without adding it to the shared project (useful for screenshots, logs, exports, or drafts). The file must be inside the project folder.',
    inputSchema: {
      path: z.string().describe('Path relative to the project root'),
      to: z.string().optional().describe('Send only to this collaborator'),
      message: z.string().optional().describe('Optional note to go with the file')
    }
  }, ({ path: p, to, message }) => withDaemon(async (d) => {
    const abs = insideProject(d.dir, p, { reading: true })
    const r = await call(d, 'POST', '/send', { path: abs, to, text: message || '' })
    return `Sent ${r.file.name}${to ? ` to ${to}` : ''}.`
  }))

  server.registerTool('cowove_get_file', {
    description: 'Download a file someone shared in chat. Received files are normally saved automatically (see cowove_read_messages); use this to fetch one again or save it into the project.',
    inputSchema: {
      id: z.string().describe('The message id shown next to the file'),
      dest: z.string().optional().describe('Destination path or folder inside the project (default: .cowove/inbox/)')
    }
  }, ({ id, dest }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/get', { id, dest: dest ? insideProject(d.dir, dest) : undefined })
    return `Saved to ${path.relative(d.dir, r.path)}`
  }))

  // ------------------------------------------------ joining as an agent --

  const startAs = async ({ conn, folder, name, inviteServer }) => {
    if (joined) throw new Error(`Already in session ${path.basename(joined.dir)} (${joined.dir}). Call cowove_leave_session first.`)
    const cwd = process.env.COWOVE_DIR || process.cwd()
    let dir = folder ? path.resolve(cwd, folder) : null
    if (!dir) {
      // Join into the current folder only if it's empty or already this room's folder.
      const saved = readConfig(cwd)
      const empty = !fs.existsSync(cwd) || fs.readdirSync(cwd).filter((n) => n !== '.cowove' && n !== '.DS_Store').length === 0
      dir = empty || (saved && saved.room === conn.room) ? cwd : path.join(cwd, `cowove-${conn.room}`)
    }
    // A person is already syncing this folder: work through their session.
    if (runningElsewhere(dir)) {
      const saved = readConfig(dir)
      if (saved && saved.room === conn.room) {
        joined = { dir, attached: true }
        return { dir, attached: true }
      }
      throw new Error(`${dir} is already synced by another cowove session. Choose another folder.`)
    }
    const tool = clientTool()
    logs = []
    const run = await runSession({
      dir,
      conn,
      // Names are tied to one person's key, so each person's agent needs its own.
      name: name || `${tool} agent (${os.userInfo().username})`,
      tool,
      kind: 'agent',
      joined: !inviteServer && !conn.viewSecret,
      inviteServer,
      // This agent's own chat lives where it was started, which may be above the synced folder.
      readerOptions: { chatDir: process.cwd() },
      onLog: (line) => { logs.push(line); if (logs.length > 50) logs.shift() },
      onFatal: async (err) => { logs.push(`stopped: ${err.message}`); await leave() }
    })
    joined = { run, dir, invite: run.invite }
    return { dir, invite: run.invite }
  }

  const leave = async () => {
    if (!joined) return false
    const j = joined
    joined = null
    if (j.run) await j.run.stop()
    return true
  }

  const describeSession = async (dir, extra = '') => {
    const d = findDaemon(dir)
    const st = d ? await call(d, 'GET', '/status') : null
    const info = d ? await call(d, 'GET', '/info') : null
    const lines = [extra]
    if (info) lines.push(`Project folder: ${info.dir}`, `You appear as: ${info.name}${info.kind === 'agent' ? ' (AI agent)' : ''}`)
    if (st) lines.push(`Shared files: ${st.fileCount}`, `People online: ${st.peers.map((p) => p.name).join(', ') || 'nobody else yet'}`)
    const acc = info && info.access
    if (acc && acc.state === 'pending') lines.push('⏳ Waiting for the session owner to let you in. Nothing syncs until they approve you; check again with cowove_session_info.')
    else if (acc && acc.controlled) lines.push(`Your access: ${acc.owner ? 'owner' : acc.role === 'viewer' ? 'view only (your file changes are undone)' : acc.scopes && acc.scopes.length ? `may change files only in ${acc.scopes.join(', ')}` : 'may change any file'}`)
    if (info && info.invite) lines.push(`Invite link to edit (for others to join): ${info.invite}`)
    if (info && info.viewInvite) lines.push(`Invite link to view only: ${info.viewInvite}`)
    if (joined && joined.run) lines.push('The session runs inside this MCP server and ends when it stops, or with cowove_leave_session.')
    return lines.filter(Boolean).join('\n')
  }

  server.registerTool('cowove_join_session', {
    description: 'Join a live cowove session from an invite link, as an AI agent. The shared project is synced into a folder (the current folder if it is empty or already this session\'s, otherwise a new "cowove-<room>" subfolder) and kept in sync live. Other people see you in the session.',
    inputSchema: {
      invite: z.string().describe('The invite link, like https://<relay>/join/<room>#<secret> (or the full "cowove join <link>" command)'),
      folder: z.string().optional().describe('Where to put the project, relative to the current folder'),
      name: z.string().optional().describe('Name to show to others (default: "<tool> agent (<your user name>)")')
    }
  }, async ({ invite, folder, name }) => {
    try {
      const conn = decodeInvite(invite)
      const r = await startAs({ conn, folder, name })
      const text = await describeSession(r.dir, r.attached
        ? `This folder is already in the session (someone runs cowove here), so you're working through their session.`
        : `Joined room ${conn.room}. Files are synced into ${r.dir}; edit them there.`)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Could not join: ${err.message}` }], isError: true }
    }
  })

  server.registerTool('cowove_start_session', {
    description: 'Start a new live cowove session for a folder, as an AI agent, and get an invite link for others. Uses the user\'s default relay (set with `cowove relay set`) unless you pass one.',
    inputSchema: {
      relay: z.string().optional().describe('Relay address, e.g. wss://relay.example.com'),
      folder: z.string().optional().describe('Folder to share, relative to the current folder (default: current folder)'),
      name: z.string().optional().describe('Name to show to others')
    }
  }, async ({ relay, folder, name }) => {
    try {
      const d = defaultRelay()
      const server_ = relay ? normalizeRelay(relay) : d && d.relay
      if (!server_) throw new Error('No relay address. Ask the user for one (ws:// or wss://), or have them run `cowove relay set <url>`.')
      const r = await startAs({ conn: newConn(server_, relay ? keyFor(server_) : d.key), folder: folder || '.', name })
      return { content: [{ type: 'text', text: await describeSession(r.dir, `Started a session for ${r.dir}. Share the invite link below with collaborators.`) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Could not start: ${err.message}` }], isError: true }
    }
  })

  server.registerTool('cowove_leave_session', {
    description: 'Leave the session this agent joined or started. Files stay on disk.',
    inputSchema: {}
  }, async () => {
    const left = await leave()
    return { content: [{ type: 'text', text: left ? 'Left the session. The files stay where they are.' : 'You have not joined a session from here.' }] }
  })

  // ------------------------------------------------------ commit timing --

  const describeCommits = (c) => {
    const lines = []
    lines.push(c.ready ? '✅ Everyone else\'s AI is idle: a good moment to commit.' : `⏳ Still working: ${c.busy.map((b) => b.why).join('; ')}`)
    if (c.open.length) lines.push('Open commit requests:', ...c.open.map((r) => `- ${r.by}: ${r.message}`))
    else lines.push('No open commit requests.')
    lines.push(c.host
      ? 'You host git for this session: when it is ready, commit with cowove_commit (or git yourself).'
      : 'Git lives with the session host. Ask for a commit with cowove_request_commit; the host commits when everyone is idle.')
    return lines.join('\n')
  }

  server.registerTool('cowove_set_work', {
    description: 'Tell everyone whether you (this agent) are working or done, so the host knows when it is safe to commit. Set "working" when you start a task and "done" when you finish.',
    inputSchema: {
      state: z.enum(['working', 'done']),
      note: z.string().optional().describe('What you are working on, in a few words')
    }
  }, ({ state, note }) => withDaemon(async (d) => {
    await call(d, 'POST', '/work', { state, note })
    return state === 'working' ? 'Marked as working. Set "done" when you finish so the host can commit.' : 'Marked as done.'
  }))

  server.registerTool('cowove_request_commit', {
    description: 'Ask the session host to commit the shared changes, e.g. because you need a commit to test or deploy. The host commits once every AI in the session is idle.',
    inputSchema: { message: z.string().describe('What the commit should say / why you need it') }
  }, ({ message }) => withDaemon(async (d) => {
    await call(d, 'POST', '/commit-request', { message })
    return `Asked for a commit.\n${describeCommits(await call(d, 'GET', '/commits'))}`
  }))

  server.registerTool('cowove_commit_status', {
    description: 'Is it a good moment to commit? Lists open commit requests and whose AI is still working (not counting yours).',
    inputSchema: {}
  }, () => withDaemon(async (d) => describeCommits(await call(d, 'GET', '/commits'))))

  server.registerTool('cowove_wait_until_idle', {
    description: 'Wait until every other AI in the session is idle (or the timeout passes), then report. Use it before committing, or when you need everyone else to finish first.',
    inputSchema: { timeout_seconds: z.number().int().min(5).max(1800).optional().describe('How long to wait at most (default 300)') }
  }, ({ timeout_seconds: timeout = 300 }) => withDaemon(async (d) => {
    const until = Date.now() + timeout * 1000
    let c = await call(d, 'GET', '/commits')
    while (!c.ready && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000))
      c = await call(d, 'GET', '/commits')
    }
    return `${c.ready ? '' : `Stopped waiting after ${timeout}s.\n`}${describeCommits(c)}`
  }))

  server.registerTool('cowove_commit', {
    description: 'Host only: commit every change in the shared folder with git and close the open commit requests. Without a message, the open requests\' messages are used. Check cowove_commit_status first.',
    inputSchema: { message: z.string().optional().describe('Commit message') }
  }, ({ message }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/commit', { message })
    return `Committed ${r.files} file${r.files === 1 ? '' : 's'} as ${r.hash}: ${r.subject}`
  }))

  server.registerTool('cowove_session_info', {
    description: 'Where the shared project lives on disk, how you appear to others, who is online, and the invite link.',
    inputSchema: {}
  }, () => withDaemon(async (d) => describeSession(d.dir)))

  // ------------------------------------------------- the workspace, for agents --

  server.registerTool('cowove_partner_feed', {
    description: 'Read what a collaborator\'s AI is doing: their prompts, the AI\'s replies, and one-line actions like "Edited src/app.ts". Without "who", lists collaborators and their AI status. Use it to avoid duplicating or conflicting with their work.',
    inputSchema: {
      who: z.string().optional().describe('Collaborator name'),
      limit: z.number().int().min(1).max(300).optional().describe('How many recent entries (default 40)')
    }
  }, ({ who, limit }) => withDaemon(async (d) => {
    const st = await call(d, 'GET', '/status')
    if (!who) {
      if (!st.peers.length) return 'Nobody else is in the session right now.'
      return st.peers.map((p) => {
        const a = p.agent || {}
        const ai = a.sharing === false ? 'sharing paused' : a.status === 'unavailable' ? 'feed unavailable' : a.tool ? `${a.tool} ${a.status}` : 'no AI activity yet'
        return `- ${p.name}${p.kind === 'agent' ? ' (AI agent)' : ''}: ${ai}${p.focus ? `; focus: ${p.focus}` : ''}`
      }).join('\n') + '\n\nCall again with "who" to read one feed.'
    }
    const { entries } = await call(d, 'POST', '/feed', { who, limit: limit || 40 })
    if (!entries.length) return `No AI activity from ${who} yet.`
    const cut = (t) => (t.length > 1500 ? t.slice(0, 1500) + '…' : t)
    let conv = null
    const out = []
    for (const e of entries) {
      if (e.conv && conv && e.conv !== conv) out.push('--- new conversation ---')
      if (e.conv) conv = e.conv
      if (e.kind === 'prompt') out.push(`${who} asked: ${cut(e.text)}`)
      else if (e.kind === 'reply') out.push(`${e.tool || 'AI'} replied: ${cut(e.text)}`)
      else if (e.kind === 'action') out.push(`  · ${e.text}`)
      else out.push(`(${who} ${e.kind} sharing)`)
    }
    const p = st.peers.find((x) => x.name === who)
    if (p && p.agent && p.agent.status === 'working' && p.agent.sharing !== false) out.push(`(${who}'s AI is working right now)`)
    return out.join('\n')
  }))

  server.registerTool('cowove_list_files', {
    description: 'List the shared project\'s files with who edited each one recently and any claims, so you can see where others are working.',
    inputSchema: { prefix: z.string().optional().describe('Only paths under this folder, e.g. "src/auth"') }
  }, ({ prefix }) => withDaemon(async (d) => {
    const { files, claims } = await call(d, 'GET', '/tree')
    const me = (await call(d, 'GET', '/info')).name
    const pre = prefix ? prefix.replace(/^\.\//, '').replace(/\/+$/, '') : ''
    const shown = files.filter((f) => !pre || f.path === pre || f.path.startsWith(pre + '/'))
    const now = Date.now()
    const lines = shown.slice(0, 400).map((f) => {
      const notes = []
      if (f.edited && now - f.edited.ts < 10 * 60 * 1000) notes.push(`edited by ${f.edited.by === me ? 'you' : f.edited.by} ${Math.round((now - f.edited.ts) / 1000)}s ago`)
      if (f.claim) notes.push(`claimed by ${f.claim.by === me ? 'you' : f.claim.by}${f.claim.note ? `: ${f.claim.note}` : ''}`)
      if (f.binary) notes.push('binary')
      return `${f.path}${notes.length ? `  [${notes.join('; ')}]` : ''}`
    })
    if (shown.length > 400) lines.push(`… and ${shown.length - 400} more (use prefix to narrow)`)
    const claimLines = claims.length ? '\n\nClaims: ' + claims.map((c) => `${c.pattern} (${c.by === me ? 'you' : c.by}${c.note ? `: ${c.note}` : ''})`).join(', ') : ''
    return (lines.join('\n') || 'No shared files.') + claimLines
  }))

  server.server.onclose = () => { leave().catch(() => {}) }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { leave().finally(() => process.exit(0)) })

  server.server.oninitialized = () => {
    const client = server.server.getClientVersion()
    const d = findDaemon()
    if (d && client && client.name) call(d, 'POST', '/agent', { client: client.name }).catch(() => {})
  }

  await server.connect(new StdioServerTransport())
}

// Agents may only send or save files inside the project folder, and may not
// send secrets, so a prompt-injected agent can't leak ~/.ssh or .env.
function insideProject (root, p, { reading = false } = {}) {
  const abs = path.resolve(root, p)
  const check = (base, target) => {
    const rel = path.relative(base, target)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path must be inside the project folder')
  }
  check(root, abs)
  if (reading) {
    check(fs.realpathSync(root), fs.realpathSync(abs)) // no symlinks pointing outside
    const base = path.basename(abs)
    if (/^\.env(\..*)?$/.test(base) && base !== '.env.example') throw new Error('refusing to send environment/secret files')
  }
  return abs
}
