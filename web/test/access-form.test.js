import { test } from 'node:test'
import assert from 'node:assert/strict'
import { typeFromForm, foldersText, describeType } from '../lib/access-form.js'

const form = (fields) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); return f }

test('a type from its form: folders one per line, posting from the switch', () => {
  assert.deepEqual(typeFromForm(form({ name: ' Docs writer ', files: 'edit', folders: 'docs\n\n  web/app  \n', talk: 'on' })), { name: 'Docs writer', files: 'edit', folders: ['docs', 'web/app'], talk: true })
  assert.deepEqual(typeFromForm(form({ name: 'Reviewer', files: 'view' })), { name: 'Reviewer', files: 'view', folders: [], talk: false }, 'an unticked switch sends nothing')
  assert.equal(typeFromForm(form({ name: 'x', files: 'admin' })).files, 'edit', 'only edit or view')
})

test('folders back into the form, and a type at a glance', () => {
  assert.equal(foldersText(['docs', 'web']), 'docs\nweb')
  assert.equal(foldersText(undefined), '')
  assert.equal(describeType({ files: 'edit', folders: [], talk: true }), 'Can edit · all folders · may post')
  assert.equal(describeType({ files: 'edit', folders: ['docs'], talk: false }), 'Can edit · docs · no posting')
  assert.equal(describeType({ files: 'view', folders: [], talk: true }), 'View only · may post')
})
