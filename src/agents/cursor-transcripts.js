// Reads Cursor agent transcripts for one project folder. Current Cursor stores
// the agent chat as JSONL under ~/.cursor/projects/<slug>/agent-transcripts/,
// not in the composer database the older reader polls.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeAction } from './actions.js'
import { capText } from './common.js'

const POLL_MS = 750
const IDLE_AFTER_MS = 2 * 60 * 1000
const BACKFILL_MS = 60 * 60 * 1000
const BACKFILL_ENTRIES = 50

export function cursorProjectsDir (home = os.homedir()) {
  return path.join(home, '.cursor', 'projects')
}

/** Cursor's project folder drops the drive colon (`C:\Users\a` -> `c-Users-a`). */
export function cursorProjectSlug (dir) {
  let resolved = path.resolve(dir)
  if (process.platform === 'win32') resolved = resolved.replace(/^([A-Za-z]):/, (_, drive) => drive.toLowerCase())
  return resolved.replace(/[\\/]/g, '-')
}

export function projectMatches (name, dir) {
  const slug = cursorProjectSlug(dir)
  return process.platform === 'win32' ? name.toLowerCase() === slug.toLowerCase() : name === slug
}

/** Cursor wraps the typed message in timestamp and user_query tags. Share only the message. */
export function cursorPromptText (text) {
  const raw = String(text || '')
  const queries = [...raw.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi)].map((m) => m[1].trim()).filter(Boolean)
  if (queries.length) return queries.join('\n\n')
  return raw.replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, '').trim()
}

export function startCursorTranscriptReader ({ dir, onEntries, onState, onLog = () => {}, projectsDir, pollMs = POLL_MS, now = Date.now }) {
  dir = path.resolve(dir)
  const root = projectsDir || cursorProjectsDir()
  const files = new Map() // path -> { offset, partial, lineNo }
  let status = null
  let lastLineAt = 0
  let stopped = false
  let failed = false
  let first = true

  const setStatus = (s) => {
    if (s === status) return
    status = s
    onState({ tool: 'Cursor', status: s })
  }
  setStatus('idle')

  function parseLine (line, conv, lineNo) {
    let j
    try { j = JSON.parse(line) } catch { return null }
    const ts = now() + lineNo
    const content = j.message && Array.isArray(j.message.content) ? j.message.content : []
    const out = []
    if (j.role === 'user') {
      const text = cursorPromptText(content.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n\n'))
      if (text.trim()) out.push({ id: `${conv}:${lineNo}`, tool: 'Cursor', conv, kind: 'prompt', text: capText(text.trim()), ts })
    } else if (j.role === 'assistant') {
      content.forEach((b, i) => {
        if (!b || b.type === 'thinking') return
        const id = `${conv}:${lineNo}:${i}`
        if (b.type === 'text' && b.text && b.text.trim()) out.push({ id, tool: 'Cursor', conv, kind: 'reply', text: capText(b.text.trim()), ts })
        else if (b.type === 'tool_use' && b.name) out.push({ id, tool: 'Cursor', conv, kind: 'action', text: describeAction(b.name, b.input, dir), ts })
      })
    }
    return { entries: out, endTurn: j.type === 'turn_ended', relevant: j.role === 'user' || j.role === 'assistant' || j.type === 'turn_ended' }
  }

  function readFile (file, backfill) {
    let st = files.get(file)
    const size = fs.statSync(file).size
    if (!st) {
      st = { offset: 0, partial: '', lineNo: 0 }
      files.set(file, st)
      if (!backfill) { st.offset = size; return [] }
    }
    if (size < st.offset) { st.offset = 0; st.partial = ''; st.lineNo = 0 }
    if (size === st.offset) return []
    const fd = fs.openSync(file, 'r')
    let chunk
    try {
      const buf = Buffer.alloc(size - st.offset)
      fs.readSync(fd, buf, 0, buf.length, st.offset)
      chunk = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
    st.offset = size
    const text = st.partial + chunk
    const lines = text.split('\n')
    st.partial = lines.pop()
    const conv = path.basename(file, '.jsonl')
    const entries = []
    for (const line of lines) {
      if (!line.trim()) continue
      st.lineNo++
      const r = parseLine(line, conv, st.lineNo)
      if (!r) continue
      entries.push(...r.entries)
      if (r.relevant) {
        lastLineAt = now()
        setStatus(r.endTurn ? 'idle' : 'working')
      }
    }
    return backfill ? entries.slice(-BACKFILL_ENTRIES) : entries
  }

  function transcripts (projectDir) {
    const base = path.join(projectDir, 'agent-transcripts')
    const out = []
    const walk = (d, depth) => {
      if (depth > 3) return
      let entries = []
      try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p, depth + 1)
        else if (e.name.endsWith('.jsonl')) out.push(p)
      }
    }
    walk(base, 0)
    return out
  }

  function tick () {
    if (stopped) return
    try {
      let dirs = []
      try {
        dirs = fs.readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory() && projectMatches(d.name, dir))
          .map((d) => path.join(root, d.name))
      } catch {}
      const out = []
      for (const d of dirs) {
        for (const file of transcripts(d)) {
          const known = files.has(file)
          let backfill = false
          if (!known) backfill = !first || now() - fs.statSync(file).mtimeMs < BACKFILL_MS
          try { out.push(...readFile(file, backfill)) } catch (err) {
            if (!failed) { failed = true; onLog(`Cursor feed: could not read ${path.basename(file)}: ${err.message}`) }
          }
        }
      }
      first = false
      if (status === 'working' && now() - lastLineAt > IDLE_AFTER_MS) setStatus('idle')
      if (out.length) onEntries(out)
    } catch (err) {
      if (!failed) { failed = true; onLog(`Cursor feed error: ${err.message}`) }
    }
  }

  tick()
  const timer = setInterval(tick, pollMs)
  return { stop () { stopped = true; clearInterval(timer) } }
}
