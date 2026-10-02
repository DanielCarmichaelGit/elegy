// Shared task board for a session: three columns, stored as plain objects in
// the Y.Doc so everyone (and every AI) sees the same list.
import crypto from 'node:crypto'

export const COLUMNS = [
  { id: 'todo', name: 'To do' },
  { id: 'doing', name: 'In progress' },
  { id: 'done', name: 'Done' }
]
export const COLUMN_IDS = new Set(COLUMNS.map((c) => c.id))
export const MAX_TASKS = 200
export const MAX_TITLE = 200

const HEX_ID = /^[0-9a-f]{16}$/i
// Control chars and bidi overrides: a task title is shown to everyone.
const INVISIBLE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

export function columnName (id) {
  return COLUMNS.find((c) => c.id === id)?.name || ''
}

export function cleanTitle (title) {
  return String(title ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
}

function cleanName (name) {
  const n = String(name ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  return n || 'someone'
}

function oneLine (s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

/** A task we'll show. Anything a modified client pushed that isn't this shape is ignored. */
export function publicTask (value) {
  if (!value || typeof value !== 'object') return null
  const title = typeof value.title === 'string' ? value.title : ''
  if (typeof value.id !== 'string' || !HEX_ID.test(value.id)) return null
  if (!title || title.length > MAX_TITLE || title !== cleanTitle(title)) return null
  if (!COLUMN_IDS.has(value.column)) return null
  if (typeof value.by !== 'string' || value.by.length > 80) return null
  if (typeof value.order !== 'number' || !Number.isFinite(value.order)) return null
  if (typeof value.ts !== 'number' || !Number.isFinite(value.ts)) return null
  return { id: value.id, title, column: value.column, by: value.by, order: value.order, ts: value.ts }
}

function byOrder (a, b) {
  return a.order - b.order || a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function split (map) {
  const valid = []
  const junk = []
  map.forEach((value, key) => {
    const task = publicTask(value)
    if (task && task.id === key) valid.push(task)
    else junk.push(key)
  })
  valid.sort(byOrder)
  return { valid, junk }
}

export function readTasks (map) {
  return split(map).valid
}

function listed (tasks) {
  if (tasks && typeof tasks.forEach === 'function' && !Array.isArray(tasks)) return readTasks(tasks)
  return (Array.isArray(tasks) ? tasks : []).map(publicTask).filter(Boolean).sort(byOrder)
}

function nextOrder (tasks, column) {
  const col = tasks.filter((t) => t.column === column)
  if (!col.length) return 1
  return Math.max(...col.map((t) => t.order)) + 1
}

/** Where a card lands in `column`. `beforeId` inserts ahead of that card; otherwise it goes last. */
function orderBefore (tasks, column, beforeId) {
  const col = tasks.filter((t) => t.column === column).sort(byOrder)
  const last = col.length ? col[col.length - 1].order + 1 : 1
  if (!beforeId) return last
  const i = col.findIndex((t) => t.id === beforeId)
  if (i < 0) return last
  if (i === 0) return col[0].order - 1
  return (col[i - 1].order + col[i].order) / 2
}

/**
 * Adds a task to To do. When the board is full, the oldest Done task is
 * dropped to make room. Throws if there is nothing finished to drop.
 */
export function addTask (doc, map, { title, by }, origin) {
  const clean = cleanTitle(title)
  if (!clean) throw new Error('say what the task is')
  const { valid, junk } = split(map)
  const dropping = []
  if (valid.length >= MAX_TASKS) {
    const done = valid.filter((t) => t.column === 'done').sort((a, b) => a.ts - b.ts || byOrder(a, b))
    const need = valid.length - MAX_TASKS + 1
    if (done.length < need) throw new Error('the board is full. Remove a task first.')
    dropping.push(...done.slice(0, need).map((t) => t.id))
  }
  const task = {
    id: crypto.randomBytes(8).toString('hex'),
    title: clean,
    column: 'todo',
    by: cleanName(by),
    order: nextOrder(valid, 'todo'),
    ts: Date.now()
  }
  doc.transact(() => {
    for (const key of junk) map.delete(key)
    for (const id of dropping) map.delete(id)
    map.set(task.id, task)
  }, origin)
  return task
}

/** Changes a task's title, column, or place. `before` is a task id to insert ahead of. */
export function updateTask (doc, map, { id, title, column, before } = {}, origin) {
  const { valid } = split(map)
  const cur = valid.find((t) => t.id === id)
  if (!cur) throw new Error('no such task')
  const next = { ...cur }
  let changed = false
  if (title !== undefined) {
    const clean = cleanTitle(title)
    if (!clean) throw new Error('say what the task is')
    if (clean !== cur.title) { next.title = clean; changed = true }
  }
  if (column !== undefined && !COLUMN_IDS.has(column)) throw new Error('pick To do, In progress, or Done')
  const moving = column !== undefined && column !== cur.column
  const beforeId = typeof before === 'string' && before && before !== id ? before : null
  if (moving || beforeId) {
    const dest = column || cur.column
    next.column = dest
    next.order = orderBefore(valid.filter((t) => t.id !== id), dest, beforeId)
    changed = true
  }
  if (!changed) return cur
  doc.transact(() => map.set(id, next), origin)
  return next
}

export function deleteTask (doc, map, id, origin) {
  const { valid } = split(map)
  if (!valid.some((t) => t.id === id)) throw new Error('no such task')
  doc.transact(() => map.delete(id), origin)
}

/** Markdown for people (STATUS.md, quilt_status). `me` is shown as "you". */
export function taskMarkdown (tasks, me) {
  const list = listed(tasks)
  if (!list.length) return '_No tasks yet._'
  return COLUMNS.map((col) => {
    const items = list.filter((t) => t.column === col.id)
    const body = items.length
      ? items.map((t) => `- ${oneLine(t.title)} _(${t.by === me ? 'you' : oneLine(t.by) || 'someone'})_`).join('\n')
      : '_Nothing._'
    return `**${col.name}**\n${body}`
  }).join('\n\n')
}

/** Plain text for an agent, with ids so it can move a task. */
export function formatTasks (tasks) {
  const list = listed(tasks)
  if (!list.length) return 'No tasks yet. The board has three columns: To do, In progress, and Done.'
  return COLUMNS.map((col) => {
    const items = list.filter((t) => t.column === col.id)
    const lines = items.length
      ? items.map((t) => `- ${t.id}  ${oneLine(t.title)}  (${oneLine(t.by) || 'someone'})`)
      : ['- Nothing.']
    return `${col.name}\n${lines.join('\n')}`
  }).join('\n\n')
}
