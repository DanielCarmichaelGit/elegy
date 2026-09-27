// MCP server (stdio) that lets any MCP-capable agent (Claude Code, Cursor,
// Windsurf, Codex, ...) see what the other collaborators are doing and
// coordinate with them. It forwards to the local `elegy join` process.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { findDaemon, call } from './control.js'

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
    description: 'Send a short chat message to collaborators, e.g. to ask a question, hand off work, or warn about a breaking change.',
    inputSchema: { text: z.string() }
  }, ({ text }) => withDaemon(async (d) => {
    await call(d, 'POST', '/say', { text })
    return 'Sent.'
  }))

  server.server.oninitialized = () => {
    const client = server.server.getClientVersion()
    const d = findDaemon()
    if (d && client && client.name) call(d, 'POST', '/agent', { client: client.name }).catch(() => {})
  }

  await server.connect(new StdioServerTransport())
}
