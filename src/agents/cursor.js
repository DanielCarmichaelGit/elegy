// Reads Cursor's AI chat ("composer") history for one project folder. Cursor
// keeps it in SQLite: the workspace's state.vscdb (and, in newer versions, the
// global ItemTable) lists the conversations, and the global cursorDiskKV table
// holds each conversation's message order and each message ("bubble").
// Opened read-only.
//
// Cursor writes these databases many times a second while it streams a reply,
// so reads can briefly fail with "database is locked". Those are retried on
// the next poll; only a storage layout we don't recognize stops the reader.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeAction } from './actions.js'
import { capText } from './common.js'

const POLL_MS = 1000
const WORKING_MS = 10000
const BACKFILL_MS = 60 * 60 * 1000
const BACKFILL_ENTRIES = 50
const SETTLE_MS = 2500 // a still-streaming bubble is shared once it stops changing
const ACTIVE_COUNT = 6 // most recent conversations read on every change
const HOT_MS = 30 * 60 * 1000 // conversations that changed this recently are always read
const RESCAN_MS = 30 * 1000 // look for (new) Cursor workspaces for this folder
const BUSY_TIMEOUT_MS = 200 // node:sqlite is synchronous: never block the process for long
const BUSY_LOG_AFTER = 30 // consecutive locked polls before saying so

export function cursorUserDir (home = os.homedir()) {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User')
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User')
  return path.join(home, '.config', 'Cursor', 'User')
}

const caseless = process.platform === 'darwin' || process.platform === 'win32'
function norm (p) {
  let r = path.resolve(p)
  try { r = fs.realpathSync.native(r) } catch {}
  r = r.replace(/[\\/]+$/, '') || r
  return caseless ? r.toLowerCase() : r
}

/** Local folder a workspace/URI value points at, or null (remote, multi-root, unparseable). */
function uriPath (u) {
  if (!u) return null
  if (typeof u === 'object') u = u.fsPath || u.external || (u.scheme === 'file' ? u.path : null)
  if (typeof u !== 'string') return null
  if (u.startsWith('file:')) { try { return fileURLToPath(u) } catch { return null } }
  return path.isAbsolute(u) ? u : null
}

/** Every workspaceStorage folder Cursor uses for `dir`, most recently used first. */
export function findWorkspaces (userDir, dir) {
  const root = path.join(userDir, 'workspaceStorage')
  const want = norm(dir)
  let names = []
  try { names = fs.readdirSync(root) } catch { return [] }
  const found = []
  for (const n of names) {
    try {
      const ws = JSON.parse(fs.readFileSync(path.join(root, n, 'workspace.json'), 'utf8'))
      const folder = uriPath(ws.folder)
      if (!folder || norm(folder) !== want) continue
      const db = path.join(root, n, 'state.vscdb')
      found.push({ dir: path.join(root, n), mtime: fs.statSync(db).mtimeMs })
    } catch {}
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.dir)
}

/** The workspaceStorage folder Cursor uses for `dir`, or null. */
export function findWorkspace (userDir, dir) {
  return findWorkspaces(userDir, dir)[0] || null
}

