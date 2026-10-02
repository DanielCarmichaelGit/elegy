import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('"Delete it" works even when the form it sits in has a field left empty', () => {
  const src = fs.readFileSync(new URL('../components/ConfirmDelete.js', import.meta.url), 'utf8')
  assert.match(src, /<button className='btn danger' formAction=\{action\} formNoValidate>Delete it<\/button>/)
})
