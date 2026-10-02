// The add form can name who a task is for before the card exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.location = { search: '' }
globalThis.sessionStorage = { getItem () { return null }, setItem () {} }
globalThis.history = { replaceState () {} }
globalThis.window = { addEventListener () {} } // common.js installs the error reporter at load

const { renderBoard } = await import('../src/ui/board.js')

function addAssign (html) {
  const start = html.indexOf('id="task-add-assign"')
  assert.ok(start > -1, 'add form has an assignee select')
  return html.slice(start, html.indexOf('</select>', start))
}

const people = [
  { name: 'Ada', tool: 'Cursor' },
  { name: 'Bea', tool: 'Claude Code' },
  { name: 'Bot', tool: 'Cursor', agent: true }
]

test('the add form lists you, your AI, and everyone else', () => {
  const sel = addAssign(renderBoard([], 'Ada', people))
  assert.match(sel, /<option value="" selected>Unassigned<\/option>/)
  assert.match(sel, /<option value="p:Ada">You<\/option>/)
  assert.match(sel, /<option value="a:Ada">Your Cursor<\/option>/)
  assert.match(sel, /<option value="p:Bea">Bea<\/option>/)
  assert.match(sel, /<option value="a:Bea">Bea&#39;s Claude Code<\/option>/)
  assert.match(sel, /<option value="p:Bot">Bot<\/option>/)
  assert.doesNotMatch(sel, /value="a:Bot"/)
})

test('a choice made before Add stays selected across a redraw', () => {
  const sel = addAssign(renderBoard([], 'Ada', people, 'a:Bea'))
  assert.match(sel, /<option value="a:Bea" selected>/)
  assert.doesNotMatch(sel, /<option value="" selected>/)
})

test('a name is escaped in the add form', () => {
  const sel = addAssign(renderBoard([], 'Ada', [{ name: 'A<da', tool: 'Cursor' }, { name: 'Ada', tool: 'Cursor' }]))
  assert.match(sel, /value="p:A&lt;da"/)
  assert.match(sel, />A&lt;da</)
})
