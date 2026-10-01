import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inviteFromForm, splitFolders } from '../lib/agent-form.js'

test('splitFolders splits on commas and drops blanks; the API tidies each folder', () => {
  assert.deepEqual(splitFolders(' src, docs/ ,,web '), ['src', 'docs/', 'web'])
  assert.deepEqual(splitFolders(null), [])
})

test('inviteFromForm reads the role and each filled-in team row in order, viewer unless editor was chosen', () => {
  const f = new FormData()
  f.append('slug', 'acme')
  f.append('roleId', '')
  for (const [teamId, access, folders] of [['t1', 'editor', 'src, docs'], ['', 'viewer', 'ignored'], ['t2', 'owner', '']]) {
    f.append('teamId', teamId); f.append('access', access); f.append('folders', folders)
  }
  assert.deepEqual(inviteFromForm(f), {
    roleId: null,
    teams: [{ teamId: 't1', access: 'editor', scopes: ['src', 'docs'] }, { teamId: 't2', access: 'viewer', scopes: [] }]
  })
  f.set('roleId', 'r1')
  assert.equal(inviteFromForm(f).roleId, 'r1')
  assert.deepEqual(inviteFromForm(new FormData()), { roleId: null, teams: [] })
})
