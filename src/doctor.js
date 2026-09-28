// `elegy doctor`: explains what elegy can see of this machine's AI chats, so a
// missing feed can be diagnosed from one pasted report. It prints counts,
// lengths and names only, never chat text, so the report is safe to share.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cursorUserDir, findWorkspaces } from './agents/cursor.js'
import { claudeProjectsDir, slugFor } from './agents/claude-code.js'
import { startAgentReaders } from './agents/index.js'

export async function doctor ({ dir = process.cwd(), watchSeconds = 0, print = console.log, cursorDir } = {}) {
  dir = path.resolve(dir)
  const say = (s = '') => print(s)
  say(`elegy doctor for ${dir}`)
  say(`node ${process.version} on ${process.platform}${cloudHint()}`)
  say()
  claude(dir, say)
  say()
  await cursor(dir, say, cursorDir)
  if (watchSeconds > 0) {
    say()
    await watch(dir, watchSeconds, say)
  }
}

function cloudHint () {
  const env = process.env
  if (env.CLAUDE_CODE_REMOTE) return ' · looks like a Claude Code cloud session'
  if (env.CURSOR_AGENT || env.CURSOR_BACKGROUND_AGENT) return ' · looks like a Cursor cloud agent'
  if (env.CODESPACES) return ' · GitHub Codespaces'
  return ''
}

function claude (dir, say) {
  say('## Claude Code')
  const root = claudeProjectsDir()
  if (!fs.existsSync(root)) return say(`- no ${root} (Claude Code hasn't run as this user on this machine)`)
  const slug = slugFor(dir)
  const dirs = fs.readdirSync(root).filter((n) => n.startsWith(slug))
  if (!dirs.length) return say(`- no transcripts for this folder (looked for ${path.join(root, slug)}*)`)
  for (const d of dirs) {
    const files = fs.readdirSync(path.join(root, d)).filter((n) => n.endsWith('.jsonl'))
    const newest = files.map((n) => fs.statSync(path.join(root, d, n)).mtimeMs).sort((a, b) => b - a)[0]
    say(`- ${d}: ${files.length} conversation(s)${newest ? `, last written ${ago(newest)}` : ''}`)
  }
}

