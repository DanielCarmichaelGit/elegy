import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rowFrom } from '../src/api/supabase-store.js'

test('rowFrom camelCases columns and turns every *At field into epoch ms', () => {
  const iso = '2026-09-29T00:00:00.000Z'
  const row = {
    id: 'd1',
    user_id: 'u1',
    name: 'Mac',
    public_key: 'pk',
    token_hash: 'th',
    created_at: iso,
    last_seen_at: iso,
    last_used_at: null,
    joined_at: iso,
    last_active_at: iso,
    expires_at: iso,
    revoked_at: null
  }
  const out = rowFrom(row)
  assert.equal(out.id, 'd1')
  assert.equal(out.userId, 'u1')
  assert.equal(out.publicKey, 'pk')
  assert.equal(out.tokenHash, 'th')
  for (const k of ['createdAt', 'lastSeenAt', 'joinedAt', 'lastActiveAt', 'expiresAt']) {
    assert.equal(out[k], Date.parse(iso), `${k} should be epoch ms`)
  }
  assert.equal(out.lastUsedAt, null)
  assert.equal(out.revokedAt, null)
})

test('rowFrom passes through null rows', () => {
  assert.equal(rowFrom(null), null)
  assert.equal(rowFrom(undefined), undefined)
})
