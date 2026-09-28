// MCP server hosted by the relay, for people who use cowove from the website.
// Their AI (Cursor, Claude Code, ...) connects to https://<relay>/mcp/<token>
// with nothing installed. The token belongs to one browser; the website tells
// the relay which session and name it's in right now (see server.js), so the
// same link keeps working for every session that person joins.
//
// The tools work directly on the room's shared document: the AI shares what
// it's doing into the feed, reads partners' feeds, messages and claims files.
// Files themselves sync through the person's browser tab, not through here.
import crypto from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { capText, toolLabel } from './agents/common.js'
import { globMatcher, isSafeRelPath } from './pathrules.js'

const FEED_CAP = 300
const TAB_STALE_MS = 3 * 60 * 1000
const AGENT = 'agent-mcp' // transaction origin

const INSTRUCTIONS =
  'You are in a live cowove session: other people, each with their own AI, are editing this same project right now, ' +
  'and their changes appear in your files as they happen. ' +
  'When your user asks for something, call cowove_share with their request and a short plan before you start, and call it ' +
  'again with a short summary when you finish, so collaborators can follow along. ' +
  'Before starting a task, call cowove_status to see who is working on what. Do not edit files someone else has claimed; ' +
  'message them with cowove_message instead. Claim files before larger changes. Always re-read a file right before editing it.'

const NOT_LINKED = 'Your user is not in a cowove session in their browser right now. Ask them to open cowove in their ' +
  'browser and share a folder or join one from an invite link, then try again. (This link is theirs and works for every session.)'

const id = () => crypto.randomBytes(8).toString('hex')
const text = (t) => ({ content: [{ type: 'text', text: t }] })
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true })

