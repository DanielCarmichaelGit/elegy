// MCP server (stdio) that lets any MCP-capable agent (Claude Code, Cursor,
// Windsurf, Codex, ...) see what the other collaborators are doing and
// coordinate with them. It forwards to the local `elegy join` process.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { findDaemon, call } from './control.js'
import { renderMessage } from './status.js'

const NOT_RUNNING = 'Elegy is not running for this project, so there is no live pair session. ' +
  'Ask the user to start it with `elegy join` in the project folder.'

export async function runMcp () {
  const server = new McpServer(
    { name: 'elegy', version: '0.1.0' },
    {
      instructions: 'This project is being edited live by several people at once, each with their own AI coding tool. ' +
        'Files may change underneath you at any time. Call elegy_status before starting a task and before editing files ' +
        'another person recently touched; announce what you are doing with elegy_set_focus; claim files before larger ' +
        'changes and do not edit files someone else has claimed. Always re-read a file right before you edit it.'
    }
  )

  const withDaemon = async (fn) => {
    const d = findDaemon()
    if (!d) return { content: [{ type: 'text', text: NOT_RUNNING }], isError: true }
    try {
      return { content: [{ type: 'text', text: await fn(d) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
    }
  }

  server.registerTool('elegy_status', {
    description: 'See who else is in the live session, what they are working on, which files they recently edited or claimed, and recent messages. Call this before starting work.',
    inputSchema: {}
  }, () => withDaemon(async (d) => (await call(d, 'GET', '/status')).markdown))

  server.registerTool('elegy_set_focus', {
    description: 'Tell collaborators what you are working on right now (e.g. "adding dark mode to the settings page"). Shown to them live.',
    inputSchema: { focus: z.string().describe('Short description of the current task') }
  }, ({ focus }) => withDaemon(async (d) => {
    await call(d, 'POST', '/focus', { text: focus })
    return `Focus set: ${focus}`
  }))

  server.registerTool('elegy_claim', {
    description: 'Claim files so collaborators (and their agents) know to stay out of them while you work. Accepts a file path, a folder, or a glob like "src/auth/**".',
    inputSchema: {
      pattern: z.string().describe('File path, folder, or glob'),
      reason: z.string().optional().describe('What you are doing there')
    }
  }, ({ pattern, reason }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/claim', { pattern, note: reason || '' })
    const warn = r.overlapping && r.overlapping.length
      ? `\nWarning: overlaps with claims by ${r.overlapping.map((c) => `${c.by} (${c.pattern})`).join(', ')}. Coordinate before editing.`
      : ''
    return `Claimed ${pattern}.${warn}`
  }))

  server.registerTool('elegy_release', {
    description: 'Release a claim you made (or "*" for all of yours) once you are done.',
    inputSchema: { pattern: z.string().describe('The claimed pattern, or "*"') }
  }, ({ pattern }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/release', { pattern })
    return `Released ${r.released} claim(s).`
  }))

  server.registerTool('elegy_message', {
    description: 'Send a chat message to collaborators, e.g. to ask a question, hand off work, or warn about a breaking change. Set "to" to message one person directly.',
    inputSchema: {
      text: z.string(),
      to: z.string().optional().describe('Name of one collaborator for a direct message; omit to message everyone')
    }
  }, ({ text, to }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/say', { text, to })
    return to && !r.recipientOnline ? `Sent. (${to} is offline and will see it when they reconnect.)` : 'Sent.'
  }))

  server.registerTool('elegy_read_messages', {
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

  server.registerTool('elegy_send_file', {
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

  server.registerTool('elegy_get_file', {
    description: 'Download a file someone shared in chat. Received files are normally saved automatically (see elegy_read_messages); use this to fetch one again or save it into the project.',
    inputSchema: {
      id: z.string().describe('The message id shown next to the file'),
      dest: z.string().optional().describe('Destination path or folder inside the project (default: .elegy/inbox/)')
    }
  }, ({ id, dest }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/get', { id, dest: dest ? insideProject(d.dir, dest) : undefined })
    return `Saved to ${path.relative(d.dir, r.path)}`
  }))

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