export function startCursorReader ({ dir, chatDir, onEntries, onState, onLog = () => {}, userDir, pollMs = POLL_MS, settleMs = SETTLE_MS, now = Date.now }) {
  dir = path.resolve(dir)
  const chatRoot = path.resolve(chatDir || dir) // the folder Cursor has open
  userDir = userDir || cursorUserDir()
  let stopped = false
  let timer = null
  let status = null
  let DatabaseSync = null
  let globalDb = null
  const workspaces = new Map() // workspace folder -> db
  let lastScan = 0
  let first = true
  let lastChangeAt = 0
  let busyCount = 0
  const versions = new Map() // db -> last PRAGMA data_version
  // composerId -> { emitted: Set<bubbleId>, pending: Map<bubbleId, { sig, since, entries }>, listTs, seenAt }
  const composers = new Map()

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

  function closeDbs () {
    for (const db of [globalDb, ...workspaces.values()]) { try { db && db.close() } catch {} }
    globalDb = null
    workspaces.clear()
    versions.clear()
  }

  function stop () {
    stopped = true
    clearTimeout(timer)
    closeDbs()
  }

  const openDb = (file) => {
    const db = new DatabaseSync(file, { readOnly: true })
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    return db
  }

  /** Opens any Cursor workspace for this folder not opened yet. False if there is none. */
  function scan (t) {
    lastScan = t
    for (const ws of findWorkspaces(userDir, chatRoot)) {
      if (!workspaces.has(ws)) workspaces.set(ws, openDb(path.join(ws, 'state.vscdb')))
    }
    if (!workspaces.size) return false
    if (!globalDb) globalDb = openDb(path.join(userDir, 'globalStorage', 'state.vscdb'))
    return true
  }

  async function init () {
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
    const loop = () => {
      if (stopped) return
      const t = now()
      try {
        if ((!workspaces.size || t - lastScan > RESCAN_MS) && !scan(t)) {
          timer = setTimeout(loop, pollMs * 5) // Cursor hasn't opened this folder yet
          return
        }
        poll(t)
        busyCount = 0
      } catch (err) {
        if (!transient(err)) return fail(explain(err))
        // Cursor is mid-write, or its files moved: try again with fresh handles.
        closeDbs()
        if (++busyCount === BUSY_LOG_AFTER) onLog(`Cursor feed: storage has been busy for a while (${err.message}); still trying`)
      }
      timer = setTimeout(loop, pollMs)
    }
    loop()
  }

  function readJson (db, table, key) {
    const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key)
    if (!row || row.value == null) return null
    const v = row.value
    return JSON.parse(typeof v === 'string' ? v : Buffer.from(v).toString('utf8'))
  }

  /** True if another process committed to `db` since the last check. */
  function changed (db) {
    const v = db.prepare('PRAGMA data_version').get()
    const val = v && Object.values(v)[0]
    const was = versions.get(db)
    versions.set(db, val)
    return was !== val
  }

  /** This folder's conversations: [{ id, ts }], plus the ones open in Cursor right now. */
  function listComposers () {
    const out = new Map()
    const focused = new Set()
    const add = (c) => {
      const id = c && c.composerId
      if (!id || c.isArchived) return
      const ts = c.lastUpdatedAt || c.createdAt || 0
      if (!out.has(id) || out.get(id) < ts) out.set(id, ts)
    }
    const ids = new Set()
    for (const [ws, db] of workspaces) {
      ids.add(path.basename(ws))
      const list = readJson(db, 'ItemTable', 'composer.composerData')
      if (!list) continue
      if (Array.isArray(list.allComposers)) list.allComposers.forEach(add)
      for (const k of ['selectedComposerIds', 'lastFocusedComposerIds']) {
        if (Array.isArray(list[k])) for (const id of list[k]) if (typeof id === 'string') focused.add(id)
      }
    }
    // Newer Cursor versions keep the list globally, tagged with the workspace.
    let headers = null
    try { headers = readJson(globalDb, 'ItemTable', 'composer.composerHeaders') } catch (err) {
      if (!/no such table/i.test(err.message)) throw err
    }
    if (headers && Array.isArray(headers.allComposers)) {
      const want = norm(chatRoot)
      for (const c of headers.allComposers) {
        const w = c && c.workspaceIdentifier
        if (!w) continue
        const folder = uriPath(w.uri) || uriPath(w.folder) || uriPath(w.configPath)
        if (ids.has(w.id) || (folder && norm(folder) === want)) add(c)
      }
    }
    for (const id of focused) if (!out.has(id)) out.set(id, 0)
    return { list: [...out].map(([id, ts]) => ({ id, ts })), focused }
  }

  function poll (t) {
    let dirty = first
    for (const db of [globalDb, ...workspaces.values()]) if (changed(db)) dirty = true
    const out = []

    if (!dirty) {
      // Nothing was written: only let streaming bubbles that went quiet settle.
      for (const st of composers.values()) settle(st, t, out)
    } else {
      const { list, focused } = listComposers()
      for (const { id, ts } of list) {
        let st = composers.get(id)
        if (!st) {
          st = { emitted: new Set(), pending: new Map(), listTs: ts, seenAt: first ? 0 : t, isNew: !first }
          composers.set(id, st)
          if (first && t - ts > BACKFILL_MS) {
            // Old conversation: remember what's there so only new messages are shared.
            for (const h of headers(readJson(globalDb, 'cursorDiskKV', `composerData:${id}`))) st.emitted.add(h.bubbleId)
            continue
          }
        } else if (ts !== st.listTs) {
          st.listTs = ts
          st.seenAt = t
        }
      }
      const rank = (id) => { const st = composers.get(id); return Math.max(st.listTs, st.seenAt) }
      const recent = list.map((c) => c.id).sort((a, b) => rank(b) - rank(a))
      const active = new Set(recent.slice(0, ACTIVE_COUNT))
      for (const id of recent) {
        const st = composers.get(id)
        if (focused.has(id) || st.pending.size || t - rank(id) < HOT_MS || (first && t - st.listTs <= BACKFILL_MS)) active.add(id)
      }
      for (const id of active) {
        const fresh = readComposer(id, composers.get(id), t)
        out.push(...(first ? fresh.slice(-BACKFILL_ENTRIES) : fresh))
      }
    }

    first = false
    setState(t - lastChangeAt < WORKING_MS ? 'working' : 'idle')
    if (out.length) onEntries(out)
  }

  /** New entries from one conversation. Bubbles still being written wait until they settle. */
  function readComposer (id, st, t) {
    const data = readJson(globalDb, 'cursorDiskKV', `composerData:${id}`)
    if (!data) return []
    const hs = headers(data)
    const out = []
    hs.forEach((h, i) => {
      if (st.emitted.has(h.bubbleId)) return
      const bubble = h.inline || readJson(globalDb, 'cursorDiskKV', `bubbleId:${id}:${h.bubbleId}`)
      if (!bubble) return // listed before it was written; picked up next time
      const backfill = first
      const ts = backfill ? (Date.parse(bubble.createdAt) || st.listTs || t) : t
      const entries = toEntries(id, h.bubbleId, bubble, ts)
      if (backfill || (i < hs.length - 1 && entries.length)) {
        // Something came after it, so it's finished.
        if (!backfill && !st.pending.has(h.bubbleId)) touch(st, t)
        st.pending.delete(h.bubbleId)
        st.emitted.add(h.bubbleId)
        out.push(...entries)
        return
      }
      // The newest bubble (or one that's still empty) may still be streaming.
      const sig = signature(bubble)
      const p = st.pending.get(h.bubbleId)
      if (!p || p.sig !== sig) {
        st.pending.set(h.bubbleId, { sig, since: t, entries, ts })
        touch(st, t)
      } else {
        p.entries = entries
      }
    })
    settle(st, t, out)
    return out
  }

  function settle (st, t, out) {
    for (const [bubbleId, p] of st.pending) {
      if (t - p.since < settleMs) continue
      st.pending.delete(bubbleId)
      st.emitted.add(bubbleId)
      out.push(...p.entries.map((e) => ({ ...e, ts: t })))
    }
  }

  function touch (st, t) {
    st.seenAt = t
    lastChangeAt = t
  }

  function toEntries (conv, bubbleId, b, ts) {
    const base = { tool: 'Cursor', conv, ts }
    const out = []
    const text = typeof b.text === 'string' ? b.text.trim() : ''
    if (b.type === 1 && text) out.push({ ...base, id: bubbleId, kind: 'prompt', text: capText(text) })
    if (b.type === 2 && text) out.push({ ...base, id: bubbleId, kind: 'reply', text: capText(text) })
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

/** A conversation's bubbles in order: [{ bubbleId, inline? }]. */
function headers (data) {
  if (!data) return []
  if (Array.isArray(data.fullConversationHeadersOnly)) return data.fullConversationHeadersOnly.filter((h) => h && h.bubbleId)
  // Older Cursor versions kept the bubbles inline.
  if (Array.isArray(data.conversation)) return data.conversation.filter((b) => b && b.bubbleId).map((b) => ({ bubbleId: b.bubbleId, inline: b }))
  throw new Error('unexpected composer layout (no fullConversationHeadersOnly)')
}

function signature (b) {
  const tool = b.toolFormerData || {}
  const args = tool.params || tool.rawArgs || ''
  return `${b.type}|${(b.text || '').length}|${b.text || ''}|${tool.name || ''}|${typeof args === 'string' ? args : JSON.stringify(args)}`
}

function transient (err) {
  const m = `${err && err.code} ${err && err.message}`
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked|SQLITE_IOERR|disk I\/O error|SQLITE_CANTOPEN|unable to open|ENOENT/i.test(m)
}

function explain (err) {
  const m = String(err && err.message || err)
  if (/no such table/i.test(m)) return `Cursor's storage layout isn't recognized (${m})`
  if (/JSON/i.test(m)) return `Cursor's storage layout isn't recognized (unreadable data)`
  return m
}