function ago (ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

/**
 * Handles one MCP request (stateless: a fresh server per request).
 * @param {object} o
 * @param {object} o.room   the relay Room (doc, awareness, full)
 * @param {object} o.link   { name, tool, tabSeenAt }
 * @param {string} [o.toolHint] tool name from the URL (?tool=Cursor)
 */
export async function handleAgentMcp ({ req, res, room, link, toolHint }) {
  const mcp = new McpServer({ name: 'cowove', version: '0.1.0' }, { instructions: INSTRUCTIONS })
  // Until the person is in a session in their browser, every tool says how to get there.
  const server = {
    server: mcp.server,
    registerTool: (name, def, fn) => mcp.registerTool(name, def, (args) => (room && link) ? fn(args || {}) : fail(NOT_LINKED))
  }
  const doc = room ? room.doc : null
  const feed = doc?.getArray('agentFeed')
  const chat = doc?.getArray('chat')
  const claims = doc?.getMap('claims')
  const activity = doc?.getArray('activity')
  const files = doc?.getMap('files')
  const blobs = doc?.getMap('blobs')
  const me = link ? link.name : ''
  const tool = () => toolHint || toolLabel(server.server.getClientVersion()?.name)

  const tabWarning = () => Date.now() - (link.tabSeenAt || 0) > TAB_STALE_MS
    ? `\n\n⚠️ ${me}'s cowove browser tab doesn't seem to be open, so file changes aren't syncing. Ask your user to reopen cowove in their browser.`
    : ''
  const writable = () => room.full ? 'This session is over its size limit, so nothing new can be saved.' : null

  const peers = () => {
    const out = []
    for (const s of room.awareness.getStates().values()) if (s && s.name && s.name !== me) out.push(s)
    return out
  }

  const visible = (m) => m && m.id && (!m.to || m.to === me || m.by === me)
  const fmtMsg = (m) => `- ${m.by}${m.to ? ` → ${m.to} (direct)` : ''} (${ago(m.ts)}): ${m.text}${m.file ? ` [file: ${m.file.name}]` : ''}`

  server.registerTool('cowove_status', {
    description: 'See who else is in the live session, what they and their AIs are doing, recent file changes, claimed files and recent messages. Call this before starting a task.',
    inputSchema: {}
  }, () => {
    const lines = [`You are working for ${me} in a live cowove session.`, '', '## People online']
    const ps = peers()
    if (!ps.length) lines.push('- Nobody else right now.')
    for (const p of ps) {
      const a = p.agent || {}
      const ai = a.sharing === false ? 'AI sharing paused' : a.status === 'working' ? `${a.tool || 'AI'} working` : a.tool ? `${a.tool} idle` : ''
      const editing = Object.keys(p.editing || {}).slice(0, 5)
      lines.push(`- ${p.name} (${p.tool || 'unknown tool'}${p.kind === 'agent' ? ', agent' : ''})${ai ? ` · ${ai}` : ''}${p.focus ? ` · focus: ${p.focus}` : ''}${editing.length ? ` · editing ${editing.join(', ')}` : ''}`)
    }
    const cl = [...claims.values()]
    lines.push('', '## Claimed files', ...(cl.length ? cl.map((c) => `- ${c.pattern} by ${c.by}${c.note ? ` (${c.note})` : ''}`) : ['- None.']))
    const acts = activity.toArray().filter(Boolean).slice(-12).reverse()
    lines.push('', '## Recent file changes', ...(acts.length ? acts.map((a) => `- ${a.by} ${a.kind} ${a.path} (${ago(a.ts)})`) : ['- None yet.']))
    const msgs = chat.toArray().filter(visible).slice(-8)
    lines.push('', '## Recent messages', ...(msgs.length ? msgs.map(fmtMsg) : ['- None.']))
    return text(lines.join('\n') + tabWarning())
  })

  server.registerTool('cowove_share', {
    description: 'Share what you are doing with your collaborators; it appears live in their cowove feed. Call it when you start on a request ' +
      '(`request`: what your user asked, in a sentence; `summary`: your plan) and again when you finish (`summary`: what you did; ' +
      '`files`: files you changed). Keep it short and never include secrets, keys or file contents.',
    inputSchema: {
      request: z.string().max(2000).optional().describe('What your user asked for, in a sentence (only when starting a new request)'),
      summary: z.string().max(4000).describe('Your plan, progress or result, in one to three sentences'),
      files: z.array(z.string().max(300)).max(30).optional().describe('Project files you changed, relative paths')
    }
  }, ({ request, summary, files: changed }) => {
    const err = writable()
    if (err) return fail(err)
    const t = tool()
    const now = Date.now()
    const entries = []
    const base = { by: me, tool: t, conv: `mcp-${t}` }
    if (request && request.trim()) entries.push({ ...base, id: id(), kind: 'prompt', text: capText(request.trim()), ts: now })
    if (summary && summary.trim()) entries.push({ ...base, id: id(), kind: 'reply', text: capText(summary.trim()), ts: now })
    for (const f of changed || []) {
      const p = String(f).replace(/^\.\//, '')
      if (isSafeRelPath(p)) entries.push({ ...base, id: id(), kind: 'action', text: `Edited ${p}`, ts: now })
    }
    if (!entries.length) return fail('Nothing to share: give a summary.')
    doc.transact(() => {
      feed.push(entries)
      // Keep the newest FEED_CAP entries per person, like the CLI does.
      const mine = []
      feed.forEach((e, i) => { if (e && e.by === me) mine.push(i) })
      for (let k = mine.length - FEED_CAP - 1; k >= 0; k--) feed.delete(mine[k], 1)
    }, AGENT)
    return text(`Shared with the session.${tabWarning()}`)
  })

  server.registerTool('cowove_partner_feed', {
    description: 'Read what a collaborator\'s AI has been doing: their prompts, the AI\'s replies and actions. Without `who`, lists whose feeds exist.',
    inputSchema: {
      who: z.string().optional().describe('Collaborator name'),
      limit: z.number().int().min(1).max(200).optional()
    }
  }, ({ who, limit }) => {
    const all = feed.toArray().filter((e) => e && e.by !== me)
    if (!who) {
      const names = [...new Set(all.map((e) => e.by))]
      return text(names.length ? `Feeds: ${names.join(', ')}. Call again with "who".` : 'No one has shared AI activity yet.')
    }
    const mine = all.filter((e) => e.by === who).slice(-(limit || 40))
    if (!mine.length) return text(`No AI activity from ${who} yet.`)
    return text(mine.map((e) => {
      if (e.kind === 'prompt') return `[${ago(e.ts)}] ${who} asked: ${e.text}`
      if (e.kind === 'reply') return `[${ago(e.ts)}] ${e.tool || 'AI'}: ${e.text}`
      if (e.kind === 'action') return `[${ago(e.ts)}] · ${e.text}`
      return `[${ago(e.ts)}] (${e.kind})`
    }).join('\n'))
  })

  server.registerTool('cowove_message', {
    description: 'Send a chat message to everyone in the session, or to one person with `to`. It is sent as your user.',
    inputSchema: {
      text: z.string().min(1).max(4000),
      to: z.string().optional().describe('Name of one person, for a direct message')
    }
  }, ({ text: t, to }) => {
    const err = writable()
    if (err) return fail(err)
    const msg = { id: id(), by: me, to: to || null, text: t, ts: Date.now() }
    doc.transact(() => {
      chat.push([msg])
      if (chat.length > 500) chat.delete(0, chat.length - 500)
    }, AGENT)
    return text(to ? `Sent to ${to}.` : 'Sent to everyone.')
  })

  server.registerTool('cowove_read_messages', {
    description: 'Read recent chat messages in the session (including direct messages to your user).',
    inputSchema: { limit: z.number().int().min(1).max(100).optional() }
  }, ({ limit }) => {
    const msgs = chat.toArray().filter(visible).slice(-(limit || 20))
    return text(msgs.length ? msgs.map(fmtMsg).join('\n') : 'No messages yet.')
  })

  server.registerTool('cowove_list_files', {
    description: 'List the shared project files with who is working on them (claims).',
    inputSchema: { under: z.string().optional().describe('Only files under this folder') }
  }, ({ under }) => {
    const pre = under ? under.replace(/^\.\//, '').replace(/\/+$/, '') + '/' : ''
    const cl = [...claims.values()].map((c) => ({ ...c, m: globMatcher(c.pattern) }))
    const paths = [...new Set([...files.keys(), ...blobs.keys()])].filter((p) => isSafeRelPath(p) && (!pre || p.startsWith(pre))).sort()
    const shown = paths.slice(0, 500).map((p) => {
      const c = cl.find((x) => x.m(p))
      return `- ${p}${c ? ` (claimed by ${c.by})` : ''}`
    })
    return text(paths.length ? shown.join('\n') + (paths.length > 500 ? `\n… and ${paths.length - 500} more` : '') : 'No files.')
  })

  server.registerTool('cowove_claim', {
    description: 'Claim files or folders (a path or glob like src/auth/**) before a larger change, so others know not to edit them.',
    inputSchema: {
      pattern: z.string().min(1).max(300),
      note: z.string().max(500).optional().describe('What you are doing')
    }
  }, ({ pattern, note }) => {
    const err = writable()
    if (err) return fail(err)
    pattern = pattern.trim()
    const existing = claims.get(pattern)
    if (existing && existing.by !== me) return fail(`${pattern} is already claimed by ${existing.by}.`)
    doc.transact(() => claims.set(pattern, { by: me, pattern, note: note || '', ts: Date.now() }), AGENT)
    return text(`Claimed ${pattern}. Release it with cowove_release when done.`)
  })

  server.registerTool('cowove_release', {
    description: 'Release a claim (or all of your user\'s claims when no pattern is given).',
    inputSchema: { pattern: z.string().optional() }
  }, ({ pattern }) => {
    const mine = [...claims.values()].filter((c) => c.by === me && (!pattern || c.pattern === pattern.trim()))
    doc.transact(() => { for (const c of mine) claims.delete(c.pattern) }, AGENT)
    return text(mine.length ? `Released ${mine.map((c) => c.pattern).join(', ')}.` : 'Nothing to release.')
  })

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}) })
  await mcp.connect(transport)
  await transport.handleRequest(req, res)
}
