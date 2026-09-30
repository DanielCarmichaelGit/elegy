import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidEmail, isValidPassword, isValidOrgName } from '../lib/validate.js'

test('isValidEmail accepts plausible emails and rejects the rest', () => {
  assert.equal(isValidEmail('a@b.com'), true)
  assert.equal(isValidEmail('a.b+c@sub.example.co'), true)
  assert.equal(isValidEmail('not-an-email'), false)
  assert.equal(isValidEmail('a@b'), false)
  assert.equal(isValidEmail('a b@c.com'), false)
  assert.equal(isValidEmail(''), false)
  assert.equal(isValidEmail(null), false)
})

test('isValidPassword requires between 8 and 72 characters', () => {
  assert.equal(isValidPassword('short1'), false)
  assert.equal(isValidPassword('longenough'), true)
  assert.equal(isValidPassword(''), false)
  assert.equal(isValidPassword(undefined), false)
  assert.equal(isValidPassword('a'.repeat(72)), true)
  assert.equal(isValidPassword('a'.repeat(73)), false)
})

test('isValidOrgName needs 1 to 80 characters', () => {
  assert.equal(isValidOrgName('Acme'), true)
  assert.equal(isValidOrgName('  Acme  '), true)
  assert.equal(isValidOrgName('   '), false)
  assert.equal(isValidOrgName('a'.repeat(80)), true)
  assert.equal(isValidOrgName('a'.repeat(81)), false)
  assert.equal(isValidOrgName(null), false)
})