async function cursor (dir, say, userDir = cursorUserDir()) {
  say('## Cursor')
  let DatabaseSync
  const emit = process.emitWarning
  process.emitWarning = () => {}
  try { ({ DatabaseSync } = await import('node:sqlite')) } catch {
    return say('- ✗ node:sqlite is missing: reading Cursor chats needs Node.js 22.13 or newer. This alone explains a missing Cursor feed.')
  } finally { process.emitWarning = emit }

  if (!fs.existsSync(userDir)) return say(`- no Cursor data at ${userDir} (Cursor isn't installed for this user, or runs elsewhere)`)
  say(`- Cursor data: ${userDir}`)
  const global = path.join(userDir, 'globalStorage', 'state.vscdb')
  if (!fs.existsSync(global)) return say(`- ✗ missing ${global}`)
  const found = findWorkspaces(userDir, dir)
  if (!found.length) {
    say('- ✗ Cursor has never opened this exact folder. Folders Cursor has opened recently:')
    for (const f of recentWorkspaceFolders(userDir).slice(0, 12)) say(`    ${f}`)
    say('  If the project is in that list under another path (a parent folder, a symlink, a different drive letter or case), open this exact folder in Cursor, or run elegy there.')
    return
  }
  say(`- workspace folder(s) for this project: ${found.map((f) => path.basename(f)).join(', ')}`)

  const open = (f) => new DatabaseSync(f, { readOnly: true })
  const get = (db, table, key) => {
    try {
      const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key)
      if (!row || row.value == null) return null
      return JSON.parse(typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8'))
    } catch (err) { return { __error: err.message } }
  }
  const ids = new Map() // composerId -> lastUpdatedAt
  const note = (c, from) => { if (c && c.composerId) ids.set(c.composerId, Math.max(ids.get(c.composerId) || 0, c.lastUpdatedAt || c.createdAt || 0)) ; return from }
  for (const ws of found) {
    const db = open(path.join(ws, 'state.vscdb'))
    const list = get(db, 'ItemTable', 'composer.composerData')
    db.close()
    if (list && list.__error) say(`- ✗ ${path.basename(ws)}: can't read composer list (${list.__error})`)
    else say(`- ${path.basename(ws)}: ${list && Array.isArray(list.allComposers) ? list.allComposers.length : 0} conversation(s) in the workspace list${list && list.hasMigratedComposerData ? ' (marked as migrated)' : ''}`)
    for (const c of (list && list.allComposers) || []) note(c)
  }
  const g = open(global)
  const headers = get(g, 'ItemTable', 'composer.composerHeaders')
  if (headers && Array.isArray(headers.allComposers)) {
    const wsIds = new Set(found.map((f) => path.basename(f)))
    const mine = headers.allComposers.filter((c) => c && c.workspaceIdentifier && wsIds.has(c.workspaceIdentifier.id))
    say(`- global conversation list: ${headers.allComposers.length} total, ${mine.length} tagged with this workspace`)
    for (const c of mine) note(c)
  } else say('- global conversation list: not present (older Cursor)')

  const recent = [...ids].sort((a, b) => b[1] - a[1]).slice(0, 3)
  if (!recent.length) say('- ✗ no conversations found for this folder yet. Send one message in Cursor\'s chat, then run this again.')
  for (const [id, ts] of recent) {
    const data = get(g, 'cursorDiskKV', `composerData:${id}`)
    if (!data) { say(`- conversation ${id.slice(0, 8)} (${ago(ts)}): ✗ no composerData row`); continue }
    if (data.__error) { say(`- conversation ${id.slice(0, 8)}: ✗ unreadable (${data.__error})`); continue }
    const hs = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : Array.isArray(data.conversation) ? data.conversation : null
    if (!hs) { say(`- conversation ${id.slice(0, 8)}: ✗ unknown layout (_v ${data._v}, keys: ${Object.keys(data).slice(0, 12).join(', ')})`); continue }
    say(`- conversation ${id.slice(0, 8)} (${ago(ts)}, layout _v ${data._v ?? '?'}): ${hs.length} message(s)`)
    for (const h of hs.slice(-4)) {
      const b = h.text !== undefined ? h : get(g, 'cursorDiskKV', `bubbleId:${id}:${h.bubbleId}`)
      if (!b) { say(`    · ${h.bubbleId?.slice(0, 8)}: ✗ bubble row missing`); continue }
      const kind = b.type === 1 ? 'you' : b.type === 2 ? 'AI' : `type ${b.type}`
      const extra = [b.toolFormerData?.name && `tool ${b.toolFormerData.name}`, b.thinking && 'thinking', !b.text && b.richText && 'richText only'].filter(Boolean).join(', ')
      say(`    · ${kind}: ${(b.text || '').length} chars${extra ? ` (${extra})` : ''}`)
    }
  }
  g.close()
}

function recentWorkspaceFolders (userDir) {
  const root = path.join(userDir, 'workspaceStorage')
  const out = []
  let names = []
  try { names = fs.readdirSync(root) } catch { return out }
  for (const n of names) {
    try {
      const ws = JSON.parse(fs.readFileSync(path.join(root, n, 'workspace.json'), 'utf8'))
      const f = ws.folder || ws.workspace || ''
      let shown = f
      try { if (String(f).startsWith('file:')) shown = fileURLToPath(f) } catch {}
      out.push({ shown, t: fs.statSync(path.join(root, n)).mtimeMs })
    } catch {}
  }
  return out.sort((a, b) => b.t - a.t).map((x) => x.shown)
}

async function watch (dir, seconds, say) {
  say(`## Live check (${seconds}s): send a message in Cursor or Claude Code now`)
  let n = 0
  const r = startAgentReaders({
    dir,
    onEntries: (es) => { for (const e of es) { n++; say(`- ${e.tool}: ${e.kind}, ${e.text.length} chars`) } },
    onState: (s) => say(`- state: ${s.tool || 'no tool yet'} ${s.status}${s.reason ? ` (${s.reason})` : ''}${s.notes ? ` · ${s.notes.join('; ')}` : ''}`),
    onLog: (l) => say(`- log: ${l}`)
  })
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  r.stop()
  say(n ? `- ✓ ${n} entr${n === 1 ? 'y' : 'ies'} would have been shared` : '- ✗ nothing would have been shared in that time')
}

function ago (ts) {
  if (!ts) return 'unknown time'
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 172800) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

