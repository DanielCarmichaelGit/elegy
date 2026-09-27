// Reads Claude Code conversation transcripts for one project folder and turns
// them into feed entries. Transcripts are JSONL files under
// ~/.claude/projects/<slug>/<sessionId>.jsonl, appended to as the chat goes on.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeAction } from './actions.js'
import { capText } from './common.js'

const POLL_MS = 750
const IDLE_AFTER_MS = 2 * 60 * 1000
const BACKFILL_MS = 60 * 60 * 1000
const BACKFILL_ENTRIES = 50

export const slugFor = (dir) => path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-')

export function claudeProjectsDir (home = os.homedir()) {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  return path.join(base, 'projects')
}

/**
 * @param {object} o
 * @param {string} o.dir            synced folder
 * @param {(entries: object[]) => void} o.onEntries
 * @param {(state: object) => void} o.onState
 * @param {(line: string) => void} [o.onLog]
 * @param {string} [o.home]
 */
export function startClaudeCodeReader ({ dir, onEntries, onState, onLog = () => {}, home, pollMs = POLL_MS, now = Date.now }) {
  dir = path.resolve(dir)
  const root = claudeProjectsDir(home)
  const slug = slugFor(dir)
  const files = new Map() // path -> { offset, partial, seen: Set<path> }
  let status = null
  let lastLineAt = 0
  let stopped = false
  let failed = false
  let first = true

  const setStatus = (s) => {
    if (s === status) return
    status = s
    onState({ tool: 'Claude Code', status: s })
  }
  setStatus('idle')

  const inside = (cwd) => typeof cwd === 'string' && (cwd === dir || cwd.startsWith(dir + path.sep))

  function parseLine (line, file, st) {
    let j
    try { j = JSON.parse(line) } catch { return null }
    if (!j || j.isSidechain || !inside(j.cwd)) return null
    const ts = Date.parse(j.timestamp) || now()
    const conv = j.sessionId || path.basename(file, '.jsonl')
    const out = []
    const msg = j.message || {}

    if (j.type === 'user' && !j.isMeta) {
      const text = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content) ? msg.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n\n') : ''
      if (text.trim() && !isSystemText(text)) {
        out.push({ id: j.uuid, tool: 'Claude Code', conv, kind: 'prompt', text: capText(text.trim()), ts })
      }
    } else if (j.type === 'assistant' && Array.isArray(msg.content)) {
      msg.content.forEach((b, i) => {
        if (!b) return
        const id = `${j.uuid}:${i}`
        if (b.type === 'text' && b.text && b.text.trim()) {
          out.push({ id, tool: 'Claude Code', conv, kind: 'reply', text: capText(b.text.trim()), ts })
        } else if (b.type === 'tool_use') {
          const target = b.input && (b.input.file_path || b.input.notebook_path)
          const abs = target ? path.resolve(dir, target) : null
          const text = describeAction(b.name, b.input, dir, { existed: (p) => st.seen.has(p) })
          if (abs) st.seen.add(abs)
          out.push({ id, tool: 'Claude Code', conv, kind: 'action', text, ts })
        }
      })
    }
    return { entries: out, endTurn: j.type === 'assistant' && msg.stop_reason === 'end_turn', relevant: j.type === 'user' || j.type === 'assistant' }
  }

  function readFile (file, backfill) {
    let st = files.get(file)
    const size = fs.statSync(file).size
    if (!st) {
      st = { offset: 0, partial: '', seen: new Set() }
      files.set(file, st)
      if (!backfill) {
        // Older conversation: only watch it from here on.
        st.offset = size
        return []
      }
    }
    if (size < st.offset) { st.offset = 0; st.partial = '' } // truncated or replaced
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
    st.partial = lines.pop() // incomplete last line (no newline yet)
    const entries = []
    for (const line of lines) {
      if (!line.trim()) continue
      const r = parseLine(line, file, st)
      if (!r) continue
      entries.push(...r.entries)
      if (r.relevant) {
        lastLineAt = now()
        if (!backfill) setStatus(r.endTurn ? 'idle' : 'working')
      }
    }
    return backfill ? entries.slice(-BACKFILL_ENTRIES) : entries
  }

  function tick () {
    if (stopped) return
    try {
      let dirs = []
      try {
        dirs = fs.readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name.startsWith(slug))
          .map((d) => path.join(root, d.name))
      } catch {} // Claude Code not used yet here
      const out = []
      for (const d of dirs) {
        let names = []
        try { names = fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')) } catch { continue }
        for (const n of names) {
          const file = path.join(d, n)
          const known = files.has(file)
          let backfill = false
          if (!known) {
            // On startup, pick up recent conversations; after that, any new file is live.
            backfill = !first || now() - fs.statSync(file).mtimeMs < BACKFILL_MS
          }
          try { out.push(...readFile(file, backfill)) } catch (err) {
            if (!failed) { failed = true; onLog(`Claude Code feed: could not read ${n}: ${err.message}`) }
          }
        }
      }
      first = false
      if (status === 'working' && now() - lastLineAt > IDLE_AFTER_MS) setStatus('idle')
      if (out.length) onEntries(out.sort((a, b) => a.ts - b.ts))
    } catch (err) {
      if (!failed) { failed = true; onLog(`Claude Code feed error: ${err.message}`) }
    }
  }

  tick()
  const timer = setInterval(tick, pollMs)
  return { stop () { stopped = true; clearInterval(timer) }, tick }
}

// Slash commands, hook output and similar plumbing that show up as "user" lines.
function isSystemText (text) {
  return /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|user-memory-input|bash-input|bash-stdout|bash-stderr)\b/.test(text) ||
    text.startsWith('Caveat: The messages below were generated by the user while running local commands')
}
