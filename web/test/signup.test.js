import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signUpData } from '../lib/signup.js'

test('a "just me" sign-up carries only the name', () => {
  assert.deepEqual(signUpData({ name: ' Dana ', kind: 'me', orgName: 'Ignored' }), { name: 'Dana' })
})

test('a team sign-up carries the org name until the org exists', () => {
  assert.deepEqual(signUpData({ name: 'Dana', kind: 'team', orgName: '  Acme  ' }), { name: 'Dana', org_name: 'Acme' })
  assert.equal(signUpData({ name: 'Dana', kind: 'team', orgName: '  ' }), null)
  assert.equal(signUpData({ name: 'Dana', kind: 'team', orgName: 'a'.repeat(81) }), null)
})
