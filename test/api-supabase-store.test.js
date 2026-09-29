import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { rowFrom, createSupabaseStore } from '../src/api/supabase-store.js'

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

// A stand-in supabase client that records each query chain and answers with `data`.
function fakeClient (data = {}) {
  const calls = []
  const client = {
    from (table) {
      const q = { table, ops: [] }
      calls.push(q)
      const chain = new Proxy({}, {
        get (_, op) {
          if (op === 'then') return (res, rej) => Promise.resolve({ data: typeof data === 'function' ? data(q) : data, error: null }).then(res, rej)
          return (...args) => { q.ops.push([op, ...args]); return chain }
        }
      })
      return chain
    }
  }
  return { client, calls }
}

test('supabase upsertDevice: one row per (account, key), and a relink clears the old token', async () => {
  const { client, calls } = fakeClient({ id: 'd1', user_id: 'u1', token_hash: null })
  const s = createSupabaseStore({ client })
  await s.upsertDevice({ userId: 'u1', name: 'Mac', platform: 'darwin', publicKey: 'pk1' })
  const upsert = calls[0].ops.find(([op]) => op === 'upsert')
  assert.equal(upsert[2].onConflict, 'user_id,public_key')
  assert.equal(upsert[1].token_hash, null)
  assert.equal(upsert[1].revoked_at, null)
})

test('the migration keys devices on (user_id, public_key) and allows the approving status', () => {
  const sql = fs.readFileSync(new URL('../supabase/migrations/20260929000000_accounts.sql', import.meta.url), 'utf8')
  const devices = sql.match(/create table public\.devices \(([\s\S]*?)\n\);/)[1]
  assert.doesNotMatch(devices, /public_key text not null unique/)
  assert.match(devices, /unique \(user_id, public_key\)/)
  assert.match(sql, /status in \('pending', 'approving', 'approved', 'denied', 'consumed'\)/)
})
