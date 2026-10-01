// Test passes, signed with a key made for this test run, so relay and session
// tests never need the accounts API.
import { newPassKeys, signPass, PASS_TTL_MS } from '../src/passes.js'

export const PASS_KEYS = newPassKeys()

/** A pass for `identity`, like the API would sign it (any field can be overridden). */
export function makePass ({ identity, name = 'Dana', kind = 'person', sub = 'user-dana', exp = Date.now() + PASS_TTL_MS, v = 1, keys = PASS_KEYS }) {
  return signPass({ v, sub, kind, name, key: identity.publicKey, exp }, keys.privateKey)
}
