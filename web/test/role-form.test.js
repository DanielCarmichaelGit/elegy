import { test } from 'node:test'
import assert from 'node:assert/strict'
import { grantsFromForm } from '../lib/role-form.js'

test('grantsFromForm reads the checked boxes and ignores everything else', () => {
  const f = new FormData()
  f.append('slug', 'acme')
  f.append('name', 'Lead')
  f.append('g.teams.c', 'on')
  f.append('g.teams.r', 'on')
  f.append('g.org.c', 'on')
  f.append('g.members.d', 'off')
  f.append('g.__proto__.r', 'on')
  f.append('g.billing.r', 'on')
  assert.deepEqual(grantsFromForm(f), { teams: { c: true, r: true } })
  assert.equal({}.r, undefined, 'nothing leaks onto Object.prototype')
})
