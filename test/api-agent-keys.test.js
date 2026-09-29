import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { newAgentIdentity, openAgentIdentity } from '../src/api/agent-keys.js'
import { signChallenge, parsePublicKey, verifyChallenge } from '../src/identity.js'

const SECRET = crypto.randomBytes(32).toString('base64')

test("an agent's private key is stored encrypted and opens into a working identity", () => {
  const stored = newAgentIdentity(SECRET)
  assert.ok(stored.publicKey && stored.privateKeyEnc)
  assert.ok(!stored.privateKeyEnc.includes(stored.publicKey))
  const id = openAgentIdentity(stored, SECRET)
  const nonce = crypto.randomBytes(32)
  const sig = signChallenge(id, 'room1', nonce)
  assert.ok(verifyChallenge(parsePublicKey(id.publicKey), 'room1', nonce, sig))
})

test('the wrong secret cannot open it', () => {
  const stored = newAgentIdentity(SECRET)
  assert.throws(() => openAgentIdentity(stored, crypto.randomBytes(32).toString('base64')))
})
