import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countLabel } from '../lib/dashboard-view.js'

test('countLabel: none, one, many, and unknown', () => {
  assert.equal(countLabel(0, 'agent', 'agents', 'No agents yet.'), 'No agents yet.')
  assert.equal(countLabel(1, 'agent', 'agents', 'No agents yet.'), '1 agent')
  assert.equal(countLabel(3, 'computer linked', 'computers linked', 'None.'), '3 computers linked')
  assert.equal(countLabel(null, 'agent', 'agents', 'No agents yet.'), 'Couldn’t count these right now.')
  assert.equal(countLabel(undefined, 'agent', 'agents', 'No agents yet.'), 'Couldn’t count these right now.')
})
