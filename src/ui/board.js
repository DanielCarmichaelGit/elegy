// The session task board: three columns. Task ids and titles come from the
// shared room, so every string is escaped. Column ids match src/tasks.js.
import { I, esc } from './common.js'

// Arms stay inside the view box so a round stroke isn't clipped into a plus.
const CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>'

const COLUMNS = [
  { id: 'todo', name: 'To do', moves: [{ column: 'doing', name: 'In progress', label: 'Start', icon: 'arrowRight' }] },
  { id: 'doing', name: 'In progress', moves: [{ column: 'todo', name: 'To do', label: 'To do', icon: 'arrowLeft' }, { column: 'done', name: 'Done', label: 'Done', icon: 'check' }] },
  { id: 'done', name: 'Done', moves: [{ column: 'doing', name: 'In progress', label: 'Reopen', icon: 'arrowLeft' }] }
]

export function renderBoard (tasks, me, people = [], assignTo = '') {
  const list = Array.isArray(tasks) ? tasks : []
  const cols = COLUMNS.map((col) => {
    const cards = list.filter((t) => t && t.column === col.id)
    const body = cards.length
      ? cards.map((t) => card(t, col, me, people)).join('')
      : `<p class="board-empty">${col.id === 'todo' ? 'Nothing here yet.' : 'Nothing here.'}</p>`
    return `<section class="board-col" data-column="${col.id}" aria-label="${esc(col.name)}">
      <h3>${esc(col.name)} <span class="board-n">${cards.length}</span></h3>
      <div class="board-list">${body}</div>
    </section>`
  }).join('')
  return `<div class="board">
    <div class="board-head">
      <h2 class="board-title" title="Shared with everyone in this session. Assign a task to a person or their AI.">Tasks</h2>
      <form id="task-add-form" class="board-add">
        <label class="board-add-task">
          ${I.plus}
          <input id="task-add" maxlength="200" placeholder="What needs doing?" aria-label="New task" autocomplete="off">
        </label>
        <div class="board-add-assign">
          <label for="task-add-assign">Assign to</label>
          <select id="task-add-assign" class="task-add-assign" aria-label="Assign new task to">${assignOptions(taskForAssign(assignTo), me, people)}</select>
        </div>
        <button class="btn sm primary" type="submit">Add task</button>
      </form>
    </div>
    <div class="board-cols">${cols}</div>
  </div>`
}

function assignValue (t) {
  if (!t.assignee) return ''
  return `${t.forAi ? 'a' : 'p'}:${t.assignee}`
}

/** `p:name` is the person, `a:name` is their AI. Anything else is unassigned. */
function taskForAssign (value) {
  const forAi = typeof value === 'string' && value.startsWith('a:')
  const person = typeof value === 'string' && value.startsWith('p:')
  if (!forAi && !person) return { assignee: '' }
  return { assignee: value.slice(2), forAi, tool: '' }
}

function assignOptions (task, me, people) {
  const opts = [{ value: '', label: 'Unassigned' }]
  const seen = new Set()
  for (const p of people) {
    if (!p?.name || seen.has(p.name)) continue
    seen.add(p.name)
    const you = p.name === me
    opts.push({ value: `p:${p.name}`, label: you ? 'You' : p.name })
    if (!p.agent) {
      const tool = p.tool || 'AI'
      opts.push({ value: `a:${p.name}`, label: you ? `Your ${tool}` : `${p.name}'s ${tool}` })
    }
  }
  const cur = assignValue(task)
  if (cur && !opts.some((o) => o.value === cur)) {
    const tool = task.tool || 'AI'
    const label = task.forAi
      ? (task.assignee === me ? `Your ${tool}` : `${task.assignee}'s ${tool}`)
      : (task.assignee === me ? 'You' : task.assignee)
    opts.push({ value: cur, label })
  }
  const selected = cur
  return opts.map((o) => `<option value="${esc(o.value)}"${o.value === selected ? ' selected' : ''}>${esc(o.label)}</option>`).join('')
}

function filesHtml (files) {
  if (!files?.length) return ''
  return `<ul class="task-files">${files.map((f) => {
    const base = f.split('/').pop()
    return `<li class="task-file-chip" title="${esc(f)}"><code>${esc(base)}</code><button type="button" class="task-file-x" data-file-remove="${esc(f)}" aria-label="Remove ${esc(f)}">${CLOSE}</button></li>`
  }).join('')}</ul>`
}

function verifiedHtml (t) {
  if (t.column !== 'done' || !t.verified) return ''
  const v = String(t.verified).replace(/\s+/g, ' ').trim()
  return `<p class="task-verified" title="${esc(v)}">${esc(v.length > 160 ? `${v.slice(0, 157)}…` : v)}</p>`
}

function card (t, col, me, people) {
  const who = t.by === me ? 'You' : (t.by || '')
  const mine = t.assignee === me && !t.forAi ? ' mine' : t.assignee === me && t.forAi ? ' mine-ai' : ''
  const moves = col.moves.map((m) =>
    `<button type="button" class="task-move" data-move="${m.column}" title="Move to ${esc(m.name)}" aria-label="Move to ${esc(m.name)}">${I[m.icon]}<span>${esc(m.label)}</span></button>`
  ).join('')
  return `<article class="task${mine}" draggable="true" data-task="${esc(t.id)}">
    <div class="task-main">
      <button type="button" class="task-title">${esc(t.title)}</button>
      <div class="task-tools">
        <button type="button" class="task-icon" data-task-edit title="Edit" aria-label="Edit task">${I.pencil}</button>
        <button type="button" class="task-icon task-x" data-task-delete title="Remove" aria-label="Remove task">${CLOSE}</button>
      </div>
    </div>
    <select class="task-assign" aria-label="Assign ${esc(t.title)}">${assignOptions(t, me, people)}</select>
    ${filesHtml(t.files)}
    ${verifiedHtml(t)}
    <form class="task-file-form">
      <input class="task-file" placeholder="Add a file…" aria-label="Add a file to ${esc(t.title)}" maxlength="240" autocomplete="off">
    </form>
    <div class="task-foot">
      <span class="task-by">${esc(who)}</span>
      <div class="task-moves">${moves}</div>
    </div>
  </article>`
}
