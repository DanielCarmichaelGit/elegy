import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const file = new URL('../supabase/migrations/20260930000000_orgs.sql', import.meta.url)
const sql = () => fs.readFileSync(file, 'utf8')
const TABLES = ['orgs', 'roles', 'org_members', 'teams', 'team_members', 'org_invites', 'join_requests']

test('every org table exists with row-level security and a service-role grant', () => {
  const s = sql()
  for (const t of TABLES) {
    assert.match(s, new RegExp(`create table public\\.${t} \\(`), t)
    assert.match(s, new RegExp(`alter table public\\.${t} enable row level security`), t)
  }
  assert.match(s, /grant all on public\.orgs, public\.roles, public\.org_members, public\.teams, public\.team_members, public\.org_invites, public\.join_requests to service_role/)
})

test('clients never read invites (token hashes live there) and write nothing', () => {
  const s = sql()
  assert.match(s, /token_hash text not null unique/)
  assert.doesNotMatch(s, /grant [^;]*on public\.org_invites to authenticated/)
  assert.doesNotMatch(s, /grant (insert|update|delete)[^;]* to authenticated/)
})

test('the org functions run only as the API; the RLS helper only for signed-in people', () => {
  const s = sql()
  assert.match(s, /revoke execute on function public\.create_org\(text, text, uuid, jsonb, jsonb, jsonb\), public\.transfer_org\(uuid, uuid\) from public, anon, authenticated;/)
  assert.match(s, /grant execute on function public\.create_org\(text, text, uuid, jsonb, jsonb, jsonb\), public\.transfer_org\(uuid, uuid\) to service_role;/)
  assert.match(s, /revoke execute on function public\.my_org_ids\(\) from public, anon;/)
})

test('member rows are a person or an agent; team access and folders are constrained', () => {
  const s = sql()
  assert.match(s, /check \(\(user_id is null\) <> \(agent_id is null\)\)/)
  assert.match(s, /access text not null check \(access in \('editor', 'viewer'\)\)/)
  assert.match(s, /check \(cardinality\(scopes\) <= 20\)/)
  assert.match(s, /create unique index join_requests_one_pending on public\.join_requests \(org_id, user_id\) where status = 'pending'/)
  assert.ok(s.includes("slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'"), 'slug format matches src/api/slugs.js')
})
