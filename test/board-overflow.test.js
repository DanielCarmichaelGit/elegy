// Task board overflow: each column scrolls inside a fixed board viewport so the
// rest of the workspace (header, tree, chat) does not scroll away.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const css = fs.readFileSync(path.join(root, 'src/ui/app.css'), 'utf8')
const boardJs = fs.readFileSync(path.join(root, 'src/ui/board.js'), 'utf8')

function rule (selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${esc}\\s*\\{([^}]*)\\}`)
  const m = css.match(re)
  assert.ok(m, `missing CSS rule ${selector}`)
  return m[1]
}

test('board markup keeps a per-column scroll container', () => {
  assert.match(boardJs, /class="board"/)
  assert.match(boardJs, /class="board-cols"/)
  assert.match(boardJs, /class="board-col"/)
  assert.match(boardJs, /class="board-list"/)
  // Cards are rendered inside .board-list so column overflow scrolls there.
  assert.match(boardJs, /class="board-list">\$\{body\}/)
})

test('CSS pins the board viewport and lets each column list scroll', () => {
  const board = rule('.board')
  assert.match(board, /flex:\s*1/)
  assert.match(board, /min-height:\s*0/)
  assert.match(board, /overflow:\s*hidden/)

  assert.match(rule('.board-head'), /flex:\s*none/)

  const cols = rule('.board-cols')
  assert.match(cols, /min-height:\s*0/)
  assert.match(cols, /grid-template-rows:\s*minmax\(0,\s*1fr\)/)
  assert.match(cols, /overflow:\s*hidden/)

  const col = rule('.board-col')
  assert.match(col, /min-height:\s*0/)
  assert.match(col, /overflow:\s*hidden/)

  const list = rule('.board-list')
  assert.match(list, /flex:\s*1/)
  assert.match(list, /min-height:\s*0/)
  assert.match(list, /overflow:\s*auto/)
  assert.match(list, /overscroll-behavior:\s*contain/)

  assert.match(rule('.ws'), /overflow:\s*hidden/)
})
