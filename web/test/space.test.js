import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SPACE_COOKIE, PERSONAL, isSlug, spaceHome } from '../lib/space.js'

test('the space cookie and personal space names', () => {
  assert.equal(SPACE_COOKIE, 'quilt_space')
  assert.equal(PERSONAL, 'personal')
})

test('isSlug matches the API slug format', () => {
  assert.equal(isSlug('acme'), true)
  assert.equal(isSlug('acme-rockets-2'), true)
  assert.equal(isSlug('Acme'), false)
  assert.equal(isSlug('-acme'), false)
  assert.equal(isSlug('acme--x'), false)
  assert.equal(isSlug('../x'), false)
  assert.equal(isSlug('a'.repeat(49)), false)
  assert.equal(isSlug(undefined), false)
})

test('spaceHome goes to a remembered org only while you are still in it', () => {
  const orgs = [{ slug: 'acme' }, { slug: 'zeta' }]
  assert.equal(spaceHome('acme', orgs), '/org/acme')
  assert.equal(spaceHome('gone', orgs), '/dashboard')
  assert.equal(spaceHome('personal', orgs), '/dashboard')
  assert.equal(spaceHome(undefined, orgs), '/dashboard')
  assert.equal(spaceHome('acme', undefined), '/dashboard')
})
