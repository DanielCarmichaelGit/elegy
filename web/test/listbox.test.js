import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moveIndex } from '../lib/listbox.js'

test('moveIndex: arrows step and stop at the ends', () => {
  assert.equal(moveIndex('ArrowDown', 0, 3), 1)
  assert.equal(moveIndex('ArrowDown', 2, 3), 2)
  assert.equal(moveIndex('ArrowUp', 1, 3), 0)
  assert.equal(moveIndex('ArrowUp', 0, 3), 0)
})

test('moveIndex: Home and End jump; other keys and empty lists do nothing', () => {
  assert.equal(moveIndex('Home', 2, 3), 0)
  assert.equal(moveIndex('End', 0, 3), 2)
  assert.equal(moveIndex('Enter', 1, 3), null)
  assert.equal(moveIndex('ArrowDown', 0, 0), null)
  assert.equal(moveIndex('ArrowDown', -1, 3), 1, 'an out-of-range start is clamped first')
})
