import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeNext } from '../lib/safe-next.js'

test('safeNext keeps same-site paths and rejects anything that could leave the site', () => {
  assert.equal(safeNext('/dashboard'), '/dashboard')
  assert.equal(safeNext('/link?code=AB-CD'), '/link?code=AB-CD')
  assert.equal(safeNext('//x'), '/dashboard')
  assert.equal(safeNext('/\\x'), '/dashboard')
  assert.equal(safeNext('/\t/x'), '/dashboard')
  assert.equal(safeNext('https://x'), '/dashboard')
  assert.equal(safeNext('javascript:alert(1)'), '/dashboard')
  assert.equal(safeNext(undefined), '/dashboard')
  // Normalisation can turn these into a pathname starting with // (or /\),
  // which browsers/new URL treat as a protocol-relative https://evil.com/ URL.
  assert.equal(safeNext('/.//evil.com'), '/dashboard')
  assert.equal(safeNext('/..//evil.com'), '/dashboard')
  assert.equal(safeNext('/a/..//evil.com'), '/dashboard')
  assert.equal(safeNext('/./\\evil.com'), '/dashboard')
})
