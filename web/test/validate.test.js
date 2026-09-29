import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidEmail, isValidPassword } from '../lib/validate.js'

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
