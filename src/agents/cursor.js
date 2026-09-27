// Reads Cursor's AI chat ("composer") history for one project folder. Cursor
// keeps it in SQLite: the workspace's state.vscdb lists the conversations and
// the global state.vscdb holds each message ("bubble"). Opened read-only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeAction } from './actions.js'
import { capText } from './common.js'

const POLL_MS = 2000
const WORKING_MS = 10000
const BACKFILL_MS = 60 * 60 * 1000
const BACKFILL_ENTRIES = 50
const SETTLE_MS = 4000 // a still-streaming reply is shared once it stops changing

export function cursorUserDir (home = os.homedir()) {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User')
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User')
  return path.join(home, '.config', 'Cursor', 'User')
}

/** Finds the workspaceStorage folder Cursor uses for `dir`, or null. */
export function findWorkspace (userDir, dir) {
  const root = path.join(userDir, 'workspaceStorage')
  let names = []
  try { names = fs.readdirSync(root) } catch { return null }
  for (const n of names) {
    try {
      const ws = JSON.parse(fs.readFileSync(path.join(root, n, 'workspace.json'), 'utf8'))
      if (ws.folder && path.resolve(fileURLToPath(ws.folder)) === path.resolve(dir)) return path.join(root, n)
    } catch {}
  }
  return null
}

export function startCursorReader ({ dir, onEntries, onState, onLog = () => {}, userDir, pollMs = POLL_MS, now = Date.now }) {
  dir = path.resolve(dir)
  userDir = userDir || cursorUserDir()
  let stopped = false
  let timer = null
  let status = null
  let wsDb = null
  let globalDb = null
  let workspace = null
  let first = true
  let lastChangeAt = 0
  const composers = new Map() // composerId -> { updatedAt, emitted: Set<bubbleId>, pending: Map<bubbleId, {text, since}> }

  const setState = (s, reason) => {
    if (s === status) return
    status = s
    onState({ tool: 'Cursor', status: s, ...(reason ? { reason } : {}) })
  }

  const fail = (reason) => {
    setState('unavailable', reason)
    onLog(`Cursor feed unavailable: ${reason}`)
    stop()
  }

  function stop () {
    stopped = true
    clearTimeout(timer)
    try { wsDb && wsDb.close() } catch {}
    try { globalDb && globalDb.close() } catch {}
  }

  async function init () {
    let DatabaseSync
    // node:sqlite prints an "experimental" warning on first import; keep the terminal clean.
    const emit = process.emitWarning
    process.emitWarning = (w, ...rest) => { if (!/SQLite/.test(String(w && w.message || w))) emit.call(process, w, ...rest) }
    try {
      ({ DatabaseSync } = await import('node:sqlite'))
    } catch {
      return fail('reading Cursor chats needs Node.js 22.13 or newer')
    } finally {
      process.emitWarning = emit
    }
    setState('idle')
    const open = () => {
      workspace = findWorkspace(userDir, dir)
      if (!workspace) return false
      wsDb = new DatabaseSync(path.join(workspace, 'state.vscdb'), { readOnly: true })
      globalDb = new DatabaseSync(path.join(userDir, 'globalStorage', 'state.vscdb'), { readOnly: true })
      return true
    }
    const loop = () => {
      if (stopped) return
      try {
        if (!workspace && !open()) { timer = setTimeout(loop, pollMs * 5); return } // Cursor hasn't opened this folder yet
        poll(DatabaseSync)
      } catch (err) {
        return fail(explain(err))
      }
      timer = setTimeout(loop, pollMs)
    }
    loop()
  }

  function readJson (db, table, key) {
    const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key)
    if (!row) return null
    const v = row.value
    return JSON.parse(typeof v === 'string' ? v : Buffer.from(v).toString('utf8'))
  }

  function poll () {
    const list = readJson(wsDb, 'ItemTable', 'composer.composerData')
    const all = (list && Array.isArray(list.allComposers)) ? list.allComposers : []
    const out = []
    const t = now()
    for (const c of all) {
      const id = c && c.composerId
      if (!id) continue
      let st = composers.get(id)
      const updatedAt = c.lastUpdatedAt || c.createdAt || 0
      if (!st) {
        st = { updatedAt: -1, emitted: new Set(), pending: new Map() }
        composers.set(id, st)
        if (first && t - updatedAt > BACKFILL_MS) {
          // Old conversation: remember what's there so only new messages are shared.
          const data = readJson(globalDb, 'cursorDiskKV', `composerData:${id}`)
          for (const h of headers(data)) st.emitted.add(h.bubbleId)
          st.updatedAt = updatedAt
          continue
        }
      }
      if (updatedAt === st.updatedAt && !st.pending.size) continue
      if (updatedAt !== st.updatedAt && !first) lastChangeAt = t
      st.updatedAt = updatedAt

      const data = readJson(globalDb, 'cursorDiskKV', `composerData:${id}`)
      if (!data) continue
      const hs = headers(data)
      const fresh = []
      hs.forEach((h, i) => {
        if (st.emitted.has(h.bubbleId)) return
        const bubble = readJson(globalDb, 'cursorDiskKV', `bubbleId:${id}:${h.bubbleId}`)
        if (!bubble) return
        const isLast = i === hs.length - 1
        const text = bubble.text || ''
        if (isLast && !first) {
          // The newest bubble may still be streaming; wait until it settles.
          const p = st.pending.get(h.bubbleId)
          if (!p || p.text !== text) { st.pending.set(h.bubbleId, { text, since: t }); lastChangeAt = t; return }
          if (t - p.since < SETTLE_MS) return
        }
        st.pending.delete(h.bubbleId)
        st.emitted.add(h.bubbleId)
        fresh.push(...toEntries(id, h.bubbleId, bubble, first ? updatedAt : t))
      })
      out.push(...(first ? fresh.slice(-BACKFILL_ENTRIES) : fresh))
    }
    first = false
    setState(t - lastChangeAt < WORKING_MS ? 'working' : 'idle')
    if (out.length) onEntries(out)
  }

  function toEntries (conv, bubbleId, b, ts) {
    const base = { tool: 'Cursor', conv, ts }
    const out = []
    if (b.type === 1 && b.text && b.text.trim()) out.push({ ...base, id: bubbleId, kind: 'prompt', text: capText(b.text.trim()) })
    if (b.type === 2 && b.text && b.text.trim()) out.push({ ...base, id: bubbleId, kind: 'reply', text: capText(b.text.trim()) })
    const tool = b.toolFormerData
    if (tool && tool.name) {
      let args = tool.params || tool.rawArgs || {}
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = {} } }
      out.push({ ...base, id: `${bubbleId}:tool`, kind: 'action', text: describeAction(tool.name, args, dir) })
    }
    return out
  }

  init().catch((err) => fail(explain(err)))
  return { stop }
}

function headers (data) {
  if (!data) return []
  if (!Array.isArray(data.fullConversationHeadersOnly)) throw new Error('unexpected composer layout (no fullConversationHeadersOnly)')
  return data.fullConversationHeadersOnly.filter((h) => h && h.bubbleId)
}

function explain (err) {
  const m = String(err && err.message || err)
  if (/no such table/i.test(m)) return `Cursor's storage layout isn't recognized (${m})`
  if (/JSON/i.test(m)) return `Cursor's storage layout isn't recognized (unreadable data)`
  return m
}
