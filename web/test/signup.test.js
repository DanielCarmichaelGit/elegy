import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signUpData, orgSignUpData } from '../lib/signup.js'

test('a personal sign-up carries only the name', () => {
  assert.deepEqual(signUpData({ name: ' Dana ' }), { name: 'Dana' })
})

test('an org sign-up carries the org name and account: org until the org exists', () => {
  assert.deepEqual(orgSignUpData({ name: 'Dana', orgName: '  Acme  ' }), { name: 'Dana', org_name: 'Acme', account: 'org' })
  assert.equal(orgSignUpData({ name: 'Dana', orgName: '  ' }), null)
  assert.equal(orgSignUpData({ name: 'Dana', orgName: 'a'.repeat(81) }), null)
})
