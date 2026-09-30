# Quilt Agent Sign-in Implementation Plan (plan 2 of 4 in the orgs spec)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI agents sign themselves in: an agent registers its own Ed25519 key, a signed-in person approves it at `/agents/approve` (into their personal space, or into an org with a role, teams, access and folders), and the agent collects a 1-hour access key and a rotating 30-day refresh key, with reuse detection. The old "Create agent / copy key" flow is removed.

**Architecture:** A new migration reshapes `agents` (no secrets, `owner_user_id` or `org_id`) and adds `agent_registrations` and `agent_keys` (hashes only, no client access). The accounts API gets a key module (`src/api/agent-auth.js`: minting, single-use refresh with family revocation, `agentFromRequest`), two route modules (`routes/agents.js` for token, `/me`, personal agents; `routes/agent-register.js` for register, signed poll and approval), and org integration in the existing member and team routes. A small CLI (`quilt agent login|whoami`) exercises the flow, and the website gets the approval page, a new "Your agents" dashboard section, and agents on the org People page.

**Tech Stack:** Node 22 ESM, `node:http`, `node:crypto` (Ed25519, SHA-256), `node:test`; Supabase Postgres + `@supabase/supabase-js` 2.117; Next.js 16 App Router, React 19; Fly (`quilt-api`), Netlify (`heyquilt`).

**Spec:** `docs/superpowers/specs/2026-09-29-orgs-roles-agents-design.md` (build order item 2: "Agent sign-in"; data-model rows `agents`, `agent_registrations`, `agent_keys`; Security; Decisions). Previous plan: `docs/superpowers/plans/2026-09-29-orgs-roles-teams.md`.

## Global Constraints

- Out of scope: session passes (`/v1/sessions`, `PASS_SIGNING_KEY`, relay pass checks), desktop sign-in and the device-link signature fix, the MCP endpoint and tools. `agent_rooms` is untouched. The MCP setup snippets (`web/lib/agent-setup.js`) go away with the old dashboard flow; the MCP plan brings its own.
- Identity: the agent's Ed25519 key in the desktop app's format (`generateIdentity()` in `src/identity.js`: public key = SPKI DER, base64url; private key = PKCS8 DER, base64url). The API never holds an agent's private key.
- Registration: `POST /v1/agents/register { name, publicKey }`, no account needed, rate-limited per IP like device start (`fly-client-ip` when `QUILT_TRUST_PROXY=1`; default **10 per minute**). `name` = `cleanName(name, 40)`; `publicKey` must pass `parsePublicKey`. Response `{ requestId, userCode, approveUrl, interval: 5, expiresIn: 900 }` with `approveUrl` = `${siteUrl}/agents/approve?code=${userCode}`. Requests expire **15 minutes** after creation. `requestId` = `qg_` + 32 random bytes (base64url), stored only as its SHA-256 hash (`request_hash`). User codes come from `newUserCode`/`normalizeUserCode` (`XXXX-XXXX`, alphabet without 0/O/1/I/L).
- Poll: `POST /v1/agents/register/poll { requestId, signature }`. The signature is Ed25519 over `quilt-agent-register-v1` + `\0` + requestId (`signAgentRegister`, context constant `AGENT_REGISTER_CONTEXT = 'quilt-agent-register-v1'`), checked against the registration's `public_key` on every poll (401 if missing or wrong). 404 unknown request; 202 `{ status: 'pending' }` while pending/approving; 403 denied; 410 expired or consumed (an approved registration can still be collected until 5 minutes after it expires). On approved: check-and-set `approved` → `consumed`, then mint the first pair and return it once: `{ status: 'approved', agentId, accessKey, accessExpiresAt, refreshKey, refreshExpiresAt }` (epoch ms).
- Approval (signed-in person, user JWT): `GET /v1/agents/register/:code` → `{ name, userCode, expiresAt, publicKeyFingerprint }` (404 unknown code, 410 used/expired). `POST /v1/agents/register/approve { userCode, approve: boolean, destination }` with `destination` = `{ personal: true }` or `{ org: slug, roleId?: uuid|null, teams: [{ teamId, access: 'editor'|'viewer', scopes: [string] }] }`. Org: caller needs **Agents: Create**; any team needs **Team membership: Create**; a `roleId` must pass `assignable()` (subset of the caller's grid, never Owner); no `roleId` = **no role** (team access only); at most 50 teams, each once. Registration statuses: `pending`, `approving`, `approved`, `denied`, `consumed`; approve is CAS `pending` → `approving` → `approved`, deny is CAS `pending` → `denied`. A public key that already belongs to an agent is refused (409) at register and at approve.
- Folders (`scopes`): at most **20** per team membership; each a relative path inside the project: trimmed, leading `./` and trailing `/` removed, no leading `/`, no `\`, no `..` segment, at most **200** characters; duplicates dropped. Only agent members have folders.
- Keys: access key `qa_` + 32 random bytes (base64url), valid **1 hour**; refresh key `qr_` + 32 random bytes, valid **30 days**, single use. Stored only as SHA-256 hashes in `agent_keys` rows, each with a `family_id`. `POST /v1/agents/token { refreshKey }` → a new pair in the same family; the old row's `refreshed_at` is set by CAS (`refreshed_at is null and revoked_at is null`). Presenting a refresh key whose row already has `refreshed_at` revokes every row of that family (`revoked_at`) and returns 401 `This key was already used, so this agent's keys were revoked. Approve it again.` Revoked or expired keys → 401. Revoking an agent revokes all its families. Token refresh is rate-limited per IP (default **30 per minute**).
- Agent auth for later plans: `agentFromRequest(req)` → `{ agent, keyRow }` or 401, from a `qa_` bearer (hash lookup, not expired, not revoked, agent not revoked), touching `last_used_at` at most once a minute. `GET /v1/agents/me` (agent auth) → `{ agent: { id, name, kind: 'personal'|'org', org: { slug, name }|null }, teams: [{ id, name, access, scopes }], role: { name }|null }`.
- Management: `GET /v1/agents` (user) → the caller's live personal agents `[{ id, name, createdAt, lastUsedAt, status: 'active'|'reused'|'expired' }]`; `DELETE /v1/agents/:id` revokes (owner only). Org agents are org members with `kind: 'agent'` in `GET /v1/orgs/:slug/members` (people need Members: Read, agents need Agents: Read). An agent member's role: `PUT /v1/orgs/:slug/members/:id` with **Agents: Update** (subset rule; `roleId: null` allowed). Its team access and folders: the team membership routes with **Team membership: Create/Update**. Removing it: `DELETE /v1/orgs/:slug/members/:id` with **Agents: Delete**, which revokes the agent (no separate revoke route).
- Data model: `agents` = `id, name (1-40 chars), public_key (unique), owner_user_id (→ profiles, cascade) or org_id (→ orgs, cascade), approved_by (→ auth.users, set null), created_at, last_used_at, revoked_at`; `key_prefix`, `key_hash`, `private_key_enc`, `owner_id` dropped. `agent_registrations` and `agent_keys` as in the spec, RLS on, **no client policies or grants**. Clients read personal agents (`owner_user_id = auth.uid()`) and org agents with `has_org_grant(org_id, 'agents', 'r')`; all writes go through the API. Migration: `supabase/migrations/20260930020000_agent_sign_in.sql`.
- Removed: `POST /v1/agents`, `src/api/agent-keys.js`, the `AGENT_KEY_SECRET` requirement and the `agentKeySecret` option, the dashboard's `NewAgent` / `createAgent` flow, `web/lib/agent-setup.js`.
- CLI: `quilt agent login --name <name> [--api <url>]` and `quilt agent whoami --name <name>`; keys saved to `~/.quilt/agents/<name>.json`, mode `0600`; names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`; default API `https://api.heyquilt.com`.
- Website: `/agents/approve?code=…` is private (in `web/proxy.js` `PRIVATE`), uses the normal site `Header` layout like `/link`, and shows the agent's name, code, key fingerprint and the line "Only approve an agent you just started yourself." No em dashes in any user-facing copy (enforced on `web/app` and `web/components` by `web/test/no-em-dash.test.js`); API messages have none either. Existing classes only (`card`, `stack`, `row`, `btn`, `input`, `field`, `pill`, `notice`, `list-row`).
- Infra: Supabase project `pwebomewzuezaxoowykk`; API `https://api.heyquilt.com` (Fly app `quilt-api`, deployed from the main checkout `/Users/danielcarmichael/elegy`); website `https://heyquilt.com` (Netlify site id `b9131760-8605-44f7-b9e1-3b347fc212b0`, deployed from the main checkout).
- API timestamps are epoch ms; Supabase rows are ISO strings (`rowFrom` converts every `*At` column).
- Code style: Node 22 ESM, 2-space indent, no semicolons (`standard`), short comments that explain why; tests with `node:test` and `node:assert/strict`.

---

## File map

| File | Responsibility |
|---|---|
| `src/identity.js` | `AGENT_REGISTER_CONTEXT`, `signAgentRegister`, `verifyAgentRegister`, `keyFingerprint` (new) |
| `supabase/migrations/20260930020000_agent_sign_in.sql` | Reshape `agents`; `agent_registrations`, `agent_keys`; RLS, grants; composite `(agent_id, org_id)` foreign key on `org_members` |
| `src/api/memory-store.js`, `src/api/supabase-store.js` | Agents, agent members, registrations, agent keys; agent names and `kind` in member lists; team folders |
| `src/api/agent-auth.js` | `ACCESS_TTL_MS`, `REFRESH_TTL_MS`, `REUSED`, `keyStatus`, `makeAgentAuth` (`mintKeys`, `refresh`, `agentFromRequest`) |
| `src/api/team-access.js` | `ACCESS`, `accessOf`, `cleanScopes`, `MAX_SCOPES`, `MAX_SCOPE_LENGTH` |
| `src/api/routes/agents.js` | `POST /v1/agents/token`, `GET /v1/agents/me`, `GET /v1/agents`, `DELETE /v1/agents/:id` |
| `src/api/routes/agent-register.js` | `POST /v1/agents/register`, `POST /v1/agents/register/poll`, `GET /v1/agents/register/:code`, `POST /v1/agents/register/approve` |
| `src/api/routes/members.js`, `src/api/routes/teams.js` | Agents in the member list; agent roles; revoking by removal; folders on team membership |
| `src/api/server.js`, `bin/quilt.js`, `fly.api.toml`, `scripts/api-smoke.mjs` | Wiring, limiters; `AGENT_KEY_SECRET` removed; `quilt agent` command |
| `src/agent-login.js` | `agentLogin`, `agentWhoami`, `agentFile`, `describeAgent`, `DEFAULT_API` |
| `src/api/agent-keys.js`, `test/api-agent-keys.test.js` | Deleted |
| `test/api-helpers.js` | Limits for the new limiters; `makeAgent` |
| `test/agent-identity.test.js`, `test/api-migration-agents.test.js`, `test/api-store-agents.test.js`, `test/api-supabase-agents.test.js`, `test/api-agent-tokens.test.js`, `test/api-agent-register.test.js`, `test/api-team-access.test.js`, `test/api-agent-orgs.test.js`, `test/agent-login.test.js` | New tests |
| `test/api.test.js`, `test/api-store.test.js`, `test/api-cli.test.js`, `test/api-teams.test.js`, `test/api-store-orgs.test.js`, `test/api-supabase-orgs.test.js` | Updated for the new agent shape, folders and `kind` |
| `web/lib/agent-form.js`, `web/lib/agent-approve.js`, `web/lib/agent-view.js` | Approval form parsing; approval destinations loader; dashboard status text |
| `web/components/ApproveAgent.js`, `web/app/agents/approve/page.js`, `web/app/agents/approve/actions.js` | The approval page |
| `web/app/dashboard/page.js`, `web/app/dashboard/actions.js`, `web/components/NewAgent.js` (deleted), `web/lib/agent-setup.js` (deleted) | "Your agents" |
| `web/app/org/[slug]/people/*`, `web/app/org/[slug]/teams/page.js`, `web/lib/org-view.js` | Agents on People and Teams; People tab for Agents: Read |
| `web/proxy.js`, `web/test/*` | Private route; tests |

---

### Task 1: Agent registration signatures and key fingerprints

**Files:**
- Modify: `src/identity.js` (append)
- Test: `test/agent-identity.test.js` (create)

**Interfaces:**
- Consumes: `generateIdentity`, `parsePublicKey`, `signChallenge`, `verifyChallenge` (existing, `src/identity.js`).
- Produces:
  - `AGENT_REGISTER_CONTEXT = 'quilt-agent-register-v1'`
  - `signAgentRegister(identity: { privateKey }, requestId: string) -> Uint8Array`
  - `verifyAgentRegister(key: KeyObject|null, requestId: string, signature: Buffer|Uint8Array) -> boolean` (never throws)
  - `keyFingerprint(publicKey: string) -> string` like `"3f9a 0c12 b7e4 5d60"` (first 16 hex chars of SHA-256 of the DER key, in groups of 4)

- [ ] **Step 1: Write the failing test**

Create `test/agent-identity.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateIdentity, parsePublicKey, signChallenge, verifyChallenge, signAgentRegister, verifyAgentRegister, keyFingerprint, AGENT_REGISTER_CONTEXT } from '../src/identity.js'

test('an agent signs its request id under its own context, and only its key verifies', () => {
  assert.equal(AGENT_REGISTER_CONTEXT, 'quilt-agent-register-v1')
  const id = generateIdentity(); const other = generateIdentity()
  const key = parsePublicKey(id.publicKey)
  const sig = signAgentRegister(id, 'qg_abc')
  assert.equal(verifyAgentRegister(key, 'qg_abc', sig), true)
  assert.equal(verifyAgentRegister(key, 'qg_abd', sig), false, 'another request id')
  assert.equal(verifyAgentRegister(parsePublicKey(other.publicKey), 'qg_abc', sig), false, 'another key')
  assert.equal(verifyAgentRegister(key, 'qg_abc', Buffer.from('junk')), false)
  assert.equal(verifyAgentRegister(null, 'qg_abc', sig), false)
})

test('registration signatures and relay signatures never stand in for each other', () => {
  const id = generateIdentity(); const key = parsePublicKey(id.publicKey)
  const relaySig = signChallenge(id, AGENT_REGISTER_CONTEXT, Buffer.from('qg_abc'))
  assert.equal(verifyAgentRegister(key, 'qg_abc', relaySig), false)
  const regSig = signAgentRegister(id, 'qg_abc')
  assert.equal(verifyChallenge(key, AGENT_REGISTER_CONTEXT, Buffer.from('qg_abc'), regSig), false)
})

test('a key fingerprint is short, stable and different per key', () => {
  const a = generateIdentity(); const b = generateIdentity()
  assert.match(keyFingerprint(a.publicKey), /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/)
  assert.equal(keyFingerprint(a.publicKey), keyFingerprint(a.publicKey))
  assert.notEqual(keyFingerprint(a.publicKey), keyFingerprint(b.publicKey))
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/agent-identity.test.js`
Expected: FAIL with `SyntaxError: The requested module '../src/identity.js' does not provide an export named 'signAgentRegister'` (or `AGENT_REGISTER_CONTEXT`).

- [ ] **Step 3: Implement**

Append to `src/identity.js`:

```js

// Agent sign-in signs with its own context, never inside the relay's
// cowove-auth payload: a signature an agent makes to collect its keys can't be
// replayed as a relay login, or the other way round.
export const AGENT_REGISTER_CONTEXT = 'quilt-agent-register-v1'
const contextPayload = (context, message) => Buffer.concat([Buffer.from(`${context}\0`), Buffer.from(String(message))])

/** Signs a registration's request id, proving the poller holds the agent's key. */
export function signAgentRegister (identity, requestId) {
  const key = crypto.createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
  return new Uint8Array(crypto.sign(null, contextPayload(AGENT_REGISTER_CONTEXT, requestId), key))
}

export function verifyAgentRegister (key, requestId, signature) {
  try { return crypto.verify(null, contextPayload(AGENT_REGISTER_CONTEXT, requestId), key, Buffer.from(signature)) } catch { return false }
}

/** A short, readable hash of a public key, e.g. "3f9a 0c12 b7e4 5d60", to compare on two screens. */
export function keyFingerprint (publicKey) {
  const hex = crypto.createHash('sha256').update(Buffer.from(String(publicKey), 'base64url')).digest('hex').slice(0, 16)
  return hex.match(/.{4}/g).join(' ')
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/agent-identity.test.js`
Expected: PASS, `# pass 3`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/identity.js test/agent-identity.test.js
git commit -m "Sign agent registrations under their own context"
```

---

### Task 2: Migration for agent sign-in

**Files:**
- Create: `supabase/migrations/20260930020000_agent_sign_in.sql`
- Test: `test/api-migration-agents.test.js` (create)

**Interfaces:**
- Consumes: `public.agents`, `public.org_members`, `public.profiles`, `public.orgs`, `public.has_org_grant(uuid, text, text)` from the earlier migrations.
- Produces (columns later tasks use through the Supabase store):
  - `agents (id, name, public_key, owner_user_id, org_id, approved_by, created_at, last_used_at, revoked_at)`, unique `(id, org_id)`
  - `agent_registrations (id, request_hash, user_code, public_key, name, status, agent_id, expires_at, created_at)`
  - `agent_keys (id, agent_id, family_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, refreshed_at, revoked_at, created_at)`
  - `org_members_agent_id_fkey` = `(agent_id, org_id) → agents (id, org_id)` on delete cascade (the only `org_members → agents` relationship, so `agents (name)` embeds unambiguously)

- [ ] **Step 1: Write the failing test**

Create `test/api-migration-agents.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const file = new URL('../supabase/migrations/20260930020000_agent_sign_in.sql', import.meta.url)
const sql = () => fs.readFileSync(file, 'utf8')
const table = (s, name) => (s.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`)) || [''])[0]
const clientGrants = (s) => s.split('\n').filter((l) => /^grant\b/.test(l.trim()) && /\b(authenticated|anon)\b/.test(l))

test('agents lose their secrets and static owner, and gain a personal owner or an org', () => {
  const s = sql()
  for (const col of ['key_prefix', 'key_hash', 'private_key_enc', 'owner_id']) assert.match(s, new RegExp(`drop column ${col},?\\n`), col)
  assert.match(s, /add column owner_user_id uuid references public\.profiles \(id\) on delete cascade/)
  assert.match(s, /add column org_id uuid references public\.orgs \(id\) on delete cascade/)
  assert.match(s, /add column approved_by uuid references auth\.users \(id\) on delete set null/)
  assert.match(s, /add constraint agents_one_home check \(\(owner_user_id is null\) <> \(org_id is null\)\)/)
  assert.match(s, /add constraint agents_name_length check \(char_length\(name\) between 1 and 40\)/)
  assert.match(s, /add constraint agents_id_org_id_key unique \(id, org_id\)/)
  assert.ok(s.indexOf('drop policy "own agents: read"') < s.indexOf('drop column owner_id'), 'the old policies go before the column they read')
})

test('an agent member must be in the agent\'s own org', () => {
  const s = sql()
  assert.match(s, /alter table public\.org_members drop constraint org_members_agent_id_fkey;/)
  assert.match(s, /add constraint org_members_agent_id_fkey\s+foreign key \(agent_id, org_id\) references public\.agents \(id, org_id\) on delete cascade/)
})

test('registrations and keys exist with RLS, hashes only, and the spec statuses', () => {
  const s = sql()
  const reg = table(s, 'agent_registrations')
  assert.match(reg, /request_hash text not null unique/)
  assert.match(reg, /user_code text not null unique/)
  assert.match(reg, /status text not null default 'pending' check \(status in \('pending', 'approving', 'approved', 'denied', 'consumed'\)\)/)
  assert.match(reg, /agent_id uuid references public\.agents \(id\) on delete set null/)
  const keys = table(s, 'agent_keys')
  for (const col of ['access_hash text not null unique', 'refresh_hash text not null unique', 'family_id uuid not null', 'access_expires_at timestamptz not null', 'refresh_expires_at timestamptz not null', 'refreshed_at timestamptz', 'revoked_at timestamptz']) assert.ok(keys.includes(col), col)
  assert.match(keys, /agent_id uuid not null references public\.agents \(id\) on delete cascade/)
  for (const t of ['agent_registrations', 'agent_keys']) assert.match(s, new RegExp(`alter table public\\.${t} enable row level security`), t)
  assert.match(s, /grant all on public\.agents, public\.agent_registrations, public\.agent_keys to service_role;/)
})

test('clients never touch registrations or keys, and only read agents', () => {
  const s = sql()
  assert.doesNotMatch(s, /create policy [^\n]*on public\.(agent_registrations|agent_keys)/)
  for (const line of clientGrants(s)) {
    assert.doesNotMatch(line, /agent_registrations|agent_keys|_hash/, line)
    assert.doesNotMatch(line, /^grant (insert|update|delete|all)/, line)
  }
  assert.match(s, /revoke all on public\.agents from anon, authenticated;/)
  assert.match(s, /revoke all on public\.agent_registrations, public\.agent_keys from anon, authenticated;/)
  assert.match(s, /grant select \(id, name, public_key, owner_user_id, org_id, approved_by, created_at, last_used_at, revoked_at\) on public\.agents to authenticated;/)
})

test('people read their personal agents, and org agents with Agents: Read', () => {
  const s = sql()
  const policy = s.match(/create policy "agents: read own and org agents"[\s\S]*?\);/)
  assert.ok(policy, 'one read policy')
  assert.match(policy[0], /\(select auth\.uid\(\)\) = owner_user_id/)
  assert.match(policy[0], /public\.has_org_grant\(org_id, 'agents', 'r'\)/)
  assert.doesNotMatch(s, /create (or replace )?function/, 'no new functions to lock down')
})

test('lookups the API makes are indexed', () => {
  const s = sql()
  for (const idx of ['agents_owner_user_id on public.agents (owner_user_id)', 'agents_org_id on public.agents (org_id)', 'agents_approved_by on public.agents (approved_by)', 'agent_registrations_agent_id on public.agent_registrations (agent_id)', 'agent_keys_agent_id on public.agent_keys (agent_id)', 'agent_keys_family_id on public.agent_keys (family_id)']) {
    assert.ok(s.includes(`create index ${idx}`), idx)
  }
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/api-migration-agents.test.js`
Expected: FAIL with `ENOENT: no such file or directory` for the migration.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260930020000_agent_sign_in.sql`:

```sql
-- Agent sign-in: agents register themselves with their own Ed25519 key and a
-- person approves them into their personal space or an org. The API no longer
-- holds agents' private keys or a static key, so those columns go. No agents
-- exist yet (checked before this runs), so nothing is carried over.

-- The old client policies read owner_id, so they go before the column does.
drop policy "own agents: read" on public.agents;
drop policy "own agents: revoke" on public.agents;

alter table public.agents
  drop column key_prefix,
  drop column key_hash,
  drop column private_key_enc,
  drop column owner_id,
  add column owner_user_id uuid references public.profiles (id) on delete cascade,
  add column org_id uuid references public.orgs (id) on delete cascade,
  add column approved_by uuid references auth.users (id) on delete set null;

-- A personal agent belongs to one person; an org agent to one org. Never both.
alter table public.agents add constraint agents_one_home check ((owner_user_id is null) <> (org_id is null));
alter table public.agents add constraint agents_name_length check (char_length(name) between 1 and 40);
-- Lets org_members take a composite (agent_id, org_id) foreign key.
alter table public.agents add constraint agents_id_org_id_key unique (id, org_id);

create index agents_owner_user_id on public.agents (owner_user_id);
create index agents_org_id on public.agents (org_id);
create index agents_approved_by on public.agents (approved_by);

-- An agent can only be a member of its own org: the plain agent_id foreign key
-- becomes a composite one (like roles and teams), so a personal agent or
-- another org's agent can never be attached to a membership here.
alter table public.org_members drop constraint org_members_agent_id_fkey;
alter table public.org_members add constraint org_members_agent_id_fkey
  foreign key (agent_id, org_id) references public.agents (id, org_id) on delete cascade;

-- People read their personal agents; org agents are read with Agents: Read.
create policy "agents: read own and org agents" on public.agents for select to authenticated using (
  (select auth.uid()) = owner_user_id
  or (org_id is not null and public.has_org_grant(org_id, 'agents', 'r'))
);

-- Reads only. Revoking goes through the API, which also revokes the agent's keys.
revoke all on public.agents from anon, authenticated;
grant select (id, name, public_key, owner_user_id, org_id, approved_by, created_at, last_used_at, revoked_at) on public.agents to authenticated;

create table public.agent_registrations (
  id uuid primary key default gen_random_uuid(),
  request_hash text not null unique,
  user_code text not null unique,
  public_key text not null,
  name text not null check (char_length(name) between 1 and 40),
  status text not null default 'pending' check (status in ('pending', 'approving', 'approved', 'denied', 'consumed')),
  -- Set null, not cascade: the request outlives an agent deleted later (say, with its org).
  agent_id uuid references public.agents (id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index agent_registrations_agent_id on public.agent_registrations (agent_id);

create table public.agent_keys (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  -- Every pair minted by refreshing shares its family; reusing a spent refresh key revokes the family.
  family_id uuid not null,
  access_hash text not null unique,
  refresh_hash text not null unique,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  refreshed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index agent_keys_agent_id on public.agent_keys (agent_id);
create index agent_keys_family_id on public.agent_keys (family_id);

alter table public.agent_registrations enable row level security;
alter table public.agent_keys enable row level security;

-- No client policies or grants: request and key hashes are only for the API.
revoke all on public.agent_registrations, public.agent_keys from anon, authenticated;

-- The API is trusted with everything; don't depend on project default privileges.
grant all on public.agents, public.agent_registrations, public.agent_keys to service_role;
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/api-migration-agents.test.js`
Expected: PASS, `# pass 6`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260930020000_agent_sign_in.sql test/api-migration-agents.test.js
git commit -m "Add the agent sign-in migration"
```

---
### Task 3: Store: the new agent shape, agent members, and retiring the static-key flow

The store's agent methods change shape, so the three old routes that use them are retired in the same task: `POST /v1/agents` goes, and `GET`/`DELETE /v1/agents` move to a new route module on the new methods. `AGENT_KEY_SECRET` and `src/api/agent-keys.js` go with them.

**Files:**
- Modify: `src/api/memory-store.js`, `src/api/supabase-store.js`, `src/api/server.js`, `bin/quilt.js`, `fly.api.toml`, `scripts/api-smoke.mjs`
- Create: `src/api/routes/agents.js`, `test/api-store-agents.test.js`, `test/api-supabase-agents.test.js`
- Delete: `src/api/agent-keys.js`, `test/api-agent-keys.test.js`
- Modify tests: `test/api.test.js`, `test/api-store.test.js`, `test/api-cli.test.js`, `test/api-helpers.js`

**Interfaces:**
- Consumes: the Task 2 columns.
- Produces (both stores; rows are camelCase with epoch-ms `*At`):
  - `createAgent({ name, publicKey, ownerUserId = null, orgId = null, approvedBy = null }) -> Agent` where `Agent = { id, name, publicKey, ownerUserId, orgId, approvedBy, createdAt, lastUsedAt, revokedAt }`; throws `{ code: '23505' }` for a taken public key, `{ code: '23514' }` unless exactly one of `ownerUserId`/`orgId` is set
  - `agentById(id) -> Agent|null`, `agentByPublicKey(publicKey) -> Agent|null`
  - `listPersonalAgents(userId) -> Agent[]` (not revoked, oldest first)
  - `touchAgent(id) -> void` (sets `lastUsedAt` to now)
  - `revokeAgent(id) -> boolean` (true only the first time; also revokes every key row of the agent)
  - `deleteAgent(id) -> void` (cascades to its keys and memberships; its registration keeps a null `agentId`)
  - `addAgentMember({ orgId, agentId, roleId = null }) -> Member` (`{ code: '23503' }` unless the agent is that org's; `{ code: '23505' }` if already in)
  - `memberByAgent(orgId, agentId) -> Member|null`
  - `listMembers(orgId)` names agent members after the agent; `listTeamMembers(teamId)` rows gain `kind: 'person'|'agent'`
  - Memory store keeps the maps `registrations` and `keyRows` (filled by Task 4)
  - `agentRoutes(ctx)` in `src/api/routes/agents.js` with `GET /v1/agents` → `{ agents: [{ id, name, createdAt, lastUsedAt }] }` and `DELETE /v1/agents/:id` (owner only, 404 otherwise); Task 5 rewrites this file
  - `startApi` no longer takes `agentKeySecret`; `quilt api` no longer needs `AGENT_KEY_SECRET`

- [ ] **Step 1: Write the failing store tests**

Create `test/api-store-agents.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/api/memory-store.js'
import { BUILTIN } from '../src/api/permissions.js'

const setup = () => { const s = createMemoryStore(); s.addUser('u1', { name: 'Dana' }); s.addUser('u2', { name: 'Eli' }); return s }
const org = (s, slug = 'acme') => s.createOrg({ name: 'Acme', slug, ownerId: 'u1', grants: BUILTIN })

test('agents belong to one person or one org, and each key only once', async () => {
  const s = setup()
  const o = await org(s)
  const mine = await s.createAgent({ name: 'Larry', publicKey: 'pk1', ownerUserId: 'u1', approvedBy: 'u1' })
  assert.deepEqual([mine.name, mine.ownerUserId, mine.orgId, mine.approvedBy, mine.revokedAt, mine.lastUsedAt], ['Larry', 'u1', null, 'u1', null, null])
  const theirs = await s.createAgent({ name: 'Bot', publicKey: 'pk2', orgId: o.id, approvedBy: 'u1' })
  assert.equal(theirs.orgId, o.id)
  await assert.rejects(s.createAgent({ name: 'Dup', publicKey: 'pk1', ownerUserId: 'u2' }), (err) => err.code === '23505')
  await assert.rejects(s.createAgent({ name: 'Both', publicKey: 'pk3', ownerUserId: 'u1', orgId: o.id }), (err) => err.code === '23514')
  await assert.rejects(s.createAgent({ name: 'Neither', publicKey: 'pk4' }), (err) => err.code === '23514')
  assert.equal((await s.agentById(mine.id)).name, 'Larry')
  assert.equal((await s.agentByPublicKey('pk2')).id, theirs.id)
  assert.equal(await s.agentByPublicKey('nope'), null)
  assert.deepEqual((await s.listPersonalAgents('u1')).map((a) => a.id), [mine.id], 'org agents are not personal')
})

test('touching and revoking an agent; revoked agents leave the personal list', async () => {
  const s = setup()
  const a = await s.createAgent({ name: 'Larry', publicKey: 'pk1', ownerUserId: 'u1', approvedBy: 'u1' })
  await s.touchAgent(a.id)
  assert.ok((await s.agentById(a.id)).lastUsedAt > 0)
  assert.equal(await s.revokeAgent(a.id), true)
  assert.equal(await s.revokeAgent(a.id), false, 'once')
  assert.ok((await s.agentById(a.id)).revokedAt > 0)
  assert.deepEqual(await s.listPersonalAgents('u1'), [])
})

test('org agents join as members with no role, named after the agent, in their own org only', async () => {
  const s = setup()
  const o = await org(s); const other = await org(s, 'other')
  const bot = await s.createAgent({ name: 'Bot', publicKey: 'pk1', orgId: o.id, approvedBy: 'u1' })
  const mine = await s.createAgent({ name: 'Larry', publicKey: 'pk2', ownerUserId: 'u1', approvedBy: 'u1' })
  const m = await s.addAgentMember({ orgId: o.id, agentId: bot.id, roleId: null })
  assert.deepEqual([m.agentId, m.userId, m.roleId], [bot.id, null, null])
  await assert.rejects(s.addAgentMember({ orgId: other.id, agentId: bot.id }), (err) => err.code === '23503')
  await assert.rejects(s.addAgentMember({ orgId: o.id, agentId: mine.id }), (err) => err.code === '23503', 'a personal agent')
  await assert.rejects(s.addAgentMember({ orgId: o.id, agentId: bot.id }), (err) => err.code === '23505', 'once per org')
  assert.equal((await s.memberByAgent(o.id, bot.id)).id, m.id)
  assert.deepEqual((await s.listMembers(o.id)).map((x) => x.name), ['Dana', 'Bot'])
  const team = await s.createTeam({ orgId: o.id, name: 'Core' })
  await s.addTeamMember({ teamId: team.id, memberId: m.id, access: 'viewer' })
  await s.addTeamMember({ teamId: team.id, memberId: (await s.memberOf(o.id, 'u1')).id, access: 'editor' })
  assert.deepEqual((await s.listTeamMembers(team.id)).map((x) => [x.name, x.kind]), [['Bot', 'agent'], ['Dana', 'person']])
})

test('deleting an agent, its org or its person removes it and its membership', async () => {
  const s = setup()
  const o = await org(s)
  const bot = await s.createAgent({ name: 'Bot', publicKey: 'pk1', orgId: o.id, approvedBy: 'u2' })
  await s.addAgentMember({ orgId: o.id, agentId: bot.id })
  await s.deleteAgent(bot.id)
  assert.equal(await s.agentById(bot.id), null)
  assert.equal(await s.memberByAgent(o.id, bot.id), null)
  const bot2 = await s.createAgent({ name: 'Bot', publicKey: 'pk2', orgId: o.id, approvedBy: 'u2' })
  await s.addAgentMember({ orgId: o.id, agentId: bot2.id })
  const larry = await s.createAgent({ name: 'Larry', publicKey: 'pk3', ownerUserId: 'u2', approvedBy: 'u2' })
  await s.deleteUser('u2')
  assert.equal(await s.agentById(larry.id), null, "a person's own agents go with them")
  assert.equal((await s.agentById(bot2.id)).approvedBy, null, 'org agents stay; the approver is forgotten')
  await s.deleteOrg(o.id)
  assert.equal(await s.agentById(bot2.id), null)
})
```

Create `test/api-supabase-agents.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStore } from '../src/api/supabase-store.js'

const ISO = '2026-09-30T00:00:00.000Z'
// A stand-in supabase client: records every query (the table plus the chain of
// calls on it) and answers each with answer(query).
function fakeDb (answer = () => null) {
  const calls = []
  const chain = (q) => new Proxy({}, {
    get (_, op) {
      if (op === 'then') return (res, rej) => Promise.resolve({ data: answer(q), error: null }).then(res, rej)
      return (...args) => { q.ops.push([op, ...args]); return chain(q) }
    }
  })
  const client = { from (table) { const q = { table, ops: [] }; calls.push(q); return chain(q) } }
  return { client, calls }
}
const has = (q, ...call) => q.ops.some((c) => JSON.stringify(c) === JSON.stringify(call))
const agentRow = { id: 'a1', name: 'Larry', public_key: 'pk', owner_user_id: 'u1', org_id: null, approved_by: 'u1', created_at: ISO, last_used_at: null, revoked_at: null }

test('supabase createAgent writes the new columns and selects no secrets', async () => {
  const { client, calls } = fakeDb(() => agentRow)
  const a = await createSupabaseStore({ client }).createAgent({ name: 'Larry', publicKey: 'pk', ownerUserId: 'u1', approvedBy: 'u1' })
  assert.deepEqual([a.id, a.ownerUserId, a.orgId, a.createdAt], ['a1', 'u1', null, Date.parse(ISO)])
  assert.deepEqual(calls[0].ops.find(([op]) => op === 'insert')[1], { name: 'Larry', public_key: 'pk', owner_user_id: 'u1', org_id: null, approved_by: 'u1' })
  assert.equal(calls[0].ops.find(([op]) => op === 'select')[1], 'id, name, public_key, owner_user_id, org_id, approved_by, created_at, last_used_at, revoked_at')
})

test("supabase listPersonalAgents reads only the person's live agents", async () => {
  const { client, calls } = fakeDb(() => [agentRow])
  const [a] = await createSupabaseStore({ client }).listPersonalAgents('u1')
  assert.equal(a.name, 'Larry')
  assert.ok(has(calls[0], 'eq', 'owner_user_id', 'u1'))
  assert.ok(has(calls[0], 'is', 'revoked_at', null))
})

test('supabase revokeAgent revokes the agent once, then every key it holds', async () => {
  const { client, calls } = fakeDb((q) => (q.table === 'agents' ? [{ id: 'a1' }] : null))
  assert.equal(await createSupabaseStore({ client }).revokeAgent('a1'), true)
  assert.deepEqual(calls.map((c) => c.table), ['agents', 'agent_keys'])
  assert.ok(has(calls[0], 'is', 'revoked_at', null))
  assert.ok(has(calls[1], 'eq', 'agent_id', 'a1'))
  assert.ok(has(calls[1], 'is', 'revoked_at', null))
  assert.equal(await createSupabaseStore({ client: fakeDb(() => []).client }).revokeAgent('a1'), false)
})

test('supabase addAgentMember and memberByAgent work on agent_id', async () => {
  const row = { id: 'm2', org_id: 'o1', user_id: null, agent_id: 'a1', role_id: null, joined_at: ISO }
  const { client, calls } = fakeDb(() => row)
  const s = createSupabaseStore({ client })
  const m = await s.addAgentMember({ orgId: 'o1', agentId: 'a1' })
  assert.deepEqual([m.id, m.agentId, m.roleId], ['m2', 'a1', null])
  assert.deepEqual(calls[0].ops.find(([op]) => op === 'insert')[1], { org_id: 'o1', agent_id: 'a1', role_id: null })
  await s.memberByAgent('o1', 'a1')
  assert.ok(has(calls[1], 'eq', 'org_id', 'o1'))
  assert.ok(has(calls[1], 'eq', 'agent_id', 'a1'))
})

test('supabase member lists name agents from the agents table', async () => {
  const { client, calls } = fakeDb((q) => q.table === 'org_members'
    ? [{ id: 'm2', org_id: 'o1', user_id: null, agent_id: 'a1', role_id: null, joined_at: ISO, profiles: null, agents: { name: 'Bot' } }]
    : [{ team_id: 't1', member_id: 'm2', access: 'viewer', scopes: ['src'], added_at: ISO, org_members: { user_id: null, agent_id: 'a1', profiles: null, agents: { name: 'Bot' } } }])
  const s = createSupabaseStore({ client })
  const [m] = await s.listMembers('o1')
  assert.deepEqual([m.name, m.agentId, 'agents' in m, 'profiles' in m], ['Bot', 'a1', false, false])
  assert.match(calls[0].ops.find(([op]) => op === 'select')[1], /agents \(name\)/)
  const [tm] = await s.listTeamMembers('t1')
  assert.deepEqual([tm.name, tm.kind, tm.scopes], ['Bot', 'agent', ['src']])
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/api-store-agents.test.js test/api-supabase-agents.test.js`
Expected: FAIL: `s.agentById is not a function`, `s.listPersonalAgents is not a function`, `s.addAgentMember is not a function` and similar.

- [ ] **Step 3: Implement the memory store**

In `src/api/memory-store.js`:

Delete the now-unused helper line:

```js
const pick = (o, drop) => Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k)))
```

After the line `  const teams = new Map(); const teamMembers = new Map(); const invites = new Map(); const requests = new Map()` add:

```js
  const registrations = new Map(); const keyRows = new Map()
```

Replace

```js
  const dropMember = (id) => {
    members.delete(id)
    for (const [k, tm] of teamMembers) if (tm.memberId === id) teamMembers.delete(k)
  }
```

with

```js
  const dropMember = (id) => {
    members.delete(id)
    for (const [k, tm] of teamMembers) if (tm.memberId === id) teamMembers.delete(k)
  }
  // An org member is a person (named by their profile) or an agent (named when it was approved).
  const memberName = (m) => (m?.agentId ? agents.get(m.agentId)?.name || '' : nameOf(m?.userId))
  // Deleting an agent takes its keys and membership with it, like the cascades in
  // Postgres; its registration only forgets it (on delete set null).
  const dropAgent = (id) => {
    agents.delete(id)
    for (const [k, key] of keyRows) if (key.agentId === id) keyRows.delete(k)
    for (const [k, m] of members) if (m.agentId === id) dropMember(k)
    for (const r of registrations.values()) if (r.agentId === id) r.agentId = null
  }
```

Replace the old agent methods and `deleteUser`:

```js
    async createAgent (a) {
      const row = { id: uuid(), createdAt: now(), lastUsedAt: null, revokedAt: null, ...a }
      agents.set(row.id, row); return pick(row, ['keyHash', 'privateKeyEnc'])
    },
    async agentByKey (h) { const a = [...agents.values()].find((x) => x.keyHash === h && !x.revokedAt); return a ? { ...a } : null },
    async listAgents (ownerId) { return [...agents.values()].filter((a) => a.ownerId === ownerId).map((a) => pick(a, ['keyHash', 'privateKeyEnc'])) },
    async revokeAgent (ownerId, id) {
      const a = agents.get(id)
      if (!a || a.ownerId !== ownerId) return false
      a.revokedAt = now(); return true
    },
    async deleteUser (userId) {
      profiles.delete(userId); users.delete(userId)
      for (const [id, d] of devices) if (d.userId === userId) devices.delete(id)
      for (const [id, a] of agents) if (a.ownerId === userId) agents.delete(id)
      for (const [id, m] of members) if (m.userId === userId) dropMember(id)
      for (const [id, r] of requests) if (r.userId === userId) requests.delete(id)
    },
```

with

```js
    // Agents hold their own private keys; only the public key is kept here.
    // Mirrors agents_one_home (a person's or an org's, never both) and the
    // unique public_key.
    async createAgent ({ name, publicKey, ownerUserId = null, orgId = null, approvedBy = null }) {
      if ((ownerUserId == null) === (orgId == null)) throw Object.assign(new Error('an agent belongs to one person or one org'), { code: '23514' })
      if (all(agents, (a) => a.publicKey === publicKey).length) throw duplicate('agent')
      const row = { id: uuid(), name, publicKey, ownerUserId, orgId, approvedBy, createdAt: now(), lastUsedAt: null, revokedAt: null }
      agents.set(row.id, row); return copy(row)
    },
    async agentById (id) { return copy(agents.get(id)) },
    async agentByPublicKey (publicKey) { return copy(all(agents, (a) => a.publicKey === publicKey)[0]) },
    async listPersonalAgents (userId) {
      return all(agents, (a) => a.ownerUserId === userId && !a.revokedAt).sort((a, b) => a.createdAt - b.createdAt).map(copy)
    },
    async touchAgent (id) { const a = agents.get(id); if (a) a.lastUsedAt = now() },
    // Revoking an agent kills every key it holds at once.
    async revokeAgent (id) {
      const a = agents.get(id)
      if (!a || a.revokedAt) return false
      a.revokedAt = now()
      for (const k of keyRows.values()) if (k.agentId === id && !k.revokedAt) k.revokedAt = now()
      return true
    },
    // Only for undoing a half-finished approval.
    async deleteAgent (id) { dropAgent(id) },
    async deleteUser (userId) {
      profiles.delete(userId); users.delete(userId)
      for (const [id, d] of devices) if (d.userId === userId) devices.delete(id)
      for (const [id, a] of agents) if (a.ownerUserId === userId) dropAgent(id)
      for (const a of agents.values()) if (a.approvedBy === userId) a.approvedBy = null
      for (const [id, m] of members) if (m.userId === userId) dropMember(id)
      for (const [id, r] of requests) if (r.userId === userId) requests.delete(id)
    },
```

In `deleteOrg`, replace

```js
      orgs.delete(id)
      for (const [k, m] of members) if (m.orgId === id) dropMember(k)
```

with

```js
      orgs.delete(id)
      for (const [k, a] of agents) if (a.orgId === id) dropAgent(k)
      for (const [k, m] of members) if (m.orgId === id) dropMember(k)
```

Replace `listMembers`:

```js
    async listMembers (orgId) { return all(members, (m) => m.orgId === orgId).map((m) => ({ ...copy(m), name: nameOf(m.userId) })).sort((a, b) => a.joinedAt - b.joinedAt) },
```

with

```js
    async listMembers (orgId) { return all(members, (m) => m.orgId === orgId).map((m) => ({ ...copy(m), name: memberName(m) })).sort((a, b) => a.joinedAt - b.joinedAt) },
```

Replace `async removeMember (id) { dropMember(id) },` with

```js
    async removeMember (id) { dropMember(id) },
    // Mirrors the composite (agent_id, org_id) foreign key: only the org's own agents join it.
    async addAgentMember ({ orgId, agentId, roleId = null }) {
      if (agents.get(agentId)?.orgId !== orgId) throw fkViolation('agent', 'is not in this org')
      if (!roleInOrg(roleId, orgId)) throw fkViolation('role')
      if (all(members, (m) => m.orgId === orgId && m.agentId === agentId).length) throw duplicate('member')
      const m = { id: uuid(), orgId, userId: null, agentId, roleId, joinedAt: now() }
      members.set(m.id, m); return copy(m)
    },
    async memberByAgent (orgId, agentId) { return copy(all(members, (m) => m.orgId === orgId && m.agentId === agentId)[0]) },
```

Replace `listTeamMembers`:

```js
    async listTeamMembers (teamId) {
      return all(teamMembers, (tm) => tm.teamId === teamId).sort((a, b) => a.addedAt - b.addedAt)
        .map((tm) => ({ ...copy(tm), name: nameOf(members.get(tm.memberId)?.userId) }))
    },
```

with

```js
    async listTeamMembers (teamId) {
      return all(teamMembers, (tm) => tm.teamId === teamId).sort((a, b) => a.addedAt - b.addedAt)
        .map((tm) => {
          const m = members.get(tm.memberId)
          return { ...copy(tm), name: memberName(m), kind: m?.agentId ? 'agent' : 'person' }
        })
    },
```

- [ ] **Step 4: Implement the Supabase store**

In `src/api/supabase-store.js`, replace

```js
const SAFE_AGENT = 'id, owner_id, name, key_prefix, public_key, created_at, last_used_at, revoked_at'
```

with

```js
// No secrets live on agents any more; the columns are still named, like every other table.
const AGENT = 'id, name, public_key, owner_user_id, org_id, approved_by, created_at, last_used_at, revoked_at'
```

Replace the old agent methods:

```js
    async createAgent (a) { return rowFrom(await one(db.from('agents').insert(toSnake(a)).select(SAFE_AGENT).single())) },
    async agentByKey (h) { return rowFrom(await one(db.from('agents').select().eq('key_hash', h).is('revoked_at', null).maybeSingle())) },
    async listAgents (ownerId) { return (await one(db.from('agents').select(SAFE_AGENT).eq('owner_id', ownerId).order('created_at'))).map(rowFrom) },
    async revokeAgent (ownerId, id) {
      const rows = await one(db.from('agents').update({ revoked_at: new Date().toISOString() }).eq('id', id).eq('owner_id', ownerId).select('id'))
      return rows.length > 0
    },
```

with

```js
    async createAgent ({ name, publicKey, ownerUserId = null, orgId = null, approvedBy = null }) {
      return rowFrom(await one(db.from('agents')
        .insert({ name, public_key: publicKey, owner_user_id: ownerUserId, org_id: orgId, approved_by: approvedBy })
        .select(AGENT).single()))
    },
    async agentById (id) { return rowFrom(await one(db.from('agents').select(AGENT).eq('id', id).maybeSingle())) },
    async agentByPublicKey (publicKey) { return rowFrom(await one(db.from('agents').select(AGENT).eq('public_key', publicKey).maybeSingle())) },
    async listPersonalAgents (userId) {
      return (await one(db.from('agents').select(AGENT).eq('owner_user_id', userId).is('revoked_at', null).order('created_at'))).map(rowFrom)
    },
    async touchAgent (id) { await one(db.from('agents').update({ last_used_at: new Date().toISOString() }).eq('id', id)) },
    // Revoking an agent kills every key it holds at once.
    async revokeAgent (id) {
      const at = new Date().toISOString()
      const rows = await one(db.from('agents').update({ revoked_at: at }).eq('id', id).is('revoked_at', null).select('id'))
      await one(db.from('agent_keys').update({ revoked_at: at }).eq('agent_id', id).is('revoked_at', null))
      return rows.length > 0
    },
    // Only for undoing a half-finished approval; cascades to its keys and membership.
    async deleteAgent (id) { await one(db.from('agents').delete().eq('id', id)) },
```

Replace `listMembers`:

```js
    async listMembers (orgId) {
      const rows = await one(db.from('org_members').select(`${MEMBER}, profiles (name)`).eq('org_id', orgId).order('joined_at'))
      return rows.map(({ profiles, ...r }) => ({ ...rowFrom(r), name: profiles?.name || '' }))
    },
```

with

```js
    // A member is a person (profiles) or an agent (agents); each row embeds whichever it is.
    async listMembers (orgId) {
      const rows = await one(db.from('org_members').select(`${MEMBER}, profiles (name), agents (name)`).eq('org_id', orgId).order('joined_at'))
      return rows.map(({ profiles, agents, ...r }) => ({ ...rowFrom(r), name: profiles?.name || agents?.name || '' }))
    },
```

Replace `async removeMember (id) { await one(db.from('org_members').delete().eq('id', id)) },` with

```js
    async removeMember (id) { await one(db.from('org_members').delete().eq('id', id)) },
    // The composite (agent_id, org_id) foreign key keeps other orgs' and personal agents out.
    async addAgentMember ({ orgId, agentId, roleId = null }) {
      return rowFrom(await one(db.from('org_members').insert({ org_id: orgId, agent_id: agentId, role_id: roleId }).select(MEMBER).single()))
    },
    async memberByAgent (orgId, agentId) { return rowFrom(await one(db.from('org_members').select(MEMBER).eq('org_id', orgId).eq('agent_id', agentId).maybeSingle())) },
```

Replace `listTeamMembers`:

```js
    async listTeamMembers (teamId) {
      const rows = await one(db.from('team_members').select(`${TEAM_MEMBER}, org_members (user_id, profiles (name))`).eq('team_id', teamId).order('added_at'))
      return rows.map(({ org_members: m, ...r }) => ({ ...rowFrom(r), name: m?.profiles?.name || '' }))
    },
```

with

```js
    async listTeamMembers (teamId) {
      const rows = await one(db.from('team_members').select(`${TEAM_MEMBER}, org_members (user_id, agent_id, profiles (name), agents (name))`).eq('team_id', teamId).order('added_at'))
      return rows.map(({ org_members: m, ...r }) => ({ ...rowFrom(r), name: m?.profiles?.name || m?.agents?.name || '', kind: m?.agent_id ? 'agent' : 'person' }))
    },
```

- [ ] **Step 5: Run the store tests**

Run: `node --test test/api-store-agents.test.js test/api-supabase-agents.test.js test/api-store-orgs.test.js test/api-supabase-orgs.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Retire the old routes and secret; move personal agents to a route module**

Create `src/api/routes/agents.js`:

```js
// A person's personal agents. (Task 5 adds the agents' own key and /me routes.)
import { HttpError, needId } from '../http.js'

const agentView = (a) => ({ id: a.id, name: a.name, createdAt: a.createdAt, lastUsedAt: a.lastUsedAt })

export function agentRoutes ({ store, user }) {
  return [
    ['GET', /^\/v1\/agents$/, async (req) => {
      const u = await user(req)
      return { agents: (await store.listPersonalAgents(u.userId)).map(agentView) }
    }],

    ['DELETE', /^\/v1\/agents\/([^/]+)$/, async (req, body, [id]) => {
      const u = await user(req)
      const agent = await store.agentById(needId(id, 'agent'))
      // Someone else's agent gets the same answer as a missing one.
      if (!agent || agent.ownerUserId !== u.userId || agent.revokedAt) throw new HttpError(404, 'no such agent')
      await store.revokeAgent(agent.id)
      return { ok: true }
    }]
  ]
}
```

In `src/api/server.js`:

- Delete `import { newAgentIdentity } from './agent-keys.js'`.
- Change `import { HttpError, UUID } from './http.js'` to `import { HttpError } from './http.js'`.
- After `import { inviteRoutes } from './routes/invites.js'` add `import { agentRoutes } from './routes/agents.js'`.
- In the `startApi` parameter list, delete `agentKeySecret, ` (so it reads `startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, siteUrl, mailer = …`).
- Replace the end of the routes array:

```js
      await store.deleteUser(u.userId)
      return { ok: true }
    }],

    ['POST', /^\/v1\/agents$/, async (req, body) => {
      const u = await user(req)
      const name = String(body.name || '').trim().slice(0, 40)
      if (!name) throw new HttpError(400, 'give the agent a name')
      const key = newToken('qa_')
      const agent = await store.createAgent({ ownerId: u.userId, name, keyPrefix: key.slice(0, 8), keyHash: hashToken(key), ...newAgentIdentity(agentKeySecret) })
      return { agent, key }
    }],

    ['GET', /^\/v1\/agents$/, async (req) => {
      const u = await user(req)
      return { agents: await store.listAgents(u.userId) }
    }],

    ['DELETE', /^\/v1\/agents\/([^/]+)$/, async (req, body, [id]) => {
      const u = await user(req)
      // Agent ids are uuids; anything else can't exist (and Postgres would reject it).
      if (!UUID.test(id) || !await store.revokeAgent(u.userId, id)) throw new HttpError(404, 'no such agent')
      return { ok: true }
    }]
  ]
```

with

```js
      await store.deleteUser(u.userId)
      return { ok: true }
    }]
  ]
```

- Change `routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx))` to `routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx), ...agentRoutes(ctx))`.

Delete the old key module and its test:

```bash
git rm src/api/agent-keys.js test/api-agent-keys.test.js
```

In `bin/quilt.js` `apiCmd()`:

- Change `for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'AGENT_KEY_SECRET', 'QUILT_SITE_URL', 'SMTP_URL', 'SMTP_FROM'])` to `for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'QUILT_SITE_URL', 'SMTP_URL', 'SMTP_FROM'])`.
- Delete these lines:

```js
    // It encrypts every agent's private key, so it must be a real random key.
    const secret = env.AGENT_KEY_SECRET.trim()
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(secret) || Buffer.from(secret, 'base64').length < 32) {
      fail('AGENT_KEY_SECRET must be at least 32 random bytes, base64-encoded; make one with: openssl rand -base64 32')
    }
```

- Change `siteUrl: env.QUILT_SITE_URL || 'http://localhost:3000', agentKeySecret: env.AGENT_KEY_SECRET || 'dev-only-secret',` to `siteUrl: env.QUILT_SITE_URL || 'http://localhost:3000',`.

In `fly.api.toml`, change the secrets comment line to:

```toml
#   fly secrets set --app quilt-api SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… QUILT_SITE_URL=… SMTP_URL=smtp://… SMTP_FROM="Quilt <invites@…>"
```

In `scripts/api-smoke.mjs`, replace

```js
const ag = await call('POST', '/v1/agents', { name: 'smoke agent' }, JWT); ok(ag.b?.key?.startsWith('qa_'), 'agent created')
ok((await call('DELETE', `/v1/agents/${ag.b.agent.id}`, null, JWT)).s === 200, 'agent revoked')
```

with

```js
ok(Array.isArray((await call('GET', '/v1/agents', null, JWT)).b?.agents), 'agents listed')
```

- [ ] **Step 7: Update the existing tests**

Remove the `agentKeySecret` option everywhere tests pass it:

```bash
sed -i '' "s/, agentKeySecret: '[^']*'//" test/api.test.js test/api-helpers.js
```

In `test/api.test.js`, replace the whole test `'agents: created by their owner with a key shown once, listed without secrets, revoked'` with:

```js
test('personal agents: listed for their owner, revoked only by them; the website no longer makes agents', async () => {
  const a = await store.createAgent({ name: 'Larry', publicKey: generateIdentity().publicKey, ownerUserId: 'u1', approvedBy: 'u1' })
  const list = await call('GET', '/v1/agents', null, 'user:u1')
  assert.deepEqual(list.body.agents.map((x) => [x.id, x.name]), [[a.id, 'Larry']])
  assert.equal((await call('GET', '/v1/agents', null, 'user:u2')).body.agents.length, 0)
  assert.equal((await call('DELETE', `/v1/agents/${a.id}`, null, 'user:u2')).status, 404)
  assert.equal((await call('DELETE', `/v1/agents/${a.id}`, null, 'user:u1')).status, 200)
  assert.equal((await call('DELETE', `/v1/agents/${a.id}`, null, 'user:u1')).status, 404, 'already revoked')
  assert.equal((await call('GET', '/v1/agents', null, 'user:u1')).body.agents.length, 0)
  assert.equal((await call('POST', '/v1/agents', { name: 'x' }, 'user:u1')).status, 404)
  assert.equal((await call('GET', '/v1/agents')).status, 401)
})
```

In the test `'odd bodies and paths are 400s, not 500s'`, delete the line:

```js
    assert.equal((await via('POST', '/v1/agents', 'null', 'user:u1')).status, 400)
```

In `test/api-store.test.js`, replace the test `'profiles, and agents only their owner can list or revoke'` with:

```js
test('profiles are read and edited', async () => {
  const s = createMemoryStore()
  s.addUser('u1', { name: 'Dana' })
  assert.equal((await s.profile('u1')).name, 'Dana')
  assert.equal((await s.updateProfile('u1', { color: '#123456', tool: 'Cursor' })).tool, 'Cursor')
})
```

and in the test `'deleting a user removes their profile, computers and agents'`, replace

```js
  await s.createAgent({ ownerId: 'gone', name: 'A', keyPrefix: 'qa_xxxxx', keyHash: 'k-gone', publicKey: 'apk-gone', privateKeyEnc: 'e' })
```

with

```js
  const a = await s.createAgent({ name: 'A', publicKey: 'apk-gone', ownerUserId: 'gone', approvedBy: 'gone' })
```

and replace `assert.equal(await s.agentByKey('k-gone'), null)` with `assert.equal(await s.agentById(a.id), null)`.

In `test/api-cli.test.js`, replace the two tests `'quilt api refuses a weak AGENT_KEY_SECRET'` and `'quilt api accepts a 32-byte base64 AGENT_KEY_SECRET'` with:

```js
test('quilt api starts without AGENT_KEY_SECRET: agents hold their own keys now', async () => {
  const { out } = await run(['--port', '0', '--host', '127.0.0.1'], prodEnv)
  assert.match(out, /listening on/)
})
```

and in `'quilt api refuses to start without SMTP settings, since invites need email'` change `const env = { ...prodEnv, AGENT_KEY_SECRET: Buffer.alloc(32, 7).toString('base64') }` to `const env = { ...prodEnv }`.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS, `# fail 0`. `grep -rn "agentKeySecret\|AGENT_KEY_SECRET\|agent-keys\|agentByKey\|listAgents" src bin test scripts` prints nothing.

- [ ] **Step 9: Commit**

```bash
git add -A src/api bin/quilt.js fly.api.toml scripts/api-smoke.mjs test
git commit -m "Reshape agents in the stores and retire the static agent key"
```

---

### Task 4: Store: registrations, agent keys and team folders

**Files:**
- Modify: `src/api/memory-store.js`, `src/api/supabase-store.js`
- Test: `test/api-store-agents.test.js`, `test/api-supabase-agents.test.js` (append); `test/api-store-orgs.test.js`, `test/api-supabase-orgs.test.js` (update)

**Interfaces:**
- Consumes: Task 3's `registrations` and `keyRows` maps and `createAgent`/`revokeAgent`.
- Produces (both stores):
  - `createRegistration({ requestHash, userCode, publicKey, name, expiresAt }) -> Registration` where `Registration = { id, requestHash, userCode, publicKey, name, status: 'pending', agentId: null, expiresAt, createdAt }`
  - `registrationByRequest(hash) -> Registration|null`, `registrationByUserCode(code) -> Registration|null`
  - `updateRegistration(id, patch) -> Registration` (patch may hold `status`, `agentId`, `expiresAt`)
  - `claimRegistration(id, fromStatus, toStatus) -> boolean` (check-and-set)
  - `createAgentKeys({ agentId, familyId, accessHash, refreshHash, accessExpiresAt, refreshExpiresAt }) -> KeyRow` where `KeyRow = { id, agentId, familyId, accessHash, refreshHash, accessExpiresAt, refreshExpiresAt, refreshedAt: null, revokedAt: null, createdAt }`
  - `agentKeyByAccess(hash) -> KeyRow|null`, `agentKeyByRefresh(hash) -> KeyRow|null`, `listAgentKeys(agentId) -> KeyRow[]`
  - `claimRefresh(id) -> boolean` (sets `refreshedAt` only if unset and not revoked)
  - `revokeFamily(familyId) -> void`
  - `addTeamMember({ teamId, memberId, access, scopes = [] })`; `setTeamAccess(teamId, memberId, access, scopes?)` (folders unchanged when `scopes` is `undefined`); `teamsOfMember(memberId) -> [{ teamId, access, scopes }]`

- [ ] **Step 1: Write the failing tests**

Append to `test/api-store-agents.test.js`:

```js
test('registrations: found by request hash and by code; a claim moves them on once', async () => {
  const s = setup()
  const r = await s.createRegistration({ requestHash: 'rh', userCode: 'AAAA-BBBB', publicKey: 'pk', name: 'Larry', expiresAt: Date.now() + 1000 })
  assert.deepEqual([r.status, r.agentId], ['pending', null])
  assert.equal((await s.registrationByRequest('rh')).id, r.id)
  assert.equal((await s.registrationByUserCode('AAAA-BBBB')).id, r.id)
  assert.equal(await s.registrationByRequest('nope'), null)
  assert.equal(await s.claimRegistration(r.id, 'pending', 'approving'), true)
  assert.equal(await s.claimRegistration(r.id, 'pending', 'approving'), false)
  assert.equal((await s.updateRegistration(r.id, { status: 'approved', agentId: 'a1' })).agentId, 'a1')
})

test('agent keys: found by either hash; a refresh key is spent once; a family is revoked together', async () => {
  const s = setup()
  const a = await s.createAgent({ name: 'Larry', publicKey: 'pk1', ownerUserId: 'u1', approvedBy: 'u1' })
  const t = Date.now()
  const pair = (familyId, n) => s.createAgentKeys({ agentId: a.id, familyId, accessHash: `a${n}`, refreshHash: `r${n}`, accessExpiresAt: t + 1000, refreshExpiresAt: t + 2000 })
  const k1 = await pair('f1', 1)
  assert.deepEqual([k1.refreshedAt, k1.revokedAt], [null, null])
  assert.equal((await s.agentKeyByAccess('a1')).id, k1.id)
  assert.equal((await s.agentKeyByRefresh('r1')).id, k1.id)
  assert.equal(await s.claimRefresh(k1.id), true)
  assert.equal(await s.claimRefresh(k1.id), false, 'spent')
  const k2 = await pair('f1', 2)
  await pair('f2', 3)
  await s.revokeFamily('f1')
  assert.ok((await s.agentKeyByAccess('a2')).revokedAt > 0)
  assert.equal(await s.claimRefresh(k2.id), false, 'revoked keys are never spent')
  assert.equal((await s.agentKeyByAccess('a3')).revokedAt, null, 'another family is untouched')
  assert.equal((await s.listAgentKeys(a.id)).length, 3)
  await assert.rejects(s.createAgentKeys({ agentId: 'nope', familyId: 'f', accessHash: 'x', refreshHash: 'y', accessExpiresAt: t, refreshExpiresAt: t }), (err) => err.code === '23503')
  await s.revokeAgent(a.id)
  assert.ok((await s.agentKeyByAccess('a3')).revokedAt > 0, 'revoking the agent revokes every family')
})

test('team members carry folders: set on add, changed with access, and listed per member', async () => {
  const s = setup()
  const o = await org(s)
  const bot = await s.createAgent({ name: 'Bot', publicKey: 'pk1', orgId: o.id, approvedBy: 'u1' })
  const m = await s.addAgentMember({ orgId: o.id, agentId: bot.id })
  const team = await s.createTeam({ orgId: o.id, name: 'Core' })
  await s.addTeamMember({ teamId: team.id, memberId: m.id, access: 'editor', scopes: ['src', 'docs'] })
  assert.deepEqual(await s.teamsOfMember(m.id), [{ teamId: team.id, access: 'editor', scopes: ['src', 'docs'] }])
  assert.deepEqual((await s.setTeamAccess(team.id, m.id, 'viewer')).scopes, ['src', 'docs'], 'folders stay unless given')
  assert.deepEqual((await s.setTeamAccess(team.id, m.id, 'viewer', ['web'])).scopes, ['web'])
  await assert.rejects(s.setTeamAccess(team.id, m.id, 'viewer', Array.from({ length: 21 }, (_, i) => `d${i}`)), (err) => err.code === '23514')
})
```

Append to `test/api-supabase-agents.test.js`:

```js
test('supabase registrations: hashed lookups, ISO expiry, and a check-and-set claim', async () => {
  const reg = { id: 'r1', request_hash: 'rh', user_code: 'AAAA-BBBB', public_key: 'pk', name: 'Larry', status: 'pending', agent_id: null, expires_at: ISO, created_at: ISO }
  const { client, calls } = fakeDb((q) => (q.ops.some(([op]) => op === 'update') ? [{ id: 'r1' }] : reg))
  const s = createSupabaseStore({ client })
  const made = await s.createRegistration({ requestHash: 'rh', userCode: 'AAAA-BBBB', publicKey: 'pk', name: 'Larry', expiresAt: Date.parse(ISO) })
  assert.equal(made.expiresAt, Date.parse(ISO))
  assert.equal(calls[0].ops.find(([op]) => op === 'insert')[1].expires_at, ISO)
  await s.registrationByRequest('rh')
  assert.ok(has(calls[1], 'eq', 'request_hash', 'rh'))
  await s.registrationByUserCode('AAAA-BBBB')
  assert.ok(has(calls[2], 'eq', 'user_code', 'AAAA-BBBB'))
  assert.equal(await s.claimRegistration('r1', 'pending', 'approving'), true)
  assert.ok(has(calls[3], 'update', { status: 'approving' }))
  assert.ok(has(calls[3], 'eq', 'status', 'pending'))
})

test('supabase agent keys: ISO expiries, a refresh spent once, a family revoked together', async () => {
  const key = { id: 'k1', agent_id: 'a1', family_id: 'f1', access_hash: 'ah', refresh_hash: 'rh', access_expires_at: ISO, refresh_expires_at: ISO, refreshed_at: null, revoked_at: null, created_at: ISO }
  const { client, calls } = fakeDb((q) => (q.ops.some(([op]) => op === 'update') ? [{ id: 'k1' }] : key))
  const s = createSupabaseStore({ client })
  const k = await s.createAgentKeys({ agentId: 'a1', familyId: 'f1', accessHash: 'ah', refreshHash: 'rh', accessExpiresAt: Date.parse(ISO), refreshExpiresAt: Date.parse(ISO) })
  assert.deepEqual([k.accessExpiresAt, k.refreshedAt], [Date.parse(ISO), null])
  const insert = calls[0].ops.find(([op]) => op === 'insert')[1]
  assert.deepEqual([insert.access_expires_at, insert.refresh_expires_at, insert.family_id], [ISO, ISO, 'f1'])
  await s.agentKeyByAccess('ah')
  assert.ok(has(calls[1], 'eq', 'access_hash', 'ah'))
  await s.agentKeyByRefresh('rh')
  assert.ok(has(calls[2], 'eq', 'refresh_hash', 'rh'))
  assert.equal(await s.claimRefresh('k1'), true)
  assert.ok(has(calls[3], 'is', 'refreshed_at', null))
  assert.ok(has(calls[3], 'is', 'revoked_at', null))
  await s.revokeFamily('f1')
  assert.ok(has(calls[4], 'eq', 'family_id', 'f1'))
  assert.ok(has(calls[4], 'is', 'revoked_at', null))
})

test('supabase setTeamAccess changes folders only when given; teamsOfMember returns them', async () => {
  const { client, calls } = fakeDb((q) => (q.ops.some(([op]) => op === 'update')
    ? { team_id: 't1', member_id: 'm1', access: 'viewer', scopes: ['src'], added_at: ISO }
    : [{ team_id: 't1', access: 'viewer', scopes: ['src'] }]))
  const s = createSupabaseStore({ client })
  await s.setTeamAccess('t1', 'm1', 'viewer')
  assert.ok(has(calls[0], 'update', { access: 'viewer' }))
  await s.setTeamAccess('t1', 'm1', 'viewer', ['src'])
  assert.ok(has(calls[1], 'update', { access: 'viewer', scopes: ['src'] }))
  assert.deepEqual(await s.teamsOfMember('m1'), [{ teamId: 't1', access: 'viewer', scopes: ['src'] }])
})
```

In `test/api-store-orgs.test.js`, change

```js
  assert.deepEqual(await s.teamsOfMember(dana.id), [{ teamId: web.id, access: 'editor' }])
```

to

```js
  assert.deepEqual(await s.teamsOfMember(dana.id), [{ teamId: web.id, access: 'editor', scopes: [] }])
```

In `test/api-supabase-orgs.test.js`, change

```js
  assert.deepEqual(upsert[1], { team_id: 't1', member_id: 'm1', access: 'editor', org_id: 'o1' })
```

to

```js
  assert.deepEqual(upsert[1], { team_id: 't1', member_id: 'm1', access: 'editor', scopes: [], org_id: 'o1' })
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/api-store-agents.test.js test/api-supabase-agents.test.js test/api-store-orgs.test.js test/api-supabase-orgs.test.js`
Expected: FAIL: `s.createRegistration is not a function`, `s.createAgentKeys is not a function`, and the two `scopes` deepEqual mismatches.

- [ ] **Step 3: Implement the memory store**

In `src/api/memory-store.js`, after the `fkViolation` helper at the top, add:

```js
// Postgres's check-violation code, mirrored for team_members' 20-folder limit.
const tooManyFolders = (scopes) => {
  if (scopes.length > 20) throw Object.assign(new Error('at most 20 folders'), { code: '23514' })
}
```

After `async deleteAgent (id) { dropAgent(id) },` add:

```js
    // Agent registrations: only the request id's hash is kept.
    async createRegistration (r) {
      const row = { id: uuid(), status: 'pending', agentId: null, createdAt: now(), ...r }
      registrations.set(row.id, row); return copy(row)
    },
    async registrationByRequest (h) { return copy(all(registrations, (r) => r.requestHash === h)[0]) },
    async registrationByUserCode (c) { return copy(all(registrations, (r) => r.userCode === c)[0]) },
    async updateRegistration (id, patch) { const r = registrations.get(id); Object.assign(r, patch); return copy(r) },
    // Check-and-set, like claimLink: only one caller moves a registration on from fromStatus.
    async claimRegistration (id, fromStatus, toStatus) {
      const r = registrations.get(id)
      if (!r || r.status !== fromStatus) return false
      r.status = toStatus; return true
    },

    // Agent keys: hashes only.
    async createAgentKeys (k) {
      if (!agents.has(k.agentId)) throw fkViolation('agent', 'does not exist')
      const row = { id: uuid(), refreshedAt: null, revokedAt: null, createdAt: now(), ...k }
      keyRows.set(row.id, row); return copy(row)
    },
    async agentKeyByAccess (h) { return copy(all(keyRows, (k) => k.accessHash === h)[0]) },
    async agentKeyByRefresh (h) { return copy(all(keyRows, (k) => k.refreshHash === h)[0]) },
    async listAgentKeys (agentId) { return all(keyRows, (k) => k.agentId === agentId).map(copy) },
    // Check-and-set: a refresh key is spent once, and never after it was revoked.
    async claimRefresh (id) {
      const k = keyRows.get(id)
      if (!k || k.refreshedAt || k.revokedAt) return false
      k.refreshedAt = now(); return true
    },
    async revokeFamily (familyId) {
      for (const k of keyRows.values()) if (k.familyId === familyId && !k.revokedAt) k.revokedAt = now()
    },
```

Replace `teamsOfMember`:

```js
    async teamsOfMember (memberId) {
      return all(teamMembers, (tm) => tm.memberId === memberId).map((tm) => ({ teamId: tm.teamId, access: tm.access }))
    },
```

with

```js
    async teamsOfMember (memberId) {
      return all(teamMembers, (tm) => tm.memberId === memberId).map((tm) => ({ teamId: tm.teamId, access: tm.access, scopes: [...tm.scopes] }))
    },
```

Replace `addTeamMember` and `setTeamAccess`:

```js
    async addTeamMember ({ teamId, memberId, access }) {
      const team = teams.get(teamId)
      const member = members.get(memberId)
      if (!team || !member || team.orgId !== member.orgId) throw fkViolation('team or member', 'is not in this org')
      const key = `${teamId}:${memberId}`
      const tm = teamMembers.get(key) || { teamId, memberId, scopes: [], addedAt: now() }
      tm.access = access
      teamMembers.set(key, tm); return copy(tm)
    },
    async setTeamAccess (teamId, memberId, access) {
      const tm = teamMembers.get(`${teamId}:${memberId}`)
      if (!tm) return null
      tm.access = access; return copy(tm)
    },
```

with

```js
    async addTeamMember ({ teamId, memberId, access, scopes = [] }) {
      const team = teams.get(teamId)
      const member = members.get(memberId)
      if (!team || !member || team.orgId !== member.orgId) throw fkViolation('team or member', 'is not in this org')
      tooManyFolders(scopes)
      const key = `${teamId}:${memberId}`
      const tm = teamMembers.get(key) || { teamId, memberId, addedAt: now() }
      tm.access = access
      tm.scopes = [...scopes]
      teamMembers.set(key, tm); return copy(tm)
    },
    // Folders only change when given, so an access-only change keeps them.
    async setTeamAccess (teamId, memberId, access, scopes) {
      const tm = teamMembers.get(`${teamId}:${memberId}`)
      if (!tm) return null
      if (scopes !== undefined) tooManyFolders(scopes)
      tm.access = access
      if (scopes !== undefined) tm.scopes = [...scopes]
      return copy(tm)
    },
```

- [ ] **Step 4: Implement the Supabase store**

In `src/api/supabase-store.js`, after the `REQUEST` constant add:

```js
const REGISTRATION = 'id, request_hash, user_code, public_key, name, status, agent_id, expires_at, created_at'
const AGENT_KEY = 'id, agent_id, family_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, refreshed_at, revoked_at, created_at'
```

After `async deleteAgent (id) { await one(db.from('agents').delete().eq('id', id)) },` add:

```js
    // Agent registrations: only the request id's hash is stored.
    async createRegistration (r) {
      return rowFrom(await one(db.from('agent_registrations').insert(toSnake({ ...r, expiresAt: ts(r.expiresAt) })).select(REGISTRATION).single()))
    },
    async registrationByRequest (h) { return rowFrom(await one(db.from('agent_registrations').select(REGISTRATION).eq('request_hash', h).maybeSingle())) },
    async registrationByUserCode (c) { return rowFrom(await one(db.from('agent_registrations').select(REGISTRATION).eq('user_code', c).maybeSingle())) },
    async updateRegistration (id, patch) {
      return rowFrom(await one(db.from('agent_registrations').update(toSnake({ ...patch, expiresAt: ts(patch.expiresAt) })).eq('id', id).select(REGISTRATION).single()))
    },
    // Check-and-set, like claimLink: only one caller moves a registration on from fromStatus.
    async claimRegistration (id, fromStatus, toStatus) {
      const rows = await one(db.from('agent_registrations').update({ status: toStatus }).eq('id', id).eq('status', fromStatus).select('id'))
      return rows.length > 0
    },

    // Agent keys: hashes only.
    async createAgentKeys (k) {
      return rowFrom(await one(db.from('agent_keys')
        .insert(toSnake({ ...k, accessExpiresAt: ts(k.accessExpiresAt), refreshExpiresAt: ts(k.refreshExpiresAt) }))
        .select(AGENT_KEY).single()))
    },
    async agentKeyByAccess (h) { return rowFrom(await one(db.from('agent_keys').select(AGENT_KEY).eq('access_hash', h).maybeSingle())) },
    async agentKeyByRefresh (h) { return rowFrom(await one(db.from('agent_keys').select(AGENT_KEY).eq('refresh_hash', h).maybeSingle())) },
    async listAgentKeys (agentId) { return (await one(db.from('agent_keys').select(AGENT_KEY).eq('agent_id', agentId).order('created_at'))).map(rowFrom) },
    // Check-and-set: a refresh key is spent once, and never after it was revoked.
    async claimRefresh (id) {
      const rows = await one(db.from('agent_keys').update({ refreshed_at: new Date().toISOString() }).eq('id', id).is('refreshed_at', null).is('revoked_at', null).select('id'))
      return rows.length > 0
    },
    async revokeFamily (familyId) {
      await one(db.from('agent_keys').update({ revoked_at: new Date().toISOString() }).eq('family_id', familyId).is('revoked_at', null))
    },
```

Replace `teamsOfMember`:

```js
    async teamsOfMember (memberId) {
      return (await one(db.from('team_members').select('team_id, access').eq('member_id', memberId))).map((r) => ({ teamId: r.team_id, access: r.access }))
    },
```

with

```js
    async teamsOfMember (memberId) {
      return (await one(db.from('team_members').select('team_id, access, scopes').eq('member_id', memberId))).map((r) => ({ teamId: r.team_id, access: r.access, scopes: r.scopes || [] }))
    },
```

In `addTeamMember`, change the signature to `async addTeamMember ({ teamId, memberId, access, scopes = [] }) {` and the upsert row to `{ team_id: teamId, member_id: memberId, access, scopes, org_id: team.org_id }`.

Replace `setTeamAccess`:

```js
    async setTeamAccess (teamId, memberId, access) {
      return rowFrom(await one(db.from('team_members').update({ access }).eq('team_id', teamId).eq('member_id', memberId).select(TEAM_MEMBER).maybeSingle()))
    },
```

with

```js
    // Folders only change when given, so an access-only change keeps them.
    async setTeamAccess (teamId, memberId, access, scopes) {
      return rowFrom(await one(db.from('team_members').update(scopes === undefined ? { access } : { access, scopes })
        .eq('team_id', teamId).eq('member_id', memberId).select(TEAM_MEMBER).maybeSingle()))
    },
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/api/memory-store.js src/api/supabase-store.js test/api-store-agents.test.js test/api-supabase-agents.test.js test/api-store-orgs.test.js test/api-supabase-orgs.test.js
git commit -m "Store agent registrations, key pairs and team folders"
```

---
### Task 5: API: agent keys, refresh with reuse detection, `agentFromRequest` and `/v1/agents/me`

**Files:**
- Create: `src/api/agent-auth.js`, `test/api-agent-tokens.test.js`
- Modify: `src/api/routes/agents.js` (rewrite), `src/api/server.js`, `test/api-helpers.js`

**Interfaces:**
- Consumes: Task 4's key and registration store methods; Task 3's `agentById`, `touchAgent`, `listPersonalAgents`, `revokeAgent`, `memberByAgent`; existing `orgById`, `roleById`, `listTeams`, `teamsOfMember` (now with `scopes`); `newToken`, `hashToken` (`src/api/tokens.js`).
- Produces:
  - `src/api/agent-auth.js`: `ACCESS_TTL_MS = 3_600_000`; `REFRESH_TTL_MS = 2_592_000_000`; `REUSED` (the exact 401 message); `keyStatus(rows: KeyRow[], at: number) -> 'active'|'reused'|'expired'`; `makeAgentAuth({ store, now, bearer }) -> { mintKeys(agentId, familyId?) -> Promise<{ agentId, accessKey, accessExpiresAt, refreshKey, refreshExpiresAt }>, refresh(refreshKey) -> Promise<same>, agentFromRequest(req) -> Promise<{ agent, keyRow }> }`
  - `startApi({ …, tokenLimit = 30 })`; the route context `ctx` gains `limitTokens` and `agentAuth` (later plans use `ctx.agentAuth.agentFromRequest`)
  - Routes: `POST /v1/agents/token`, `GET /v1/agents/me`, `GET /v1/agents` (now with `status`), `DELETE /v1/agents/:id`
  - `test/api-helpers.js`: `makeAgent(t, { name, ownerUserId, orgId, approvedBy, accessTtl, refreshTtl }) -> { agent, accessKey, refreshKey }`

- [ ] **Step 1: Add the test helper and write the failing tests**

In `test/api-helpers.js`, add to the imports:

```js
import crypto from 'node:crypto'
import { generateIdentity } from '../src/identity.js'
import { newToken, hashToken } from '../src/api/tokens.js'
```

change `inviteSendLimit: 1000, mailer` to `inviteSendLimit: 1000, tokenLimit: 1000, mailer`, and append:

```js

/** An approved agent with a working key pair, made straight through the store. */
export async function makeAgent (t, { name = 'Larry', ownerUserId = null, orgId = null, approvedBy = 'owner', accessTtl = 60 * 60 * 1000, refreshTtl = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const agent = await t.store.createAgent({ name, publicKey: generateIdentity().publicKey, ownerUserId, orgId, approvedBy })
  const accessKey = newToken('qa_'); const refreshKey = newToken('qr_')
  const at = Date.now()
  await t.store.createAgentKeys({ agentId: agent.id, familyId: crypto.randomUUID(), accessHash: hashToken(accessKey), refreshHash: hashToken(refreshKey), accessExpiresAt: at + accessTtl, refreshExpiresAt: at + refreshTtl })
  return { agent, accessKey, refreshKey }
}
```

Create `test/api-agent-tokens.test.js`:

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, makeAgent } from './api-helpers.js'
import { keyStatus, REUSED } from '../src/api/agent-auth.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const me = (key) => t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${key}` })
const refresh = (refreshKey) => t.call('POST', '/v1/agents/token', { refreshKey })

test('keyStatus: active while a key can refresh, reused after a family revoke, otherwise expired', () => {
  assert.equal(REUSED, "This key was already used, so this agent's keys were revoked. Approve it again.")
  assert.equal(keyStatus([{ revokedAt: null, refreshExpiresAt: 2000 }], 1000), 'active')
  assert.equal(keyStatus([{ revokedAt: 500, refreshExpiresAt: 2000 }], 1000), 'reused')
  assert.equal(keyStatus([{ revokedAt: null, refreshExpiresAt: 900 }], 1000), 'expired')
  assert.equal(keyStatus([], 1000), 'expired')
})

test('an access key signs a personal agent in; /me says who it is', async () => {
  const { agent, accessKey } = await makeAgent(t, { name: 'Larry', ownerUserId: 'mem' })
  const r = await me(accessKey)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { agent: { id: agent.id, name: 'Larry', kind: 'personal', org: null }, teams: [], role: null })
  assert.ok((await t.store.agentById(agent.id)).lastUsedAt > 0, 'last used is recorded')
  assert.equal((await me('qa_nope')).status, 401)
  assert.equal((await t.call('GET', '/v1/agents/me', null, 'mem')).status, 401, "a person's sign-in is not an agent's")
})

test('last used is written at most once a minute', async () => {
  const { agent, accessKey } = await makeAgent(t, { ownerUserId: 'mem' })
  let touches = 0
  const counting = { ...t.store, touchAgent: async (id) => { touches++; return t.store.touchAgent(id) } }
  const t2 = await startTestApi({ store: counting })
  try {
    for (let i = 0; i < 3; i++) assert.equal((await t2.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${accessKey}` })).status, 200)
  } finally { await t2.close() }
  assert.equal(touches, 1)
  assert.ok((await t.store.agentById(agent.id)).lastUsedAt > 0)
})

test('/me for an org agent lists its org, role and teams with folders', async () => {
  const o = await makeOrg(t, 'Agent Me Co')
  const lead = await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: { teams: { r: true } } })
  const { agent, accessKey } = await makeAgent(t, { name: 'Bot', orgId: o.org.id })
  const m = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id, roleId: lead.id })
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  await t.store.addTeamMember({ teamId: core.id, memberId: m.id, access: 'editor', scopes: ['src'] })
  assert.deepEqual((await me(accessKey)).body, {
    agent: { id: agent.id, name: 'Bot', kind: 'org', org: { slug: o.slug, name: 'Agent Me Co' } },
    teams: [{ id: core.id, name: 'Core', access: 'editor', scopes: ['src'] }],
    role: { name: 'Lead' }
  })
})

test('expired or revoked access keys are refused', async () => {
  const stale = await makeAgent(t, { ownerUserId: 'mem', accessTtl: -1 })
  assert.equal((await me(stale.accessKey)).status, 401)
  const { agent, accessKey } = await makeAgent(t, { ownerUserId: 'mem' })
  await t.store.revokeAgent(agent.id)
  assert.equal((await me(accessKey)).status, 401)
})

test('a refresh key swaps for a new pair once, and the new pair works', async () => {
  const { agent, refreshKey } = await makeAgent(t, { ownerUserId: 'mem' })
  const r = await refresh(refreshKey)
  assert.equal(r.status, 200)
  assert.equal(r.body.agentId, agent.id)
  assert.match(r.body.accessKey, /^qa_[A-Za-z0-9_-]{43}$/)
  assert.match(r.body.refreshKey, /^qr_[A-Za-z0-9_-]{43}$/)
  const at = Date.now()
  assert.ok(Math.abs(r.body.accessExpiresAt - (at + 60 * 60 * 1000)) < 5000, 'access: 1 hour')
  assert.ok(Math.abs(r.body.refreshExpiresAt - (at + 30 * 24 * 60 * 60 * 1000)) < 5000, 'refresh: 30 days')
  assert.equal((await me(r.body.accessKey)).status, 200)
  assert.equal((await refresh(r.body.refreshKey)).status, 200, 'the new refresh key works in turn')
  const rows = await t.store.listAgentKeys(agent.id)
  assert.equal(new Set(rows.map((k) => k.familyId)).size, 1, 'refreshing stays in one family')
  assert.equal(JSON.stringify(rows).includes(r.body.accessKey), false, 'only hashes are stored')
})

test('reusing a spent refresh key revokes the whole family, and the list says so', async () => {
  const { agent, refreshKey } = await makeAgent(t, { name: 'Leaky', ownerUserId: 'lim' })
  const fresh = (await refresh(refreshKey)).body
  const reused = await refresh(refreshKey)
  assert.deepEqual([reused.status, reused.body.error], [401, REUSED])
  assert.equal((await me(fresh.accessKey)).status, 401, 'the newer access key died too')
  assert.equal((await refresh(fresh.refreshKey)).status, 401, 'and the newer refresh key')
  const listed = (await t.call('GET', '/v1/agents', null, 'lim')).body.agents.find((a) => a.id === agent.id)
  assert.equal(listed.status, 'reused')
})

test('two refreshes racing with one key: at most one gets a pair, and no pair survives', async () => {
  const { refreshKey } = await makeAgent(t, { ownerUserId: 'mem' })
  const results = await Promise.all([refresh(refreshKey), refresh(refreshKey)])
  assert.ok(results.some((r) => r.status === 401), 'the second use is a reuse')
  // A copied key means nobody keeps the family, whichever request finished first.
  for (const r of results.filter((x) => x.status === 200)) assert.equal((await me(r.body.accessKey)).status, 401)
})

test('bad, expired and revoked refresh keys are 401s', async () => {
  assert.equal((await t.call('POST', '/v1/agents/token', {})).status, 401)
  assert.equal((await refresh('qr_nope')).status, 401)
  assert.equal((await refresh(42)).status, 401)
  const stale = await makeAgent(t, { ownerUserId: 'mem', refreshTtl: -1 })
  assert.equal((await refresh(stale.refreshKey)).status, 401)
  const gone = await makeAgent(t, { ownerUserId: 'mem' })
  assert.equal((await t.call('DELETE', `/v1/agents/${gone.agent.id}`, null, 'mem')).status, 200)
  assert.equal((await refresh(gone.refreshKey)).status, 401, 'revoking the agent revokes its keys')
})

test('the personal agents list shows when each was added and last used, and its key status', async () => {
  const { agent } = await makeAgent(t, { name: 'Listed', ownerUserId: 'out' })
  const [a] = (await t.call('GET', '/v1/agents', null, 'out')).body.agents
  assert.deepEqual([a.id, a.name, a.status, a.lastUsedAt], [agent.id, 'Listed', 'active', null])
  assert.ok(a.createdAt > 0)
})

test('key refreshes are rate-limited per address', async () => {
  const limited = await startTestApi({ tokenLimit: 2 })
  try {
    for (const want of [401, 401, 429]) assert.equal((await limited.call('POST', '/v1/agents/token', { refreshKey: 'qr_x' })).status, want)
  } finally { await limited.close() }
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/api-agent-tokens.test.js`
Expected: FAIL with `Cannot find module '…/src/api/agent-auth.js'`.

- [ ] **Step 3: Write the key module**

Create `src/api/agent-auth.js`:

```js
// Agents' keys. An access key (qa_, 1 hour) signs an agent in; a refresh key
// (qr_, 30 days, single use) swaps for a new pair. Pairs minted by refreshing
// share a family, and presenting a spent refresh key revokes the whole family:
// someone copied it, and we can't tell which holder is the real agent.
import crypto from 'node:crypto'
import { newToken, hashToken } from './tokens.js'
import { HttpError } from './http.js'

export const ACCESS_TTL_MS = 60 * 60 * 1000
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
// last_used_at is for people reading the dashboard; once a minute is plenty.
const TOUCH_EVERY_MS = 60 * 1000
export const REUSED = "This key was already used, so this agent's keys were revoked. Approve it again."

/** 'active' while some key can still refresh; 'reused' once a family was revoked; otherwise 'expired'. */
export function keyStatus (rows, at) {
  if (rows.some((k) => !k.revokedAt && k.refreshExpiresAt > at)) return 'active'
  return rows.some((k) => k.revokedAt) ? 'reused' : 'expired'
}

export function makeAgentAuth ({ store, now, bearer }) {
  /** A fresh pair for an agent, in a new family unless one is given. The keys are shown once. */
  async function mintKeys (agentId, familyId = crypto.randomUUID()) {
    const accessKey = newToken('qa_'); const refreshKey = newToken('qr_')
    const at = now()
    const accessExpiresAt = at + ACCESS_TTL_MS; const refreshExpiresAt = at + REFRESH_TTL_MS
    await store.createAgentKeys({ agentId, familyId, accessHash: hashToken(accessKey), refreshHash: hashToken(refreshKey), accessExpiresAt, refreshExpiresAt })
    return { agentId, accessKey, accessExpiresAt, refreshKey, refreshExpiresAt }
  }

  /** Swaps a refresh key for a new pair in the same family, once. */
  async function refresh (refreshKey) {
    const key = typeof refreshKey === 'string' && refreshKey.startsWith('qr_') ? refreshKey : ''
    const row = key && await store.agentKeyByRefresh(hashToken(key))
    if (!row) throw new HttpError(401, "This key isn't valid. Approve the agent again.")
    if (row.revokedAt) throw new HttpError(401, "This agent's keys were revoked. Approve it again.")
    if (row.refreshedAt) { await store.revokeFamily(row.familyId); throw new HttpError(401, REUSED) }
    if (row.refreshExpiresAt <= now()) throw new HttpError(401, 'This key has expired. Approve the agent again.')
    const agent = await store.agentById(row.agentId)
    if (!agent || agent.revokedAt) throw new HttpError(401, 'This agent was revoked.')
    // Two refreshes racing with one key: only one spends it, and the other is a reuse.
    if (!await store.claimRefresh(row.id)) { await store.revokeFamily(row.familyId); throw new HttpError(401, REUSED) }
    const pair = await mintKeys(agent.id, row.familyId)
    // A reuse caught while this pair was being made (the family revoked
    // meanwhile) must not leave this new pair working.
    if ((await store.agentKeyByRefresh(hashToken(key)))?.revokedAt) { await store.revokeFamily(row.familyId); throw new HttpError(401, REUSED) }
    return pair
  }

  /** The agent behind a request's `qa_` bearer key, or a 401. */
  async function agentFromRequest (req) {
    const key = bearer(req)
    const keyRow = key.startsWith('qa_') ? await store.agentKeyByAccess(hashToken(key)) : null
    if (!keyRow) throw new HttpError(401, 'sign the agent in first')
    if (keyRow.revokedAt) throw new HttpError(401, "this agent's keys were revoked; approve it again")
    if (keyRow.accessExpiresAt <= now()) throw new HttpError(401, 'this access key has expired; refresh it')
    const agent = await store.agentById(keyRow.agentId)
    if (!agent || agent.revokedAt) throw new HttpError(401, 'this agent was revoked')
    if (!agent.lastUsedAt || now() - agent.lastUsedAt >= TOUCH_EVERY_MS) await store.touchAgent(agent.id)
    return { agent, keyRow }
  }

  return { mintKeys, refresh, agentFromRequest }
}
```

- [ ] **Step 4: Rewrite the agents route module**

Replace `src/api/routes/agents.js` with:

```js
// Agents: swapping a refresh key, who an agent is, and a person's personal agents.
import { HttpError, needId } from '../http.js'
import { keyStatus } from '../agent-auth.js'

export function agentRoutes ({ store, user, now, limitTokens, agentAuth }) {
  return [
    ['POST', /^\/v1\/agents\/token$/, async (req, body) => {
      limitTokens(req)
      return agentAuth.refresh(body.refreshKey)
    }],

    ['GET', /^\/v1\/agents\/me$/, async (req) => {
      const { agent } = await agentAuth.agentFromRequest(req)
      if (!agent.orgId) return { agent: { id: agent.id, name: agent.name, kind: 'personal', org: null }, teams: [], role: null }
      const [org, m, teams] = await Promise.all([store.orgById(agent.orgId), store.memberByAgent(agent.orgId, agent.id), store.listTeams(agent.orgId)])
      const [role, mine] = await Promise.all([m?.roleId ? store.roleById(agent.orgId, m.roleId) : null, m ? store.teamsOfMember(m.id) : []])
      const names = new Map(teams.map((x) => [x.id, x.name]))
      return {
        agent: { id: agent.id, name: agent.name, kind: 'org', org: { slug: org.slug, name: org.name } },
        teams: mine.map((x) => ({ id: x.teamId, name: names.get(x.teamId) || '', access: x.access, scopes: x.scopes })),
        role: role ? { name: role.name } : null
      }
    }],

    ['GET', /^\/v1\/agents$/, async (req) => {
      const u = await user(req)
      const agents = await store.listPersonalAgents(u.userId)
      return {
        agents: await Promise.all(agents.map(async (a) => ({
          id: a.id,
          name: a.name,
          createdAt: a.createdAt,
          lastUsedAt: a.lastUsedAt,
          // Why an agent is signed out (reused or expired keys), so the dashboard can say so.
          status: keyStatus(await store.listAgentKeys(a.id), now())
        })))
      }
    }],

    ['DELETE', /^\/v1\/agents\/([^/]+)$/, async (req, body, [id]) => {
      const u = await user(req)
      const agent = await store.agentById(needId(id, 'agent'))
      // Someone else's agent gets the same answer as a missing one.
      if (!agent || agent.ownerUserId !== u.userId || agent.revokedAt) throw new HttpError(404, 'no such agent')
      await store.revokeAgent(agent.id)
      return { ok: true }
    }]
  ]
}
```

- [ ] **Step 5: Wire it into the server**

In `src/api/server.js`:

- After `import { agentRoutes } from './routes/agents.js'` add `import { makeAgentAuth } from './agent-auth.js'`.
- In the `startApi` parameter list, change `inviteSendLimit = 20, trustProxy` to `inviteSendLimit = 20, tokenLimit = 30, trustProxy`.
- After the `limitInviteSend` line add:

```js
  const limitTokens = makeLimiter(tokenLimit, 'too many key refreshes; try again in a minute')
  const agentAuth = makeAgentAuth({ store, now, bearer })
```

- Change `const ctx = { store, user, now, site, mailer, log, limit: limitInvites, limitSend: limitInviteSend }` to:

```js
  const ctx = { store, user, now, site, mailer, log, limit: limitInvites, limitSend: limitInviteSend, limitTokens, agentAuth }
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/api-agent-tokens.test.js && npm test`
Expected: PASS, `# pass 11` for the new file, then the whole suite `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/api/agent-auth.js src/api/routes/agents.js src/api/server.js test/api-helpers.js test/api-agent-tokens.test.js
git commit -m "Give agents access and refresh keys with reuse detection"
```

---

### Task 6: API: agent registration, signed polling and approval into a personal space

**Files:**
- Create: `src/api/routes/agent-register.js`, `test/api-agent-register.test.js`
- Modify: `src/api/server.js`, `test/api-helpers.js`, `scripts/api-smoke.mjs`

**Interfaces:**
- Consumes: `signAgentRegister`/`verifyAgentRegister`/`keyFingerprint` (Task 1); registration store methods (Task 4); `createAgent`, `agentByPublicKey`, `agentById` (Task 3); `ctx.agentAuth.mintKeys` (Task 5); `cleanName`, `HttpError`; `newToken`, `hashToken`, `newUserCode`, `normalizeUserCode`.
- Produces:
  - `agentRegisterRoutes(ctx)` with `POST /v1/agents/register`, `POST /v1/agents/register/poll`, `GET /v1/agents/register/:code`, `POST /v1/agents/register/approve` (personal only in this task)
  - Inside it, `placement(u, destination) -> Where` and `settle(u, reg, where) -> Agent` (Task 7 replaces both to add orgs)
  - `startApi({ …, registerLimit = 10 })`; `ctx.limitRegister`

- [ ] **Step 1: Write the failing tests**

In `test/api-helpers.js`, change `tokenLimit: 1000, mailer` to `tokenLimit: 1000, registerLimit: 1000, mailer`.

Create `test/api-agent-register.test.js`:

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, SITE } from './api-helpers.js'
import { generateIdentity, signAgentRegister, keyFingerprint } from '../src/identity.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())

const sign = (id, requestId) => Buffer.from(signAgentRegister(id, requestId)).toString('base64url')
const register = (id = generateIdentity(), name = 'Larry') => t.call('POST', '/v1/agents/register', { name, publicKey: id.publicKey })
const poll = (id, requestId) => t.call('POST', '/v1/agents/register/poll', { requestId, signature: sign(id, requestId) })
const approve = (userCode, who = 'mem', destination = { personal: true }, yes = true) => t.call('POST', '/v1/agents/register/approve', { userCode, approve: yes, destination }, who)

test('an agent registers, a person approves it into their personal space, and the agent collects its keys once', async () => {
  const id = generateIdentity()
  const start = await register(id)
  assert.equal(start.status, 200)
  assert.match(start.body.requestId, /^qg_[A-Za-z0-9_-]{43}$/)
  assert.match(start.body.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  assert.equal(start.body.approveUrl, `${SITE}/agents/approve?code=${start.body.userCode}`)
  assert.deepEqual([start.body.interval, start.body.expiresIn], [5, 900])
  assert.deepEqual((await poll(id, start.body.requestId)).body, { status: 'pending' })

  assert.equal((await t.call('GET', `/v1/agents/register/${start.body.userCode}`)).status, 401, 'needs sign-in')
  const seen = await t.call('GET', `/v1/agents/register/${start.body.userCode.replace('-', '').toLowerCase()}`, null, 'mem')
  assert.deepEqual([seen.body.name, seen.body.userCode, seen.body.publicKeyFingerprint], ['Larry', start.body.userCode, keyFingerprint(id.publicKey)])
  assert.ok(seen.body.expiresAt > Date.now())

  const ok = await approve(start.body.userCode)
  assert.deepEqual([ok.status, ok.body.status, ok.body.agent.name, ok.body.agent.kind], [200, 'approved', 'Larry', 'personal'])
  const done = await poll(id, start.body.requestId)
  assert.equal(done.status, 200)
  assert.deepEqual([done.body.status, done.body.agentId], ['approved', ok.body.agent.id])
  assert.match(done.body.accessKey, /^qa_/)
  assert.match(done.body.refreshKey, /^qr_/)
  assert.ok(done.body.accessExpiresAt > Date.now() && done.body.refreshExpiresAt > done.body.accessExpiresAt)
  assert.equal((await poll(id, start.body.requestId)).status, 410, 'the keys are handed out once')

  const agent = await t.store.agentById(done.body.agentId)
  assert.deepEqual([agent.ownerUserId, agent.orgId, agent.approvedBy, agent.publicKey], ['mem', null, 'mem', id.publicKey])
  const me = await t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${done.body.accessKey}` })
  assert.deepEqual([me.status, me.body.agent.kind], [200, 'personal'])
  assert.ok((await t.call('GET', '/v1/agents', null, 'mem')).body.agents.some((a) => a.id === agent.id))
})

test('only the agent holding the key can poll: a missing or wrong signature is refused', async () => {
  const id = generateIdentity(); const thief = generateIdentity()
  const start = await register(id)
  await approve(start.body.userCode)
  const r = start.body.requestId
  assert.equal((await t.call('POST', '/v1/agents/register/poll', { requestId: r })).status, 401, 'no signature')
  assert.equal((await t.call('POST', '/v1/agents/register/poll', { requestId: r, signature: 'junk' })).status, 401, 'junk signature')
  assert.equal((await poll(thief, r)).status, 401, "another identity's signature")
  assert.equal((await poll(id, r)).status, 200, 'the real agent still collects')
  assert.equal((await t.call('POST', '/v1/agents/register/poll', { requestId: 'qg_nope', signature: 'x' })).status, 404)
  assert.equal((await t.call('POST', '/v1/agents/register/poll', {})).status, 404)
})

test('a denied or expired registration never yields keys', async () => {
  const id = generateIdentity()
  const a = await register(id)
  const denied = await approve(a.body.userCode, 'mem', undefined, false)
  assert.deepEqual([denied.status, denied.body.status], [200, 'denied'])
  assert.equal((await poll(id, a.body.requestId)).status, 403)
  assert.equal((await approve(a.body.userCode)).status, 410, 'a denied code is used up')

  const id2 = generateIdentity()
  const b = await register(id2)
  const reg = await t.store.registrationByUserCode(b.body.userCode)
  await t.store.updateRegistration(reg.id, { expiresAt: Date.now() - 1 })
  assert.equal((await poll(id2, b.body.requestId)).status, 410)
  assert.equal((await approve(b.body.userCode)).status, 410)
  assert.equal((await t.call('GET', `/v1/agents/register/${b.body.userCode}`, null, 'mem')).status, 410)
  assert.equal((await t.call('GET', '/v1/agents/register/AAAA-AAAA', null, 'mem')).status, 404)
})

test('an approved registration the agent never collects expires 5 minutes after the request does', async () => {
  const inId = generateIdentity(); const outId = generateIdentity()
  const inGrace = await register(inId); const pastGrace = await register(outId)
  await approve(inGrace.body.userCode); await approve(pastGrace.body.userCode)
  const a = await t.store.registrationByUserCode(inGrace.body.userCode)
  await t.store.updateRegistration(a.id, { expiresAt: Date.now() - 4 * 60_000 })
  const b = await t.store.registrationByUserCode(pastGrace.body.userCode)
  await t.store.updateRegistration(b.id, { expiresAt: Date.now() - 5 * 60_000 - 1000 })
  assert.equal((await poll(inId, inGrace.body.requestId)).status, 200)
  assert.equal((await poll(outId, pastGrace.body.requestId)).status, 410)
})

test('registration requests expire 15 minutes after they start, and keep only a hash of the request id', async () => {
  const start = await register()
  const reg = await t.store.registrationByUserCode(start.body.userCode)
  assert.ok(Math.abs(reg.expiresAt - (Date.now() + 15 * 60 * 1000)) < 5000)
  assert.equal(reg.requestHash.length, 64)
  assert.equal(JSON.stringify(reg).includes(start.body.requestId), false)
})

test('bad registrations are refused', async () => {
  assert.equal((await t.call('POST', '/v1/agents/register', { name: 'X', publicKey: 'nope' })).status, 400)
  assert.equal((await t.call('POST', '/v1/agents/register', { name: '  ', publicKey: generateIdentity().publicKey })).status, 400)
  assert.equal((await t.call('POST', '/v1/agents/register', null)).status, 400)
  const long = await register(undefined, 'x'.repeat(60))
  assert.equal((await t.store.registrationByUserCode(long.body.userCode)).name.length, 40)
})

test('an identity that already belongs to an agent cannot register or be approved again', async () => {
  const id = generateIdentity()
  const a = await register(id)
  const b = await register(id)
  await approve(a.body.userCode)
  assert.equal((await register(id)).status, 409)
  assert.equal((await approve(b.body.userCode)).status, 409)
  assert.equal((await t.store.registrationByUserCode(b.body.userCode)).status, 'pending', 'a refused approval leaves the request as it was')
})

test('approving needs a destination, and two approvals racing on one code: only one wins', async () => {
  const start = await register()
  assert.equal((await approve(start.body.userCode, 'mem', {})).status, 400)
  assert.equal((await approve(start.body.userCode, 'mem', null)).status, 400)
  assert.equal((await approve(start.body.userCode, 'mem', { personal: 'yes' })).status, 400)
  assert.equal((await t.call('POST', '/v1/agents/register/approve', { userCode: start.body.userCode, approve: true, destination: { personal: true } })).status, 401)
  const [x, y] = await Promise.all([approve(start.body.userCode, 'mem'), approve(start.body.userCode, 'lim')])
  assert.deepEqual([x.status, y.status].sort(), [200, 410])
})

test('registering is rate-limited per address', async () => {
  const limited = await startTestApi({ registerLimit: 2 })
  try {
    const go = () => limited.call('POST', '/v1/agents/register', { name: 'X', publicKey: generateIdentity().publicKey })
    assert.equal((await go()).status, 200)
    assert.equal((await go()).status, 200)
    assert.equal((await go()).status, 429)
  } finally { await limited.close() }
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/api-agent-register.test.js`
Expected: FAIL: `POST /v1/agents/register` answers 404 (`not found`), so the first assertion sees `404 !== 200`.

- [ ] **Step 3: Write the routes**

Create `src/api/routes/agent-register.js`:

```js
// Agents sign themselves up: an agent registers its own key, a signed-in person
// approves it at /agents/approve, and the agent collects its first key pair by
// proving it holds that key. Mirrors linking a computer (server.js).
import { HttpError, cleanName } from '../http.js'
import { newToken, hashToken, newUserCode, normalizeUserCode } from '../tokens.js'
import { parsePublicKey, verifyAgentRegister, keyFingerprint } from '../../identity.js'

const REGISTER_TTL_MS = 15 * 60 * 1000
// An approved registration the agent never collects stops working this long after it expires.
const COLLECT_GRACE_MS = 5 * 60 * 1000
const POLL_INTERVAL_S = 5
const GONE = 'this code has expired or was already used'

export function agentRegisterRoutes ({ store, user, now, site, limitRegister, agentAuth }) {
  async function openRegistration (code) {
    const userCode = normalizeUserCode(code)
    const reg = userCode && await store.registrationByUserCode(userCode)
    if (!reg) throw new HttpError(404, 'no such code')
    if (reg.status !== 'pending' || reg.expiresAt < now()) throw new HttpError(410, GONE)
    return reg
  }

  // Where an approved agent goes. Checked before the registration is claimed,
  // so a refused choice can be fixed and tried again.
  async function placement (u, dest) {
    if (dest?.personal === true) return { personal: true }
    throw new HttpError(400, 'choose where the agent goes')
  }

  // Makes the agent where it was placed.
  async function settle (u, reg, where) {
    return store.createAgent({ name: reg.name, publicKey: reg.publicKey, ownerUserId: u.userId, approvedBy: u.userId })
  }

  return [
    ['POST', /^\/v1\/agents\/register$/, async (req, body) => {
      limitRegister(req)
      const publicKey = String(body.publicKey || '')
      if (!parsePublicKey(publicKey)) throw new HttpError(400, 'publicKey must be an Ed25519 key (spki, base64url)')
      const name = cleanName(body.name, 40, 'give the agent a name')
      // One identity is one agent for good; signing in again after a revoke uses a new key.
      if (await store.agentByPublicKey(publicKey)) throw new HttpError(409, 'this identity already belongs to an agent; make a new one')
      const requestId = newToken('qg_')
      let userCode
      do userCode = newUserCode(); while (await store.registrationByUserCode(userCode))
      await store.createRegistration({ requestHash: hashToken(requestId), userCode, publicKey, name, expiresAt: now() + REGISTER_TTL_MS })
      return { requestId, userCode, approveUrl: `${site}/agents/approve?code=${userCode}`, interval: POLL_INTERVAL_S, expiresIn: REGISTER_TTL_MS / 1000 }
    }],

    ['POST', /^\/v1\/agents\/register\/poll$/, async (req, body) => {
      const requestId = typeof body.requestId === 'string' ? body.requestId : ''
      const reg = requestId && await store.registrationByRequest(hashToken(requestId))
      if (!reg) throw new HttpError(404, 'unknown request')
      // Every poll proves the agent holds the key it registered, so a leaked
      // approval code (or request id) can't hand the keys to anyone else.
      const sig = typeof body.signature === 'string' ? Buffer.from(body.signature, 'base64url') : null
      if (!sig || !verifyAgentRegister(parsePublicKey(reg.publicKey), requestId, sig)) throw new HttpError(401, "this agent's signature doesn't match")
      const waiting = reg.status === 'pending' || reg.status === 'approving'
      if (reg.status === 'consumed' || (waiting && reg.expiresAt < now())) throw new HttpError(410, 'expired')
      if (reg.status === 'approved' && reg.expiresAt + COLLECT_GRACE_MS < now()) throw new HttpError(410, 'expired')
      if (reg.status === 'denied') throw new HttpError(403, 'denied')
      if (waiting) return [202, { status: 'pending' }]
      // Claim before minting, so two polls racing on one registration can't both get keys.
      if (!await store.claimRegistration(reg.id, 'approved', 'consumed')) throw new HttpError(410, 'expired')
      const agent = reg.agentId && await store.agentById(reg.agentId)
      if (!agent || agent.revokedAt) throw new HttpError(410, 'expired')
      return { status: 'approved', ...await agentAuth.mintKeys(agent.id) }
    }],

    ['GET', /^\/v1\/agents\/register\/([^/]+)$/, async (req, body, [code]) => {
      await user(req)
      const reg = await openRegistration(code)
      return { name: reg.name, userCode: reg.userCode, expiresAt: reg.expiresAt, publicKeyFingerprint: keyFingerprint(reg.publicKey) }
    }],

    ['POST', /^\/v1\/agents\/register\/approve$/, async (req, body) => {
      const u = await user(req)
      const reg = await openRegistration(body.userCode)
      if (body.approve !== true) {
        if (!await store.claimRegistration(reg.id, 'pending', 'denied')) throw new HttpError(410, GONE)
        return { status: 'denied' }
      }
      const where = await placement(u, body.destination)
      // Claim first, so two approvals racing on one code can't both make an agent.
      if (!await store.claimRegistration(reg.id, 'pending', 'approving')) throw new HttpError(410, GONE)
      let agent
      try {
        if (await store.agentByPublicKey(reg.publicKey)) throw new HttpError(409, 'this agent was already approved; start it again to get a new identity')
        agent = await settle(u, reg, where)
      } catch (err) {
        // Put the request back so the person can retry rather than being stuck mid-approval.
        await store.updateRegistration(reg.id, { status: 'pending' }).catch(() => {})
        throw err
      }
      await store.updateRegistration(reg.id, { status: 'approved', agentId: agent.id })
      return { status: 'approved', agent: { id: agent.id, name: agent.name, kind: agent.orgId ? 'org' : 'personal' } }
    }]
  ]
}
```

- [ ] **Step 4: Wire it into the server and the smoke test**

In `src/api/server.js`:

- After `import { makeAgentAuth } from './agent-auth.js'` add `import { agentRegisterRoutes } from './routes/agent-register.js'`.
- In the `startApi` parameter list, change `tokenLimit = 30, trustProxy` to `tokenLimit = 30, registerLimit = 10, trustProxy`.
- After the `limitTokens` line add:

```js
  const limitRegister = makeLimiter(registerLimit, 'too many agent sign-ups; try again in a minute')
```

- Change the `ctx` line to:

```js
  const ctx = { store, user, now, site, mailer, log, limit: limitInvites, limitSend: limitInviteSend, limitTokens, limitRegister, agentAuth }
```

- Change the push to `routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx), ...agentRoutes(ctx), ...agentRegisterRoutes(ctx))`.

In `scripts/api-smoke.mjs`, change the import to `import { generateIdentity, signChallenge, signAgentRegister } from '../src/identity.js'` and, before the line `if (!JWT) {`, add:

```js
// Agents register without an account; polling is signed with the agent's own key.
const agentId = generateIdentity()
const reg = await call('POST', '/v1/agents/register', { name: 'smoke agent', publicKey: agentId.publicKey }); ok(reg.s === 200 && reg.b.approveUrl.includes('/agents/approve?code='), 'agents/register')
ok((await call('POST', '/v1/agents/register/poll', { requestId: reg.b.requestId, signature: Buffer.from(signAgentRegister(agentId, reg.b.requestId)).toString('base64url') })).s === 202, 'agent poll pending')
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/api-agent-register.test.js && npm test`
Expected: PASS, `# pass 9` for the new file, then the whole suite `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/agent-register.js src/api/server.js test/api-helpers.js test/api-agent-register.test.js scripts/api-smoke.mjs
git commit -m "Let agents register, and people approve them into their personal space"
```

---
### Task 7: API: approving into an org, and org agents in the member and team routes

**Files:**
- Create: `src/api/team-access.js`, `test/api-team-access.test.js`, `test/api-agent-orgs.test.js`
- Modify: `src/api/routes/agent-register.js`, `src/api/routes/members.js` (rewrite), `src/api/routes/teams.js` (rewrite), `test/api-teams.test.js`

**Interfaces:**
- Consumes: `orgAccess` (`need`, `can`, `covers`, `assignable`); `addAgentMember`, `memberByAgent`, `deleteAgent`, `revokeAgent` (Task 3); `addTeamMember`/`setTeamAccess` with `scopes`, `listTeamMembers` rows with `kind` and `scopes` (Tasks 3-4); `placement`/`settle` in `routes/agent-register.js` (Task 6).
- Produces:
  - `src/api/team-access.js`: `ACCESS = ['editor', 'viewer']`, `accessOf(v) -> 'editor'|'viewer'` (400 otherwise), `MAX_SCOPES = 20`, `MAX_SCOPE_LENGTH = 200`, `cleanScopes(input) -> string[]` (400 on anything else)
  - Approve destination `{ org, roleId?, teams? }` works as in Global Constraints
  - `GET /v1/orgs/:slug/members` rows: `{ id, kind, userId, agentId, name, email, roleId, role, isOwner, isYou, joinedAt, teams: [{ id, name, access, scopes }] }`
  - `GET /v1/orgs/:slug/teams`: `members: [{ memberId, name, access, kind, scopes }]`, `people: [{ memberId, name, kind }]`
  - `POST /v1/orgs/:slug/teams/:id/members { memberId, access, scopes? }` and `PUT …/members/:memberId { access, scopes? }` answer `{ member: { memberId, access, scopes } }`

- [ ] **Step 1: Write the failing tests**

Create `test/api-team-access.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessOf, cleanScopes, MAX_SCOPES, MAX_SCOPE_LENGTH } from '../src/api/team-access.js'

test('accessOf allows editor and viewer only', () => {
  assert.equal(accessOf('editor'), 'editor')
  assert.equal(accessOf('viewer'), 'viewer')
  for (const bad of ['owner', '', undefined, null]) assert.throws(() => accessOf(bad), (err) => err.status === 400)
})

test('cleanScopes tidies folders the way the relay does', () => {
  assert.deepEqual([MAX_SCOPES, MAX_SCOPE_LENGTH], [20, 200])
  assert.deepEqual(cleanScopes(['src/', './docs', ' web/app ', 'src', '', 'a/b/']), ['src', 'docs', 'web/app', 'a/b'])
  assert.deepEqual(cleanScopes([]), [])
  assert.equal(cleanScopes(Array.from({ length: 20 }, (_, i) => `d${i}`)).length, 20)
  assert.equal(cleanScopes(['x'.repeat(200)]).length, 1)
})

test('cleanScopes refuses paths outside the project, odd input and too many folders', () => {
  for (const bad of [['/etc'], ['../x'], ['a/../../b'], ['a\\b'], ['x'.repeat(201)], [42], 'src', null, undefined]) {
    assert.throws(() => cleanScopes(bad), (err) => err.status === 400, JSON.stringify(bad))
  }
  assert.throws(() => cleanScopes(Array.from({ length: 21 }, (_, i) => `d${i}`)), (err) => err.status === 400 && /20 folders/.test(err.message))
})
```

Create `test/api-agent-orgs.test.js`:

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, makeAgent } from './api-helpers.js'
import { generateIdentity, signAgentRegister } from '../src/identity.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())

const sign = (id, requestId) => Buffer.from(signAgentRegister(id, requestId)).toString('base64url')
async function registered (name = 'Bot') {
  const id = generateIdentity()
  const r = await t.call('POST', '/v1/agents/register', { name, publicKey: id.publicKey })
  return { id, ...r.body }
}
const approve = (userCode, who, destination) => t.call('POST', '/v1/agents/register/approve', { userCode, approve: true, destination }, who)
const bearer = (key) => ({ authorization: `Bearer ${key}` })

test('approving into an org: teams with access and folders, an optional role, and the agent sees it all', async () => {
  const o = await makeOrg(t, 'Bots Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const web = await t.store.createTeam({ orgId: o.org.id, name: 'Web' })
  const lead = await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: { teams: { r: true } } })
  const reg = await registered('Bot')
  const ok = await approve(reg.userCode, 'admin', { org: o.slug, roleId: lead.id, teams: [{ teamId: core.id, access: 'editor', scopes: ['src/', './docs'] }, { teamId: web.id, access: 'viewer', scopes: [] }] })
  assert.deepEqual([ok.status, ok.body.agent.kind], [200, 'org'])
  const keys = (await t.call('POST', '/v1/agents/register/poll', { requestId: reg.requestId, signature: sign(reg.id, reg.requestId) })).body
  const me = (await t.call('GET', '/v1/agents/me', null, null, bearer(keys.accessKey))).body
  assert.deepEqual(me.agent.org, { slug: o.slug, name: 'Bots Co' })
  assert.deepEqual(me.role, { name: 'Lead' })
  assert.deepEqual(me.teams.map((x) => [x.name, x.access, x.scopes]).sort(), [['Core', 'editor', ['src', 'docs']], ['Web', 'viewer', []]])
  const agent = await t.store.agentById(keys.agentId)
  assert.deepEqual([agent.orgId, agent.ownerUserId, agent.approvedBy], [o.org.id, null, 'admin'])
  assert.equal((await t.call('GET', '/v1/agents', null, 'admin')).body.agents.some((a) => a.id === agent.id), false, 'org agents are not personal')
})

test('approving into an org needs Agents: Create, and Team membership: Create for teams', async () => {
  const o = await makeOrg(t, 'Rights Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const reg = await registered()
  assert.equal((await approve(reg.userCode, 'mem', { org: o.slug })).status, 403, 'Member has no Agents: Create')
  assert.equal((await approve(reg.userCode, 'out', { org: o.slug })).status, 404, 'not in the org')
  const approver = await t.store.createRole({ orgId: o.org.id, name: 'Approver', grants: { agents: { c: true } } })
  await t.store.setMemberRole(o.mem.id, approver.id)
  assert.equal((await approve(reg.userCode, 'mem', { org: o.slug, teams: [{ teamId: core.id, access: 'viewer' }] })).status, 403, 'no Team membership: Create')
  const ok = await approve(reg.userCode, 'mem', { org: o.slug })
  assert.equal(ok.status, 200, 'no teams and no role is fine')
  assert.equal((await t.store.memberByAgent(o.org.id, ok.body.agent.id)).roleId, null, 'new agents default to no role')
})

test('an org approval only hands out roles within your own grid, never Owner', async () => {
  const o = await makeOrg(t, 'Grid Co')
  const approver = await t.store.createRole({ orgId: o.org.id, name: 'Approver', grants: { agents: { c: true }, teams: { r: true } } })
  await t.store.setMemberRole(o.mem.id, approver.id)
  const reg = await registered()
  assert.equal((await approve(reg.userCode, 'mem', { org: o.slug, roleId: o.role('admin').id })).status, 403)
  assert.equal((await approve(reg.userCode, 'owner', { org: o.slug, roleId: o.role('owner').id })).status, 403)
  assert.equal((await approve(reg.userCode, 'mem', { org: o.slug, roleId: 'not-a-uuid' })).status, 404)
  assert.equal((await approve(reg.userCode, 'mem', { org: o.slug, roleId: o.role('member').id })).status, 200, 'Member (Teams: Read) is within Approver')
})

test('team choices are checked: teams of this org, once each, editor or viewer, folders inside the project', async () => {
  const o = await makeOrg(t, 'Check Co'); const other = await makeOrg(t, 'Elsewhere Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const theirs = await t.store.createTeam({ orgId: other.org.id, name: 'Theirs' })
  const reg = await registered()
  const go = (teams) => approve(reg.userCode, 'admin', { org: o.slug, teams })
  assert.equal((await go([{ teamId: theirs.id, access: 'viewer' }])).status, 404)
  assert.equal((await go([{ teamId: core.id, access: 'viewer' }, { teamId: core.id, access: 'editor' }])).status, 400)
  assert.equal((await go([{ teamId: core.id, access: 'owner' }])).status, 400)
  assert.equal((await go([{ teamId: core.id, access: 'viewer', scopes: ['../secrets'] }])).status, 400)
  assert.equal((await go([{ teamId: core.id, access: 'viewer', scopes: Array.from({ length: 21 }, (_, i) => `d${i}`) }])).status, 400)
  assert.equal((await go('Core')).status, 400)
  assert.equal((await t.store.registrationByUserCode(reg.userCode)).status, 'pending', 'refused choices leave the request open')
  assert.equal((await go([{ teamId: core.id, access: 'viewer', scopes: ['src'] }])).status, 200)
})

test('a failed org approval removes the half-made agent and reopens the request', async () => {
  const o = await makeOrg(t, 'Flaky Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const reg = await registered()
  const destination = { org: o.slug, teams: [{ teamId: core.id, access: 'viewer' }] }
  const broken = await startTestApi({ store: { ...t.store, addTeamMember: async () => { throw new Error('db down') } } })
  try {
    assert.equal((await broken.call('POST', '/v1/agents/register/approve', { userCode: reg.userCode, approve: true, destination }, 'admin')).status, 500)
  } finally { await broken.close() }
  assert.equal((await t.store.registrationByUserCode(reg.userCode)).status, 'pending')
  assert.equal(await t.store.agentByPublicKey(reg.id.publicKey), null, 'the half-made agent is gone')
  assert.equal((await approve(reg.userCode, 'admin', destination)).status, 200, 'and it can be approved again')
})

test('org agents are listed with people as kind agent, for those who may read agents', async () => {
  const o = await makeOrg(t, 'Listing Co')
  const { agent } = await makeAgent(t, { name: 'Bot', orgId: o.org.id })
  const m = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  await t.store.addTeamMember({ teamId: core.id, memberId: m.id, access: 'viewer', scopes: ['src'] })
  const r = await t.call('GET', `/v1/orgs/${o.slug}/members`, null, 'admin')
  const bot = r.body.members.find((x) => x.id === m.id)
  assert.deepEqual([bot.kind, bot.name, bot.agentId, bot.email, bot.role, bot.userId, bot.isYou, bot.isOwner], ['agent', 'Bot', agent.id, '', null, null, false, false])
  assert.deepEqual(bot.teams, [{ id: core.id, name: 'Core', access: 'viewer', scopes: ['src'] }])
  assert.equal(r.body.members.find((x) => x.userId === 'mem').kind, 'person')
  const watcher = await t.store.createRole({ orgId: o.org.id, name: 'Watcher', grants: { agents: { r: true } } })
  await t.store.setMemberRole(o.mem.id, watcher.id)
  assert.deepEqual((await t.call('GET', `/v1/orgs/${o.slug}/members`, null, 'mem')).body.members.map((x) => x.kind), ['agent'], 'Agents: Read alone shows only agents')
  const people = await t.store.createRole({ orgId: o.org.id, name: 'People', grants: { members: { r: true } } })
  await t.store.setMemberRole(o.mem.id, people.id)
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/members`, null, 'mem')).body.members.some((x) => x.kind === 'agent'), false, 'Members: Read alone shows only people')
})

test("an org agent's role needs Agents: Update and stays within your grid; no role is allowed", async () => {
  const o = await makeOrg(t, 'Role Bot Co')
  const { agent } = await makeAgent(t, { orgId: o.org.id })
  const m = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  const put = (who, roleId) => t.call('PUT', `/v1/orgs/${o.slug}/members/${m.id}`, { roleId }, who)
  assert.equal((await put('mem', o.role('member').id)).status, 403)
  assert.equal((await put('admin', o.role('member').id)).body.member.roleId, o.role('member').id)
  assert.equal((await put('admin', null)).body.member.roleId, null)
  assert.equal((await put('admin', o.role('owner').id)).status, 403)
  const tender = await t.store.createRole({ orgId: o.org.id, name: 'Tender', grants: { agents: { u: true } } })
  await t.store.setMemberRole(o.mem.id, tender.id)
  assert.equal((await put('mem', o.role('admin').id)).status, 403, 'Admin holds more than Tender')
  assert.equal((await put('mem', null)).status, 200, 'Tender can take a role away')
})

test("an agent's team folders change with Team membership; people have no folders", async () => {
  const o = await makeOrg(t, 'Folder Co')
  const core = (await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Core' }, 'admin')).body.team
  const { agent } = await makeAgent(t, { name: 'Bot', orgId: o.org.id })
  const m = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  const base = `/v1/orgs/${o.slug}/teams/${core.id}/members`
  const added = await t.call('POST', base, { memberId: m.id, access: 'editor', scopes: ['src'] }, 'admin')
  assert.deepEqual(added.body.member, { memberId: m.id, access: 'editor', scopes: ['src'] })
  assert.equal((await t.call('POST', base, { memberId: o.mem.id, access: 'viewer', scopes: ['src'] }, 'admin')).status, 400, 'folders are for agents')
  const changed = await t.call('PUT', `${base}/${m.id}`, { access: 'viewer', scopes: ['docs/', 'web'] }, 'admin')
  assert.deepEqual(changed.body.member, { memberId: m.id, access: 'viewer', scopes: ['docs', 'web'] })
  assert.deepEqual((await t.call('PUT', `${base}/${m.id}`, { access: 'editor' }, 'admin')).body.member.scopes, ['docs', 'web'], 'access alone keeps the folders')
  assert.equal((await t.call('PUT', `${base}/${m.id}`, { access: 'viewer', scopes: ['/etc'] }, 'admin')).status, 400)
  assert.equal((await t.call('PUT', `${base}/${m.id}`, { access: 'viewer', scopes: ['x'] }, 'mem')).status, 403)
  const listed = (await t.call('GET', `/v1/orgs/${o.slug}/teams`, null, 'admin')).body
  assert.deepEqual(listed.teams[0].members, [{ memberId: m.id, name: 'Bot', access: 'editor', kind: 'agent', scopes: ['docs', 'web'] }])
  assert.equal(listed.people.find((p) => p.memberId === m.id).kind, 'agent')
})

test('removing an org agent needs Agents: Delete, and revokes it', async () => {
  const o = await makeOrg(t, 'Revoke Co')
  const { agent, accessKey } = await makeAgent(t, { orgId: o.org.id })
  const m = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  const remover = await t.store.createRole({ orgId: o.org.id, name: 'Remover', grants: { members: { r: true, d: true } } })
  await t.store.setMemberRole(o.mem.id, remover.id)
  const del = (who) => t.call('DELETE', `/v1/orgs/${o.slug}/members/${m.id}`, null, who)
  assert.equal((await del('mem')).status, 403, 'Members: Delete is for people')
  assert.equal((await del('admin')).status, 200)
  assert.ok((await t.store.agentById(agent.id)).revokedAt > 0)
  assert.equal(await t.store.memberByAgent(o.org.id, agent.id), null)
  assert.equal((await t.call('GET', '/v1/agents/me', null, null, bearer(accessKey))).status, 401)
})
```

In `test/api-teams.test.js`, change

```js
  assert.deepEqual(mo.teams, [{ id: core.id, name: 'Core', access: 'editor' }])
```

to

```js
  assert.deepEqual(mo.teams, [{ id: core.id, name: 'Core', access: 'editor', scopes: [] }])
  assert.equal(mo.kind, 'person')
```

and

```js
  assert.deepEqual(w.members, [{ memberId: o.mem.id, name: 'Mo', access: 'viewer' }])
```

to

```js
  assert.deepEqual(w.members, [{ memberId: o.mem.id, name: 'Mo', access: 'viewer', kind: 'person', scopes: [] }])
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/api-team-access.test.js test/api-agent-orgs.test.js test/api-teams.test.js`
Expected: FAIL: `Cannot find module '…/src/api/team-access.js'`, org approvals answer 400 (`choose where the agent goes`), and the `scopes`/`kind` deepEqual mismatches.

- [ ] **Step 3: Write the team access module**

Create `src/api/team-access.js`:

```js
// What a team membership grants: editor or viewer, and for agents, optional
// folders (the relay's scope rules: up to 20 relative path prefixes).
import { HttpError, stripInvisible } from './http.js'

export const ACCESS = ['editor', 'viewer']
export const MAX_SCOPES = 20
export const MAX_SCOPE_LENGTH = 200
const BAD_FOLDER = 'Folders must be paths inside the project, like src or docs.'

export function accessOf (v) {
  if (!ACCESS.includes(v)) throw new HttpError(400, 'access must be editor or viewer')
  return v
}

/** Folders as the relay wants them: trimmed, no leading "./" or trailing "/", each once. */
export function cleanScopes (input) {
  if (!Array.isArray(input)) throw new HttpError(400, BAD_FOLDER)
  const out = []
  for (const raw of input) {
    if (typeof raw !== 'string') throw new HttpError(400, BAD_FOLDER)
    const s = stripInvisible(raw).join('').trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '')
    if (!s) continue
    if (s.startsWith('/') || s.includes('\\') || s.length > MAX_SCOPE_LENGTH || s.split('/').includes('..')) throw new HttpError(400, BAD_FOLDER)
    if (!out.includes(s)) out.push(s)
  }
  if (out.length > MAX_SCOPES) throw new HttpError(400, 'An agent can be limited to at most 20 folders.')
  return out
}
```

- [ ] **Step 4: Approve into an org**

In `src/api/routes/agent-register.js`:

Change the first import line to `import { HttpError, cleanName, needId } from '../http.js'` and add after the other imports:

```js
import { orgAccess } from '../org-access.js'
import { accessOf, cleanScopes } from '../team-access.js'
```

After `const GONE = 'this code has expired or was already used'` add:

```js
const MAX_TEAMS = 50
```

Replace `placement` and `settle`:

```js
  // Where an approved agent goes. Checked before the registration is claimed,
  // so a refused choice can be fixed and tried again.
  async function placement (u, dest) {
    if (dest?.personal === true) return { personal: true }
    throw new HttpError(400, 'choose where the agent goes')
  }

  // Makes the agent where it was placed.
  async function settle (u, reg, where) {
    return store.createAgent({ name: reg.name, publicKey: reg.publicKey, ownerUserId: u.userId, approvedBy: u.userId })
  }
```

with

```js
  // Where an approved agent goes, and what it may do there. Checked before the
  // registration is claimed, so a refused choice can be fixed and tried again.
  async function placement (u, dest) {
    if (dest?.personal === true) return { personal: true }
    if (!dest || typeof dest.org !== 'string') throw new HttpError(400, 'choose where the agent goes')
    const a = await orgAccess(store, u.userId, dest.org)
    a.need('agents', 'c')
    // No role unless one is chosen: an org agent reaches only the teams it's added to.
    const role = dest.roleId ? await a.assignable(dest.roleId) : null
    const list = dest.teams ?? []
    if (!Array.isArray(list) || list.length > MAX_TEAMS) throw new HttpError(400, 'teams must be a list')
    if (list.length) a.need('team_members', 'c')
    const teams = []
    for (const item of list) {
      const team = await store.teamById(a.org.id, needId(item?.teamId, 'team'))
      if (!team) throw new HttpError(404, 'no such team')
      if (teams.some((x) => x.teamId === team.id)) throw new HttpError(400, 'each team can only be picked once')
      teams.push({ teamId: team.id, access: accessOf(item.access), scopes: cleanScopes(item.scopes ?? []) })
    }
    return { org: a.org, roleId: role ? role.id : null, teams }
  }

  // Makes the agent where it was placed. An org agent is also a member with its
  // teams; if any step fails, the half-made agent is removed again.
  async function settle (u, reg, where) {
    if (where.personal) return store.createAgent({ name: reg.name, publicKey: reg.publicKey, ownerUserId: u.userId, approvedBy: u.userId })
    const agent = await store.createAgent({ name: reg.name, publicKey: reg.publicKey, orgId: where.org.id, approvedBy: u.userId })
    try {
      const m = await store.addAgentMember({ orgId: where.org.id, agentId: agent.id, roleId: where.roleId })
      for (const t of where.teams) await store.addTeamMember({ teamId: t.teamId, memberId: m.id, access: t.access, scopes: t.scopes })
    } catch (err) {
      await store.deleteAgent(agent.id).catch(() => {})
      throw err
    }
    return agent
  }
```

- [ ] **Step 5: Rewrite the member routes**

Replace `src/api/routes/members.js` with:

```js
// An org's people and agents: the member list, changing a role, removing or leaving.
import { HttpError, needId } from '../http.js'
import { orgAccess } from '../org-access.js'

export function memberRoutes ({ store, user }) {
  const orgFor = async (req, slug) => { const u = await user(req); return { u, ...(await orgAccess(store, u.userId, slug)) } }

  async function target (a, id) {
    const m = await store.memberById(a.org.id, needId(id, 'member'))
    if (!m) throw new HttpError(404, 'no such member')
    if (m.userId && m.userId === a.org.ownerId) throw new HttpError(403, 'the owner only changes through a transfer')
    return m
  }

  // You can't act on someone (or an agent) whose role holds checkboxes you don't.
  async function outranks (a, m) {
    const r = m.roleId && await store.roleById(a.org.id, m.roleId)
    if (!a.covers(r?.grants)) throw new HttpError(403, m.agentId ? "this agent has permissions you don't have" : "this person has permissions you don't have")
  }

  return [
    ['GET', /^\/v1\/orgs\/([^/]+)\/members$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      // One list: people for Members: Read, agents for Agents: Read.
      const seePeople = a.can('members', 'r')
      const seeAgents = a.can('agents', 'r')
      if (!seePeople && !seeAgents) a.need('members', 'r')
      const [everyone, roles] = await Promise.all([store.listMembers(a.org.id), store.listRoles(a.org.id)])
      const members = everyone.filter((m) => (m.agentId ? seeAgents : seePeople))
      const roleName = new Map(roles.map((r) => [r.id, r.name]))
      // Team names only for people allowed to see who's in each team.
      const teamsOf = new Map()
      if (a.can('team_members', 'r')) {
        for (const team of await store.listTeams(a.org.id)) {
          for (const tm of await store.listTeamMembers(team.id)) {
            teamsOf.set(tm.memberId, [...(teamsOf.get(tm.memberId) || []), { id: team.id, name: team.name, access: tm.access, scopes: tm.scopes || [] }])
          }
        }
      }
      const emails = await Promise.all(members.map((m) => (m.userId ? store.userEmail(m.userId) : null)))
      return {
        members: members.map((m, i) => ({
          id: m.id,
          kind: m.agentId ? 'agent' : 'person',
          userId: m.userId ?? null,
          agentId: m.agentId ?? null,
          name: m.name,
          email: emails[i]?.email || '',
          roleId: m.roleId,
          role: roleName.get(m.roleId) || null,
          isOwner: !!m.userId && m.userId === a.org.ownerId,
          isYou: !!m.userId && m.userId === a.u.userId,
          joinedAt: m.joinedAt,
          teams: teamsOf.get(m.id) || []
        }))
      }
    }],

    ['PUT', /^\/v1\/orgs\/([^/]+)\/members\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      const m = await target(a, id)
      if (m.agentId) {
        // An agent's role is Agents: Update, and it may have none (team access only).
        a.need('agents', 'u')
        await outranks(a, m)
        const role = body.roleId ? await a.assignable(body.roleId) : null
        const saved = await store.setMemberRole(m.id, role ? role.id : null)
        return { member: { id: saved.id, roleId: saved.roleId } }
      }
      // Assigning a person's role is Members: Update together with Roles: Update.
      a.need('members', 'u')
      a.need('roles', 'u')
      if (m.userId === a.u.userId) throw new HttpError(403, "you can't change your own role")
      await outranks(a, m)
      const role = await a.assignable(body.roleId || 'missing')
      const saved = await store.setMemberRole(m.id, role.id)
      return { member: { id: saved.id, roleId: saved.roleId } }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)\/members\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      const m = await target(a, id)
      if (m.agentId) {
        // An org agent has nowhere else to be, so removing it revokes it.
        a.need('agents', 'd')
        await outranks(a, m)
        await store.revokeAgent(m.agentId)
        await store.removeMember(m.id)
        return { ok: true }
      }
      // Anyone may leave; removing someone else needs Members: Delete.
      if (m.userId !== a.u.userId) {
        a.need('members', 'd')
        await outranks(a, m)
      }
      await store.removeMember(m.id)
      return { ok: true }
    }]
  ]
}
```

- [ ] **Step 6: Rewrite the team routes**

Replace `src/api/routes/teams.js` with:

```js
// Flat teams inside an org, and who's in each: people and agents with editor or
// viewer access, and for agents, optional folders.
import { HttpError, needId, cleanName } from '../http.js'
import { orgAccess } from '../org-access.js'
import { accessOf, cleanScopes } from '../team-access.js'

const kindOf = (m) => (m.agentId ? 'agent' : 'person')

export function teamRoutes ({ store, user }) {
  const orgFor = async (req, slug) => { const u = await user(req); return { u, ...(await orgAccess(store, u.userId, slug)) } }

  async function teamIn (a, id) {
    const team = await store.teamById(a.org.id, needId(id, 'team'))
    if (!team) throw new HttpError(404, 'no such team')
    return team
  }

  // Folders only limit agents; a person in a team always reaches all of it.
  // undefined means "leave the folders as they are".
  function foldersFor (m, raw) {
    if (raw === undefined) return undefined
    const scopes = cleanScopes(raw)
    if (scopes.length && !m.agentId) throw new HttpError(400, 'Folders are only for agents.')
    return scopes
  }

  const memberView = (tm) => ({ memberId: tm.memberId, access: tm.access, scopes: tm.scopes || [] })

  return [
    ['GET', /^\/v1\/orgs\/([^/]+)\/teams$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      const mine = new Map((await store.teamsOfMember(a.me.id)).map((x) => [x.teamId, x.access]))
      // Teams: Read shows every team; everyone sees the teams they're in.
      const teams = (await store.listTeams(a.org.id)).filter((t) => a.can('teams', 'r') || mine.has(t.id))
      return {
        teams: await Promise.all(teams.map(async (t) => ({
          id: t.id,
          name: t.name,
          createdAt: t.createdAt,
          access: mine.get(t.id) || null,
          members: a.can('team_members', 'r') || mine.has(t.id)
            ? (await store.listTeamMembers(t.id)).map((m) => ({ memberId: m.memberId, name: m.name, access: m.access, kind: m.kind, scopes: m.scopes || [] }))
            : null
        }))),
        // The people and agents you could add, for those who add to teams.
        people: a.can('team_members', 'c')
          ? (await store.listMembers(a.org.id)).map((m) => ({ memberId: m.id, name: m.name, kind: kindOf(m) }))
          : null
      }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/teams$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('teams', 'c')
      return { team: await store.createTeam({ orgId: a.org.id, name: cleanName(body.name, 60, 'give the team a name') }) }
    }],

    ['PUT', /^\/v1\/orgs\/([^/]+)\/teams\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('teams', 'u')
      const team = await teamIn(a, id)
      return { team: await store.renameTeam(team.id, cleanName(body.name, 60, 'give the team a name')) }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)\/teams\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('teams', 'd')
      await store.deleteTeam((await teamIn(a, id)).id)
      return { ok: true }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/teams\/([^/]+)\/members$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('team_members', 'c')
      const team = await teamIn(a, id)
      const access = accessOf(body.access ?? 'viewer')
      const m = await store.memberById(a.org.id, needId(body.memberId, 'member'))
      if (!m) throw new HttpError(404, 'no such member')
      const scopes = foldersFor(m, body.scopes) ?? []
      // addTeamMember upserts; without this, Create alone could restyle someone's
      // access by re-adding them, which is Team membership: Update's job.
      if ((await store.listTeamMembers(team.id)).some((x) => x.memberId === m.id)) throw new HttpError(409, 'That person is already in this team.')
      return { member: memberView(await store.addTeamMember({ teamId: team.id, memberId: m.id, access, scopes })) }
    }],

    ['PUT', /^\/v1\/orgs\/([^/]+)\/teams\/([^/]+)\/members\/([^/]+)$/, async (req, body, [slug, id, memberId]) => {
      const a = await orgFor(req, slug)
      a.need('team_members', 'u')
      const team = await teamIn(a, id)
      const m = await store.memberById(a.org.id, needId(memberId, 'member'))
      if (!m) throw new HttpError(404, "that person isn't in this team")
      const tm = await store.setTeamAccess(team.id, m.id, accessOf(body.access), foldersFor(m, body.scopes))
      if (!tm) throw new HttpError(404, "that person isn't in this team")
      return { member: memberView(tm) }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)\/teams\/([^/]+)\/members\/([^/]+)$/, async (req, body, [slug, id, memberId]) => {
      const a = await orgFor(req, slug)
      a.need('team_members', 'd')
      const team = await teamIn(a, id)
      if (!await store.removeTeamMember(team.id, needId(memberId, 'member'))) throw new HttpError(404, "that person isn't in this team")
      return { ok: true }
    }]
  ]
}
```

- [ ] **Step 7: Run the tests**

Run: `node --test test/api-team-access.test.js test/api-agent-orgs.test.js test/api-teams.test.js && npm test`
Expected: PASS: `# pass 3`, `# pass 9`, then the api-teams file, then the whole suite `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/api/team-access.js src/api/routes/agent-register.js src/api/routes/members.js src/api/routes/teams.js test/api-team-access.test.js test/api-agent-orgs.test.js test/api-teams.test.js
git commit -m "Approve agents into orgs, with roles, teams and folders"
```

---
### Task 8: CLI: `quilt agent login` and `quilt agent whoami`

**Files:**
- Create: `src/agent-login.js`, `test/agent-login.test.js`
- Modify: `bin/quilt.js`

**Interfaces:**
- Consumes: `generateIdentity`, `signAgentRegister`, `keyFingerprint` (Task 1); `quiltHome` (`src/legacy.js`); the API routes from Tasks 5-6.
- Produces (`src/agent-login.js`):
  - `DEFAULT_API = 'https://api.heyquilt.com'`
  - `agentFile(name, dir = quiltHome()) -> string` (`<dir>/agents/<name>.json`; throws on a bad name)
  - `agentLogin({ name, api = DEFAULT_API, dir, fetch, log, sleep, now }) -> Saved` where `Saved = { name, api, agentId, accessKey, accessExpiresAt, refreshKey, refreshExpiresAt, identity }`, written with mode `0600`
  - `agentWhoami({ name, dir, fetch, now }) -> /v1/agents/me body` (refreshes first when the access key is within a minute of expiry, saving the new pair)
  - `describeAgent(me) -> string`
  - CLI: `quilt agent login --name <name> [--api <url>]`, `quilt agent whoami --name <name>`

- [ ] **Step 1: Write the failing tests**

Create `test/agent-login.test.js`:

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { startTestApi } from './api-helpers.js'
import { agentLogin, agentWhoami, agentFile, describeAgent, DEFAULT_API } from '../src/agent-login.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-agent-'))

// Logs an agent in, approving (or denying) it from the website side on the first wait.
async function login (dir, name = 'larry', yes = true) {
  const lines = []
  let asked = false
  const saved = await agentLogin({
    name,
    api: t.api.url,
    dir,
    log: (l) => lines.push(l),
    sleep: async () => {
      if (asked) return
      asked = true
      const code = lines.join('\n').match(/Code: (\S+)/)[1]
      await t.call('POST', '/v1/agents/register/approve', { userCode: code, approve: yes, destination: { personal: true } }, 'mem')
    }
  })
  return { saved, lines }
}

test('quilt agent login registers, waits for approval and saves its keys privately', async () => {
  assert.equal(DEFAULT_API, 'https://api.heyquilt.com')
  const dir = tmp()
  const { saved, lines } = await login(dir)
  assert.match(lines[0], /\/agents\/approve\?code=[A-Z0-9]{4}-[A-Z0-9]{4}/)
  assert.match(lines[0], /Key: {2}[0-9a-f]{4} /)
  assert.match(saved.accessKey, /^qa_/)
  const file = agentFile('larry', dir)
  assert.equal(file, path.join(dir, 'agents', 'larry.json'))
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual([onDisk.agentId, onDisk.api, !!onDisk.identity.privateKey, onDisk.refreshKey], [saved.agentId, t.api.url, true, saved.refreshKey])
})

test('quilt agent whoami says who the agent is, refreshing an expired access key first', async () => {
  const dir = tmp()
  const { saved } = await login(dir, 'whoami-bot')
  const me = await agentWhoami({ name: 'whoami-bot', dir })
  assert.deepEqual([me.agent.id, me.agent.kind], [saved.agentId, 'personal'])
  assert.equal(describeAgent(me), 'whoami-bot: your personal agent')
  const file = agentFile('whoami-bot', dir)
  fs.writeFileSync(file, JSON.stringify({ ...saved, accessExpiresAt: Date.now() - 1 }))
  await agentWhoami({ name: 'whoami-bot', dir })
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.notEqual(after.refreshKey, saved.refreshKey, 'the refresh key rotated')
  assert.ok(after.accessExpiresAt > Date.now())
  // The old refresh key is spent: using it again revokes the agent's keys.
  assert.equal((await t.call('POST', '/v1/agents/token', { refreshKey: saved.refreshKey })).status, 401)
  await assert.rejects(agentWhoami({ name: 'whoami-bot', dir }), /revoked/)
})

test('describeAgent lists an org agent, its role and its teams', () => {
  const me = { agent: { name: 'Bot', kind: 'org', org: { slug: 'acme', name: 'Acme' } }, role: { name: 'Lead' }, teams: [{ name: 'Core', access: 'editor', scopes: ['src', 'docs'] }, { name: 'Web', access: 'viewer', scopes: [] }] }
  assert.equal(describeAgent(me), 'Bot: an agent in Acme\nRole: Lead\nTeam Core: editor, folders src, docs\nTeam Web: viewer')
})

test('a denied login stops with a clear message; bad names and unknown agents are refused', async () => {
  await assert.rejects(login(tmp(), 'denied-bot', false), /denied/)
  assert.throws(() => agentFile('../evil', tmp()), /--name/)
  await assert.rejects(agentWhoami({ name: 'nobody', dir: tmp() }), /quilt agent login --name nobody/)
})

test('quilt agent needs a subcommand and a name', () => {
  const bin = new URL('../bin/quilt.js', import.meta.url).pathname
  for (const args of [['agent', 'login'], ['agent'], ['agent', 'dance', '--name', 'x']]) {
    const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 1, args.join(' '))
    assert.match(r.stderr, /quilt agent login --name <name>/)
  }
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/agent-login.test.js`
Expected: FAIL with `Cannot find module '…/src/agent-login.js'`.

- [ ] **Step 3: Write the agent login module**

Create `src/agent-login.js`:

```js
// `quilt agent login|whoami`: sign an agent in to Quilt the way agents do it
// themselves, for trying the flow from a terminal. The agent makes its own
// Ed25519 identity, registers, waits for a person to approve it on the website,
// and keeps its keys in ~/.quilt/agents/<name>.json (readable only by you).
import fs from 'node:fs'
import path from 'node:path'
import { quiltHome } from './legacy.js'
import { generateIdentity, signAgentRegister, keyFingerprint } from './identity.js'

export const DEFAULT_API = 'https://api.heyquilt.com'
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/
// Refresh a little early so the access key doesn't lapse mid-request.
const EARLY_MS = 60 * 1000

export function agentFile (name, dir = quiltHome()) {
  if (!NAME.test(String(name || ''))) throw new Error('--name must be 1 to 40 letters, numbers, dots, dashes or underscores')
  return path.join(dir, 'agents', `${name}.json`)
}

async function send (fetchImpl, api, method, route, body, key) {
  const res = await fetchImpl(String(api).replace(/\/+$/, '') + route, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) }
}

function save (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 })
  // writeFileSync's mode only applies when it creates the file.
  fs.chmodSync(file, 0o600)
}

function load (file, name) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new Error(`No agent called ${name} here. Run: quilt agent login --name ${name}`) }
}

/** Registers a fresh identity, waits for a person to approve it, and saves its keys. */
export async function agentLogin ({ name, api = DEFAULT_API, dir, fetch: fetchImpl = globalThis.fetch, log = console.log, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now }) {
  const file = agentFile(name, dir)
  // Always a new identity: one key is one agent, and a revoked agent's key is never reused.
  const identity = generateIdentity()
  const start = await send(fetchImpl, api, 'POST', '/v1/agents/register', { name, publicKey: identity.publicKey })
  if (!start.ok) throw new Error(start.body?.error || `Couldn't register the agent (${start.status}).`)
  const { requestId, userCode, approveUrl, interval, expiresIn } = start.body
  log(`To approve ${name}, open:\n\n  ${approveUrl}\n\nCode: ${userCode}\nKey:  ${keyFingerprint(identity.publicKey)}\n\nWaiting for approval...`)
  const deadline = now() + expiresIn * 1000
  while (now() < deadline) {
    await sleep(interval * 1000)
    const signature = Buffer.from(signAgentRegister(identity, requestId)).toString('base64url')
    const r = await send(fetchImpl, api, 'POST', '/v1/agents/register/poll', { requestId, signature })
    if (r.status === 202) continue
    if (r.status === 403) throw new Error('The agent was denied.')
    if (r.status === 410) throw new Error('The approval expired. Run this again.')
    if (!r.ok) throw new Error(r.body?.error || `Couldn't check the approval (${r.status}).`)
    const saved = { name, api, agentId: r.body.agentId, accessKey: r.body.accessKey, accessExpiresAt: r.body.accessExpiresAt, refreshKey: r.body.refreshKey, refreshExpiresAt: r.body.refreshExpiresAt, identity }
    save(file, saved)
    log(`Approved. ${name}'s keys are saved in ${file}`)
    return saved
  }
  throw new Error('The approval expired. Run this again.')
}

async function refresh (saved, file, fetchImpl) {
  const r = await send(fetchImpl, saved.api, 'POST', '/v1/agents/token', { refreshKey: saved.refreshKey })
  if (!r.ok) throw new Error(r.body?.error || `Couldn't refresh the agent's keys (${r.status}).`)
  const next = { ...saved, accessKey: r.body.accessKey, accessExpiresAt: r.body.accessExpiresAt, refreshKey: r.body.refreshKey, refreshExpiresAt: r.body.refreshExpiresAt }
  // Save straight away: the old refresh key is spent, and using it again would revoke the agent.
  save(file, next)
  return next
}

/** Who the agent is, refreshing its keys first when the access key has (nearly) run out. */
export async function agentWhoami ({ name, dir, fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
  const file = agentFile(name, dir)
  let saved = load(file, name)
  if (saved.accessExpiresAt - EARLY_MS <= now()) saved = await refresh(saved, file, fetchImpl)
  const r = await send(fetchImpl, saved.api, 'GET', '/v1/agents/me', null, saved.accessKey)
  if (!r.ok) throw new Error(r.body?.error || `Couldn't reach Quilt (${r.status}).`)
  return r.body
}

export function describeAgent (me) {
  const where = me.agent.kind === 'org' ? `an agent in ${me.agent.org.name}` : 'your personal agent'
  const lines = [`${me.agent.name}: ${where}`]
  if (me.role) lines.push(`Role: ${me.role.name}`)
  for (const t of me.teams) lines.push(`Team ${t.name}: ${t.access}${t.scopes.length ? `, folders ${t.scopes.join(', ')}` : ''}`)
  return lines.join('\n')
}
```

- [ ] **Step 4: Add the command**

In `bin/quilt.js`:

- In `HELP`, after the `quilt api …` line add:

```
  quilt agent login --name <name> [--api <url>]       Sign an AI agent in (you approve it on the website)
  quilt agent whoami --name <name>                    Show who a signed-in agent is
```

- In `main()`'s switch, after `case 'api': return apiCmd()` add `    case 'agent': return agentCmd()`.
- After the `apiCmd` function add:

```js
async function agentCmd () {
  const usage = 'usage: quilt agent login --name <name> [--api <url>]\n       quilt agent whoami --name <name>'
  const [sub, ...rest] = argv
  let values = {}
  try { ({ values } = parseArgs({ args: rest, options: { name: { type: 'string' }, api: { type: 'string' } } })) } catch { fail(usage) }
  if (!['login', 'whoami'].includes(sub) || !values.name) fail(usage)
  const { agentLogin, agentWhoami, describeAgent, DEFAULT_API } = await import('../src/agent-login.js')
  try {
    if (sub === 'login') await agentLogin({ name: values.name, api: values.api || DEFAULT_API })
    else console.log(describeAgent(await agentWhoami({ name: values.name })))
  } catch (err) {
    fail(err.message)
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/agent-login.test.js && npm test`
Expected: PASS, `# pass 5` for the new file, then the whole suite `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/agent-login.js bin/quilt.js test/agent-login.test.js
git commit -m "Add quilt agent login and whoami"
```

---

### Task 9: Website: the agent approval page

**Files:**
- Create: `web/lib/agent-form.js`, `web/lib/agent-approve.js`, `web/components/ApproveAgent.js`, `web/app/agents/approve/page.js`, `web/app/agents/approve/actions.js`, `web/test/agent-form.test.js`
- Modify: `web/proxy.js`, `web/test/routes.test.js`

**Interfaces:**
- Consumes: API `GET /v1/agents/register/:code`, `POST /v1/agents/register/approve` (Tasks 6-7), `GET /v1/orgs`, `GET /v1/orgs/:slug/me`, `GET /v1/orgs/:slug/teams`, `GET /v1/orgs/:slug/roles`; `apiCall` (`web/lib/api.js`), `myOrgs` (`web/lib/org.js`), `allowed`, `assignableRoles`, `safeMessage` (`web/lib/org-view.js`), `isSlug` (`web/lib/space.js`), `requireUser` (`web/lib/session.js`), `Header`, `SubmitButtons` (buttons named `decision` with values `approve`/`deny`).
- Produces:
  - `web/lib/agent-form.js`: `splitFolders(s) -> string[]`; `destinationFromForm(formData) -> { personal: true } | { org, roleId: string|null, teams: [{ teamId, access, scopes }] }` (form fields `dest`, `roleId`, repeated `teamId`/`access`/`folders`)
  - `web/lib/agent-approve.js` (server-only): `agentDestinations(user) -> [{ slug, name, roles: [{ id, name }], teams: [{ id, name }] }]` (orgs where the viewer holds Agents: Create; teams only with Team membership: Create; roles only those they may give)
  - `<ApproveAgent code destinations />` (client): the destination choice, role select, team rows with "Add another team", Approve / Deny
  - `decideAgent(formData)` server action; page `/agents/approve?code=…` (private)

- [ ] **Step 1: Write the failing tests**

Create `web/test/agent-form.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { destinationFromForm, splitFolders } from '../lib/agent-form.js'

test('splitFolders splits on commas and drops blanks; the API tidies each folder', () => {
  assert.deepEqual(splitFolders(' src, docs/ ,,web '), ['src', 'docs/', 'web'])
  assert.deepEqual(splitFolders(null), [])
})

test('a personal destination ignores any team fields', () => {
  const f = new FormData()
  f.append('dest', 'personal')
  f.append('teamId', 't1')
  assert.deepEqual(destinationFromForm(f), { personal: true })
  assert.deepEqual(destinationFromForm(new FormData()), { personal: true })
})

test('an org destination reads the role and each filled-in team row in order', () => {
  const f = new FormData()
  f.append('dest', 'acme')
  f.append('roleId', '')
  for (const [teamId, access, folders] of [['t1', 'editor', 'src, docs'], ['', 'viewer', 'ignored'], ['t2', 'owner', '']]) {
    f.append('teamId', teamId); f.append('access', access); f.append('folders', folders)
  }
  assert.deepEqual(destinationFromForm(f), {
    org: 'acme',
    roleId: null,
    teams: [{ teamId: 't1', access: 'editor', scopes: ['src', 'docs'] }, { teamId: 't2', access: 'viewer', scopes: [] }]
  })
  f.set('roleId', 'r1')
  assert.equal(destinationFromForm(f).roleId, 'r1')
})
```

In `web/test/routes.test.js`, add `'/agents/approve?code=AAAA-BBBB'` to the private-pages list (after `'/link?code=AAAA-BBBB'`).

- [ ] **Step 2: Run them to see them fail**

Run: `cd web && npm test`
Expected: FAIL: `Cannot find module '…/web/lib/agent-form.js'`, and the routes test sees `200 !== 307` (or a 404) for `/agents/approve?code=AAAA-BBBB`.

- [ ] **Step 3: Write the form helpers and the loader**

Create `web/lib/agent-form.js`:

```js
// Reading the agent approval form. Pure, so it's unit-tested directly.

/** "src, docs/ ,web" to ['src', 'docs/', 'web']: the API tidies each folder. */
export function splitFolders (s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean)
}

/** Where the approver sent the agent, as the API's `destination`. Rows without a team are skipped. */
export function destinationFromForm (formData) {
  const dest = String(formData.get('dest') || 'personal')
  if (dest === 'personal') return { personal: true }
  const access = formData.getAll('access').map(String)
  const folders = formData.getAll('folders').map(String)
  const teams = formData.getAll('teamId').map(String)
    .map((teamId, i) => ({ teamId, access: access[i] === 'editor' ? 'editor' : 'viewer', scopes: splitFolders(folders[i]) }))
    .filter((t) => t.teamId)
  return { org: dest, roleId: String(formData.get('roleId') || '') || null, teams }
}
```

Create `web/lib/agent-approve.js`:

```js
import 'server-only'
import { apiCall } from './api.js'
import { myOrgs } from './org.js'
import { allowed, assignableRoles } from './org-view.js'

/** The orgs this person may approve agents into, with the roles and teams they may give. */
export async function agentDestinations (user) {
  const orgs = await myOrgs(user.accessToken)
  const found = await Promise.all(orgs.map(async (o) => {
    const me = await apiCall(user, 'GET', `/v1/orgs/${o.slug}/me`)
    if (!me.ok || !allowed(me.data, 'agents', 'c')) return null
    const [teams, roles] = await Promise.all([
      allowed(me.data, 'team_members', 'c') ? apiCall(user, 'GET', `/v1/orgs/${o.slug}/teams`) : null,
      apiCall(user, 'GET', `/v1/orgs/${o.slug}/roles`)
    ])
    return {
      slug: o.slug,
      name: o.name,
      roles: assignableRoles(roles.data?.roles, me.data).map(({ id, name }) => ({ id, name })),
      teams: (teams?.data?.teams || []).map(({ id, name }) => ({ id, name }))
    }
  }))
  return found.filter(Boolean)
}
```

- [ ] **Step 4: Write the action, the form and the page**

Create `web/app/agents/approve/actions.js`:

```js
'use server'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { isSlug } from '@/lib/space.js'
import { destinationFromForm } from '@/lib/agent-form.js'

export async function decideAgent (formData) {
  const code = String(formData.get('code') || '')
  const back = `/agents/approve?code=${encodeURIComponent(code)}`
  const user = await requireUser(back)
  const approve = formData.get('decision') === 'approve'
  const destination = destinationFromForm(formData)
  if (destination.org && !isSlug(destination.org)) redirect(`${back}&error=${encodeURIComponent('Pick where the agent goes.')}`)
  const r = await apiCall(user, 'POST', '/v1/agents/register/approve', { userCode: code, approve, destination })
  if (!r.ok) redirect(`${back}&error=${encodeURIComponent(r.data?.error || 'Something went wrong. Try again.')}`)
  redirect(`${back}&done=${approve ? 'approved' : 'denied'}`)
}
```

Create `web/components/ApproveAgent.js`:

```js
'use client'
import { useState } from 'react'
import SubmitButtons from './SubmitButtons.js'
import { decideAgent } from '@/app/agents/approve/actions.js'

function TeamRow ({ teams }) {
  return (
    <div className='row'>
      <select className='input' name='teamId' defaultValue='' aria-label='Team'>
        <option value=''>Pick a team</option>
        {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <select className='input' name='access' defaultValue='viewer' aria-label='Access'>
        <option value='editor'>Editor</option>
        <option value='viewer'>Viewer</option>
      </select>
      <input className='input' name='folders' placeholder='Folders, e.g. src, docs (optional)' aria-label='Folders' style={{ flex: '1 1 200px' }} />
    </div>
  )
}

// Where the agent goes: the person's own space, or an org with a role and teams.
function OrgChoices ({ org }) {
  const [rows, setRows] = useState(1)
  return (
    <div className='stack'>
      {org.roles.length > 0 && (
        <div className='field'>
          <label htmlFor='roleId'>Org role</label>
          <select id='roleId' className='input' name='roleId' defaultValue=''>
            <option value=''>No role (team access only)</option>
            {org.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>)}
      {org.teams.length > 0
        ? (
          <div className='stack'>
            <b>Teams</b>
            {Array.from({ length: rows }, (_, i) => <TeamRow key={i} teams={org.teams} />)}
            {rows < org.teams.length && <button type='button' className='btn ghost' onClick={() => setRows(rows + 1)}>Add another team</button>}
            <p className='muted'>Folders limit what it can change. Leave them empty for the whole project.</p>
          </div>)
        : <p className='muted'>You can't add agents to this org's teams, so it will join with no team access for now.</p>}
    </div>
  )
}

export default function ApproveAgent ({ code, destinations }) {
  const [dest, setDest] = useState('personal')
  const org = destinations.find((d) => d.slug === dest)
  return (
    <form action={decideAgent} className='stack'>
      <input type='hidden' name='code' value={code} />
      <fieldset className='stack' style={{ border: 0, padding: 0, margin: 0 }}>
        <legend><b>Where should it go?</b></legend>
        <label className='row'>
          <input type='radio' name='dest' value='personal' checked={dest === 'personal'} onChange={() => setDest('personal')} /> Me (personal)
        </label>
        {destinations.map((d) => (
          <label key={d.slug} className='row'>
            <input type='radio' name='dest' value={d.slug} checked={dest === d.slug} onChange={() => setDest(d.slug)} /> {d.name}
          </label>))}
      </fieldset>
      {org
        ? <OrgChoices key={org.slug} org={org} />
        : <p className='muted'>It joins your sessions the way a person does: with an invite link and your approval in the app.</p>}
      <div className='row'><SubmitButtons /></div>
    </form>
  )
}
```

Create `web/app/agents/approve/page.js`:

```js
import Header from '@/components/Header.js'
import ApproveAgent from '@/components/ApproveAgent.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { agentDestinations } from '@/lib/agent-approve.js'
import { safeMessage } from '@/lib/org-view.js'

export const metadata = { title: 'Approve an agent' }

export default async function ApproveAgentPage ({ searchParams }) {
  const q = await searchParams
  const code = String(q.code || '')
  const user = await requireUser(`/agents/approve?code=${encodeURIComponent(code)}`)
  let body
  if (q.done === 'approved') {
    body = <><h2>Agent approved</h2><p className='muted'>Go back to your agent. It's signed in now.</p><p><a className='btn ghost' href='/dashboard'>Go to your dashboard</a></p></>
  } else if (q.done === 'denied') {
    body = <><h2>Not approved</h2><p className='muted'>That agent won't be signed in.</p></>
  } else {
    const r = code ? await apiCall(user, 'GET', `/v1/agents/register/${encodeURIComponent(code)}`) : { ok: false, status: 404 }
    if (!r.ok) {
      const why = r.status === 410 ? 'It expired or was already used.' : (r.status === 0 || r.status >= 500) ? 'Quilt is having trouble right now. Try again in a minute.' : 'Check the code your agent showed you, or start its sign-in again.'
      body = <><h2>That code didn't work</h2><p className='muted'>{why}</p></>
    } else {
      const a = r.data
      const destinations = await agentDestinations(user)
      const error = safeMessage(q.error)
      body = (
        <>
          <h2>Approve this agent?</h2>
          <p><b>{a.name}</b> <span className='pill'>Agent</span></p>
          <p className='muted'>Check your agent shows this code: <code style={{ fontSize: 16 }}>{a.userCode}</code></p>
          <p className='muted'>Its key: <code>{a.publicKeyFingerprint}</code></p>
          <p className='notice'>Only approve an agent you just started yourself.</p>
          {error && <p className='notice bad'>{error}</p>}
          <ApproveAgent code={a.userCode} destinations={destinations} />
          <p className='muted'>Signed in as {user.email}</p>
        </>
      )
    }
  }
  return (
    <>
      <Header signedIn />
      <main className='wrap page' style={{ maxWidth: 560 }}><div className='card stack'>{body}</div></main>
    </>
  )
}
```

In `web/proxy.js`, change

```js
const PRIVATE = ['/dashboard', '/settings', '/link', '/reset', '/org', '/orgs', '/invite']
```

to

```js
const PRIVATE = ['/dashboard', '/settings', '/link', '/reset', '/org', '/orgs', '/invite', '/agents']
```

- [ ] **Step 5: Run the tests**

Run: `cd web && npm test`
Expected: PASS, `# fail 0` (including `no-em-dash` and the routes test's new private page).

- [ ] **Step 6: Commit**

```bash
git add web/lib/agent-form.js web/lib/agent-approve.js web/components/ApproveAgent.js web/app/agents web/proxy.js web/test/agent-form.test.js web/test/routes.test.js
git commit -m "Add the agent approval page"
```

---
### Task 10: Website: "Your agents" on the dashboard, and agents on People and Teams

**Files:**
- Create: `web/lib/agent-view.js`, `web/test/agent-view.test.js`
- Modify: `web/app/dashboard/page.js` (rewrite), `web/app/dashboard/actions.js`, `web/app/org/[slug]/people/page.js` (rewrite), `web/app/org/[slug]/people/actions.js`, `web/app/org/[slug]/teams/page.js`, `web/lib/org-view.js`, `web/test/org-view.test.js`
- Delete: `web/components/NewAgent.js`, `web/lib/agent-setup.js`, `web/test/agent-setup.test.js`

**Interfaces:**
- Consumes: API `GET /v1/agents` (`status`), `DELETE /v1/agents/:id` (Task 5); `GET /v1/orgs/:slug/members` (`kind`, `teams[].scopes`), `PUT /v1/orgs/:slug/members/:id` (agents: `roleId` may be empty), `DELETE /v1/orgs/:slug/members/:id` (revokes an agent), `PUT /v1/orgs/:slug/teams/:id/members/:memberId { access, scopes }` (Task 7); `splitFolders` (Task 9); `orgAction`, `enc` (`web/lib/org-actions.js`).
- Produces:
  - `web/lib/agent-view.js`: `agentStatus(status) -> null | { label, why }`; `AGENT_LOGIN_COMMAND = 'quilt agent login --name my-agent'`
  - `orgTabs` shows People for Members: Read **or** Agents: Read
  - `setAgentTeam(formData)` server action (People page)

- [ ] **Step 1: Write the failing tests**

Create `web/test/agent-view.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentStatus, AGENT_LOGIN_COMMAND } from '../lib/agent-view.js'

test('agentStatus explains a signed-out agent and says nothing for an active one', () => {
  assert.equal(agentStatus('active'), null)
  assert.equal(agentStatus(undefined), null)
  assert.equal(agentStatus('toString'), null)
  assert.equal(agentStatus('reused').label, 'Signed out')
  assert.match(agentStatus('reused').why, /old key/)
  assert.equal(agentStatus('expired').label, 'Signed out')
  assert.match(agentStatus('expired').why, /30 days/)
  assert.equal(AGENT_LOGIN_COMMAND, 'quilt agent login --name my-agent')
})
```

Append to `web/test/org-view.test.js`:

```js
test('orgTabs shows People to those who may read agents, even without Members: Read', () => {
  const watcher = { isOwner: false, grants: { agents: { r: true } } }
  assert.deepEqual(orgTabs('acme', watcher).map((t) => t.label), ['Overview', 'People', 'Teams'])
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd web && npm test`
Expected: FAIL: `Cannot find module '…/web/lib/agent-view.js'`, and the orgTabs test gets `['Overview', 'Teams']`.

- [ ] **Step 3: Implement the helpers**

Create `web/lib/agent-view.js`:

```js
// How a personal agent's sign-in stands, for the dashboard. Pure.
const STATUS = {
  reused: { label: 'Signed out', why: 'An old key of this agent was used again, so its keys were revoked. Sign it in again.' },
  expired: { label: 'Signed out', why: "It wasn't used for 30 days. Sign it in again." }
}

/** Why an agent is signed out, or null while it can still refresh its keys. */
export function agentStatus (status) {
  return Object.hasOwn(STATUS, status) ? STATUS[status] : null
}

export const AGENT_LOGIN_COMMAND = 'quilt agent login --name my-agent'
```

In `web/lib/org-view.js`, change

```js
    allowed(me, 'members', 'r') && { href: `${base}/people`, label: 'People' },
```

to

```js
    (allowed(me, 'members', 'r') || allowed(me, 'agents', 'r')) && { href: `${base}/people`, label: 'People' },
```

- [ ] **Step 4: Replace the dashboard's agents section**

```bash
git rm web/components/NewAgent.js web/lib/agent-setup.js web/test/agent-setup.test.js
```

In `web/app/dashboard/actions.js`, delete the whole `createAgent` function together with its comment line (`// Creating an agent mints a key and an identity, so it goes through the API. The key comes back once.`). `revokeAgent` stays as it is.

Replace `web/app/dashboard/page.js` with:

```js
import { headers, cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Header from '@/components/Header.js'
import FirstOrg from '@/components/FirstOrg.js'
import SpaceSwitcher from '@/components/SpaceSwitcher.js'
import { requireUser } from '@/lib/session.js'
import { createClient } from '@/lib/supabase/server.js'
import { apiCall } from '@/lib/api.js'
import { myOrgs } from '@/lib/org.js'
import { SPACE_COOKIE, spaceHome } from '@/lib/space.js'
import { safeMessage, when } from '@/lib/org-view.js'
import { agentStatus, AGENT_LOGIN_COMMAND } from '@/lib/agent-view.js'
import { downloadFor, DOWNLOADS } from '@/lib/platform.js'
import { unlinkComputer, revokeAgent, askToJoin } from './actions.js'

export const metadata = { title: 'Dashboard' }
const PLATFORMS = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' }

export default async function Dashboard ({ searchParams }) {
  const q = await searchParams
  const user = await requireUser('/dashboard')
  const orgs = await myOrgs(user.accessToken)
  // Come back to the space the person chose last, if they're still in it.
  const home = spaceHome((await cookies()).get(SPACE_COOKIE)?.value, orgs)
  if (home !== '/dashboard') redirect(home)
  const supabase = await createClient()
  // Name the columns: secret columns (token_hash) aren't granted to signed-in people.
  // Independent calls, so they run together rather than one after another.
  const [{ data: computers }, agentsRes, discover, { data: profile }] = await Promise.all([
    supabase.from('devices').select('id, name, platform, last_seen_at, revoked_at').is('revoked_at', null).order('last_seen_at', { ascending: false }),
    apiCall(user, 'GET', '/v1/agents'),
    // Orgs on the person's own (confirmed, non-public) email domain that take join requests.
    apiCall(user, 'GET', '/v1/orgs/discover'),
    // Only an org account ever gets a FirstOrg card, even if a personal account somehow has stray org_name metadata.
    supabase.from('profiles').select('kind').eq('id', user.id).maybeSingle()
  ])
  // The API lists only agents that aren't revoked.
  const agents = agentsRes.data?.agents || []
  const joinable = discover.data?.orgs || []
  const ua = (await headers()).get('user-agent') || ''
  const download = downloadFor(ua) || DOWNLOADS.macArm
  return (
    <>
      <Header signedIn />
      <main className='wrap page stack'>
        <div className='row' style={{ justifyContent: 'space-between' }}>
          <h1 style={{ fontSize: 32 }}>Dashboard</h1>
          <div className='row'>
            <SpaceSwitcher orgs={orgs} current='personal' />
            <a className='btn ghost' href='/settings'>Settings</a>
            <form action='/auth/signout' method='post'><button className='btn ghost'>Sign out</button></form>
          </div>
        </div>
        {q.password && <p className='notice'>Password updated.</p>}
        {q.left && <p className='notice'>You left the org.</p>}
        {q.orgDeleted && <p className='notice'>The org was deleted.</p>}
        {!orgs.length && user.orgName && profile?.kind === 'org' && <FirstOrg name={user.orgName} />}
        {q.asked && <p className='notice'>Asked. Someone at the org will let you in.</p>}
        {q.error && <p className='notice bad'>{safeMessage(q.error)}</p>}
        {joinable.length > 0 && (
          <section className='card stack'>
            <h2>Orgs at {discover.data.domain}</h2>
            {joinable.map((o) => (
              <div key={o.slug} className='list-row'>
                <b>{o.name}</b>
                {o.requested
                  ? <span className='pill'>Requested</span>
                  : <form action={askToJoin}><input type='hidden' name='slug' value={o.slug} /><button className='btn'>Ask to join</button></form>}
              </div>))}
          </section>)}
        <section className='card stack'>
          <div className='row' style={{ justifyContent: 'space-between' }}>
            <h2>Your computers</h2>
            <a className='btn ghost' href={download.href}>{download.label}</a>
          </div>
          {computers?.length
            ? computers.map((c) => (
              <div key={c.id} className='row' style={{ justifyContent: 'space-between' }}>
                <span><b>{c.name}</b> {PLATFORMS[c.platform] && <span className='pill'>{PLATFORMS[c.platform]}</span>} <span className='muted'>· last seen {when(c.last_seen_at)}</span></span>
                <form action={unlinkComputer}><input type='hidden' name='id' value={c.id} /><button className='btn ghost danger'>Unlink</button></form>
              </div>))
            : <p className='muted'>No computers yet. Open the Quilt app and choose <b>Sign in</b>.</p>}
        </section>
        <section className='card stack'>
          <h2>Your agents</h2>
          {!agentsRes.ok && <p className='notice bad'>Could not load your agents right now.</p>}
          {agentsRes.ok && !agents.length && <p className='muted'>No agents yet.</p>}
          {agents.length > 0 && (
            <div>
              {agents.map((a) => {
                const s = agentStatus(a.status)
                return (
                  <div key={a.id} className='list-row'>
                    <span>
                      <b>{a.name}</b> <span className='pill'>Agent</span> {s && <span className='pill'>{s.label}</span>}
                      <br />
                      <span className='muted'>{s ? s.why : `Added ${when(a.createdAt)} · last used ${when(a.lastUsedAt)}`}</span>
                    </span>
                    <form action={revokeAgent}><input type='hidden' name='id' value={a.id} /><button className='btn ghost danger'>Revoke</button></form>
                  </div>)
              })}
            </div>)}
          <div className='stack'>
            <h3>Connect an agent</h3>
            <p className='muted'>Agents sign themselves in. Your agent shows you a link and a code. You open the link, choose where it goes (just you, or one of your orgs), and approve it. It gets its own keys, and you can revoke it here at any time.</p>
            <p className='muted'>To try it from a terminal:</p>
            <code>{AGENT_LOGIN_COMMAND}</code>
          </div>
        </section>
      </main>
    </>
  )
}
```

- [ ] **Step 5: Show agents on People and Teams**

Replace `web/app/org/[slug]/people/actions.js` with:

```js
'use server'
import { orgAction, enc } from '@/lib/org-actions.js'
import { splitFolders } from '@/lib/agent-form.js'

export async function setRole (formData) {
  await orgAction(formData, 'people', 'PUT', `/members/${enc(formData.get('id'))}`, { roleId: String(formData.get('roleId') || '') })
}

// Removing an agent member revokes the agent.
export async function removeMember (formData) {
  await orgAction(formData, 'people', 'DELETE', `/members/${enc(formData.get('id'))}`)
}

// An agent's access and folders in one team.
export async function setAgentTeam (formData) {
  await orgAction(formData, 'people', 'PUT', `/teams/${enc(formData.get('id'))}/members/${enc(formData.get('memberId'))}`, {
    access: String(formData.get('access') || ''),
    scopes: splitFolders(formData.get('folders'))
  })
}
```

Replace `web/app/org/[slug]/people/page.js` with:

```js
import { notFound } from 'next/navigation'
import Notice from '@/components/Notice.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgMe } from '@/lib/org.js'
import { allowed, assignableRoles } from '@/lib/org-view.js'
import { setRole, removeMember, setAgentTeam } from './actions.js'
import { leaveOrg } from '../actions.js'

export const metadata = { title: 'People' }

function Hidden ({ slug, id, memberId }) {
  return (
    <>
      <input type='hidden' name='slug' value={slug} />
      <input type='hidden' name='id' value={id} />
      {memberId && <input type='hidden' name='memberId' value={memberId} />}
    </>
  )
}

function RoleForm ({ slug, m, roles, allowNone }) {
  return (
    <form action={setRole} className='row'>
      <Hidden slug={slug} id={m.id} />
      <select className='input' name='roleId' defaultValue={m.roleId || ''} aria-label={`Role for ${m.name || m.email}`}>
        {allowNone && <option value=''>No role</option>}
        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <button className='btn ghost'>Save</button>
    </form>
  )
}

// An agent's teams: access and folders, editable with Team membership: Update.
function AgentTeams ({ slug, m, canEdit }) {
  if (!m.teams.length) return <span className='muted'>Not in any teams you can see.</span>
  return m.teams.map((t) => canEdit
    ? (
      <form key={t.id} action={setAgentTeam} className='row'>
        <Hidden slug={slug} id={t.id} memberId={m.id} />
        <b>{t.name}</b>
        <select className='input' name='access' defaultValue={t.access} aria-label={`Access to ${t.name}`}>
          <option value='editor'>Editor</option>
          <option value='viewer'>Viewer</option>
        </select>
        <input className='input' name='folders' defaultValue={(t.scopes || []).join(', ')} placeholder='All folders' aria-label={`Folders in ${t.name}`} />
        <button className='btn ghost'>Save</button>
      </form>)
    : <span key={t.id} className='muted'>{t.name}: {t.access}{t.scopes?.length ? `, folders ${t.scopes.join(', ')}` : ''}</span>)
}

export default async function People ({ params, searchParams }) {
  const { slug } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}/people`)
  const me = await orgMe(user.accessToken, slug)
  if (!allowed(me, 'members', 'r') && !allowed(me, 'agents', 'r')) notFound()
  // Changing a person's role is Members: Update together with Roles: Update;
  // an agent's is Agents: Update. Removing an agent revokes it (Agents: Delete).
  const canAssign = allowed(me, 'members', 'u') && allowed(me, 'roles', 'u')
  const canRemove = allowed(me, 'members', 'd')
  const canSetAgentRole = allowed(me, 'agents', 'u')
  const canRevoke = allowed(me, 'agents', 'd')
  const canEditTeams = allowed(me, 'team_members', 'u')
  const [membersRes, rolesRes] = await Promise.all([
    apiCall(user, 'GET', `/v1/orgs/${slug}/members`),
    canAssign || canSetAgentRole ? apiCall(user, 'GET', `/v1/orgs/${slug}/roles`) : null
  ])
  const members = membersRes.data?.members || []
  const roles = assignableRoles(rolesRes?.data?.roles, me)
  const canPick = (m) => roles.length > 0 && (!m.roleId || roles.some((r) => r.id === m.roleId))
  return (
    <section className='card stack'>
      <h2>People and agents</h2>
      <Notice q={q} />
      {!membersRes.ok && <p className='notice bad'>Couldn't load the member list right now.</p>}
      <div>
        {members.map((m) => m.kind === 'agent'
          ? (
            <div key={m.id} className='list-row'>
              <span className='stack' style={{ gap: 6 }}>
                <span><b>{m.name}</b> <span className='pill'>Agent</span></span>
                <AgentTeams slug={slug} m={m} canEdit={canEditTeams} />
              </span>
              <span className='row'>
                {canSetAgentRole && canPick(m)
                  ? <RoleForm slug={slug} m={m} roles={roles} allowNone />
                  : <span className='pill'>{m.role || 'No role'}</span>}
                {canRevoke && (
                  <form action={removeMember}>
                    <Hidden slug={slug} id={m.id} />
                    <button className='btn ghost danger'>Revoke</button>
                  </form>)}
              </span>
            </div>)
          : (
            <div key={m.id} className='list-row'>
              <span>
                <b>{m.name || m.email}</b> {m.isYou && <span className='pill'>You</span>} {m.isOwner && <span className='pill'>Owner</span>}
                <br />
                <span className='muted'>{m.email}{m.teams.length ? ` · ${m.teams.map((t) => t.name).join(', ')}` : ''}</span>
              </span>
              <span className='row'>
                {canAssign && !m.isOwner && !m.isYou && m.roleId && roles.some((r) => r.id === m.roleId)
                  ? <RoleForm slug={slug} m={m} roles={roles} />
                  : <span className='pill'>{m.role || 'No role'}</span>}
                {m.isYou && !m.isOwner && (
                  <form action={leaveOrg}><input type='hidden' name='slug' value={slug} /><button className='btn ghost danger'>Leave</button></form>)}
                {canRemove && !m.isYou && !m.isOwner && (
                  <form action={removeMember}>
                    <Hidden slug={slug} id={m.id} />
                    <button className='btn ghost danger'>Remove</button>
                  </form>)}
              </span>
            </div>))}
      </div>
    </section>
  )
}
```

In `web/app/org/[slug]/teams/page.js`, replace

```js
                      <div key={m.memberId} className='list-row'>
                        <b>{m.name}</b>
```

with

```js
                      <div key={m.memberId} className='list-row'>
                        <span>
                          <b>{m.name}</b> {m.kind === 'agent' && <span className='pill'>Agent</span>}
                          {m.scopes?.length > 0 && <span className='muted'> · folders {m.scopes.join(', ')}</span>}
                        </span>
```

and

```js
                  {addable.map((p) => <option key={p.memberId} value={p.memberId}>{p.name}</option>)}
```

with

```js
                  {addable.map((p) => <option key={p.memberId} value={p.memberId}>{p.kind === 'agent' ? `${p.name} (agent)` : p.name}</option>)}
```

(Changing an agent's access on the Teams page keeps its folders: that form sends only `access`, and the API leaves folders alone when `scopes` is absent. Folders are edited on People.)

- [ ] **Step 6: Run the tests**

Run: `cd web && npm test && grep -rn "agent-setup\|NewAgent\|createAgent\|keyPrefix" app components lib test`
Expected: tests PASS, `# fail 0`; the grep prints nothing.

- [ ] **Step 7: Commit**

```bash
git add -A web/lib web/components web/app/dashboard web/app/org web/test
git commit -m "Show personal agents on the dashboard and org agents on People"
```

---

### Task 11: Deploy and check end to end

**Files:**
- None new (deploys what Tasks 1-10 built).

**Interfaces:**
- Consumes: everything above; the Supabase MCP (`execute_sql`, `apply_migration`, `list_tables`, `get_advisors`); the Fly and Netlify CLIs.
- Produces: the migration applied to project `pwebomewzuezaxoowykk`, `quilt-api` redeployed without `AGENT_KEY_SECRET`, the website redeployed to `https://heyquilt.com`.

- [ ] **Step 1: Run every test**

Run: `npm test && (cd web && npm test)`
Expected: both suites PASS, `# fail 0`.

- [ ] **Step 2: Confirm production has no agents (controller)**

With the Supabase MCP, `execute_sql` on project `pwebomewzuezaxoowykk`:

```sql
select (select count(*) from public.agents) as agents,
       (select count(*) from public.agent_rooms) as agent_rooms,
       (select count(*) from public.org_members where agent_id is not null) as org_agents;
```

Expected: `agents = 0`, `agent_rooms = 0`, `org_agents = 0`. If any is not 0, stop and ask the person: the migration drops agent key columns without carrying anything over.

- [ ] **Step 3: Apply the migration (controller)**

With the Supabase MCP: `apply_migration` on project `pwebomewzuezaxoowykk`, name `agent_sign_in`, query = the contents of `supabase/migrations/20260930020000_agent_sign_in.sql` (it runs as one transaction). Then:
- `list_tables` (schema `public`): `agents`, `agent_registrations`, `agent_keys` present with RLS enabled; `agents` has `owner_user_id`, `org_id`, `approved_by` and no `key_hash`.
- `get_advisors` type `security`: no new errors for these tables (RLS enabled with no policies on `agent_registrations`/`agent_keys` is an INFO-level note and expected: only the API reads them).
- `get_advisors` type `performance`: no unindexed foreign keys on the new columns.

(From here until Step 4 finishes, the old API's agent routes fail; there are no agents, so only the dashboard's "Your agents" list is briefly unavailable.)

- [ ] **Step 4: Merge, push and deploy the API (controller)**

```bash
git -C /Users/danielcarmichael/elegy merge claude/loving-boyd-2dd130
git -C /Users/danielcarmichael/elegy push
cd /Users/danielcarmichael/elegy && fly deploy --config fly.api.toml --app quilt-api --remote-only --ha=false
curl -s https://api.heyquilt.com/healthz
curl -s -X POST https://api.heyquilt.com/v1/agents/register -H 'content-type: application/json' -d '{"name":"x","publicKey":"nope"}'
cd /Users/danielcarmichael/elegy && QUILT_API=https://api.heyquilt.com node scripts/api-smoke.mjs
```

Expected: `{"ok":true}`; `{"error":"publicKey must be an Ed25519 key (spki, base64url)"}`; the smoke script prints `ok   health`, `ok   device/start`, `ok   poll pending`, `ok   agents/register`, `ok   agent poll pending`, then `set QUILT_TEST_JWT to check approve, profile and agents`. The `agents/register` check also confirms `approveUrl` points at `/agents/approve?code=` (it should start with `https://heyquilt.com`; if it doesn't, `QUILT_SITE_URL` on Fly is wrong and the person fixes it with `fly secrets set --app quilt-api QUILT_SITE_URL=https://heyquilt.com`).

- [ ] **Step 5: Remove the old secret (controller)**

Only now that the new API is live and no longer reads it:

```bash
fly secrets unset AGENT_KEY_SECRET --app quilt-api
curl -s https://api.heyquilt.com/healthz
```

Expected: Fly restarts the machine; `{"ok":true}`. (If `fly secrets list --app quilt-api` no longer shows `AGENT_KEY_SECRET`, this step is done.)

- [ ] **Step 6: Deploy the website (controller)**

From the main checkout (the Netlify CLI resolves the base from the main repo):

```bash
cd /Users/danielcarmichael/elegy/web && npm ci && cd .. && NETLIFY_SITE_ID=b9131760-8605-44f7-b9e1-3b347fc212b0 netlify deploy --build --prod
```

Expected: `Deploy is live!`.

- [ ] **Step 7: Check it end to end (controller + person)**

1. Controller, in the main checkout, starts the login in the background (it waits up to 15 minutes): `node bin/quilt.js agent login --name test-agent`. It prints `https://heyquilt.com/agents/approve?code=XXXX-XXXX`, the code and the key fingerprint; the controller gives the person the link and the code.
2. The person opens the link signed in, checks the code and the key match, sees "Only approve an agent you just started yourself.", leaves **Me (personal)** selected and clicks **Approve**. The page says "Agent approved"; the login command prints `Approved. test-agent's keys are saved in …/.quilt/agents/test-agent.json` and exits.
3. Controller runs `node bin/quilt.js agent whoami --name test-agent`. Expected: `test-agent: your personal agent`.
4. The person opens the dashboard: "Your agents" lists **test-agent** with an Agent pill, when it was added and last used, and a Revoke button. They click **Revoke**; the controller runs `whoami` again. Expected: it fails with `this agent's keys were revoked; approve it again`.
5. Org check (if the person has an org with a team): the controller runs `node bin/quilt.js agent login --name test-org-agent`; the person approves it into the org with one team as Editor and folder `src`; `whoami` prints `test-org-agent: an agent in <org>` and `Team <team>: editor, folders src`. On the org's People page the agent shows with an **Agent** pill and its team row; the person changes the folders to `docs`, saves, sees "Saved.", then clicks **Revoke**, and `whoami` fails as above.
6. The controller deletes the local test files: `rm ~/.quilt/agents/test-agent.json ~/.quilt/agents/test-org-agent.json`.

Fix anything that fails with a new commit, redeploy the part that changed (Step 4 or 6), and repeat the failing check.

---

## Self-review notes

- **Spec coverage (build-order item 2, "Agent sign-in"):** registration with an Ed25519 identity, per-IP rate limit, `{ requestId, userCode, approveUrl, interval, expiresIn }`, 15-minute expiry: Tasks 1, 6. Approval page with the agent's name and code, destination "Me (personal)" or an org where the viewer holds Agents: Create, teams limited to Team membership: Create, optional role under the subset rule, Approve/Deny: Tasks 6, 7, 9. Signed polling under `quilt-agent-register-v1`, first key pair returned once: Tasks 1, 6. Keys (`qa_` 1 hour, `qr_` 30 days single use, `POST /v1/agents/token`, families, reuse revokes the family, SHA-256 hashes only, revoking an agent revokes every family, "the dashboard shows why"): Tasks 4, 5, 10. "Replaces": dashboard Create agent flow, `key_hash`/`private_key_enc`/`key_prefix`/`owner_id` and `AGENT_KEY_SECRET` removed, `public_key` kept, `agent_rooms` untouched: Tasks 2, 3, 10, 11. Data model rows `agents`, `agent_registrations`, `agent_keys` and their RLS (no client reads of `request_hash` or any `agent_keys` column): Task 2. Permission rows Agents C/R/U/D and Team membership C/U for agents (approve, see, change role/teams/folders, revoke): Task 7. Website `/agents/approve`, personal Agents list with revoke, People & agents with an agent badge, teams and folders: Tasks 9, 10. Security: request ids and keys hashed, possession proven on poll, rate limits on register and refresh: Tasks 5, 6. Session passes, desktop sign-in and MCP are later plans.
- **Placeholder scan:** every code step has full code; every run step has a command and the expected result. The only person-supplied actions are approving on the website and (if needed) fixing `QUILT_SITE_URL` (Task 11).
- **Name consistency:** store methods `createAgent`, `agentById`, `agentByPublicKey`, `listPersonalAgents`, `touchAgent`, `revokeAgent`, `deleteAgent`, `addAgentMember`, `memberByAgent`, `createRegistration`, `registrationByRequest`, `registrationByUserCode`, `updateRegistration`, `claimRegistration`, `createAgentKeys`, `agentKeyByAccess`, `agentKeyByRefresh`, `listAgentKeys`, `claimRefresh`, `revokeFamily`, and `addTeamMember`/`setTeamAccess`/`teamsOfMember` with `scopes` are the same in Tasks 3-8 and in both stores. `makeAgentAuth` returns `mintKeys`, `refresh`, `agentFromRequest`, used as `ctx.agentAuth.*` by `routes/agents.js` and `routes/agent-register.js`. `keyStatus` values `active`/`reused`/`expired` match `agentStatus` in `web/lib/agent-view.js`. Identity helpers `signAgentRegister`, `verifyAgentRegister`, `keyFingerprint`, `AGENT_REGISTER_CONTEXT` are the same in the API, the CLI, the smoke script and the tests. Team access helpers `accessOf`, `cleanScopes` live in `src/api/team-access.js`. Website names `destinationFromForm`, `splitFolders`, `agentDestinations`, `decideAgent`, `setAgentTeam`, `agentStatus`, `AGENT_LOGIN_COMMAND` match between their definitions and uses.
- **Decisions made in this plan beyond the brief:** the registration signature is over `quilt-agent-register-v1\0<requestId>` directly rather than inside the relay's `cowove-auth-v1` payload, so neither can stand in for the other; request ids use the `qg_` prefix; every poll (pending ones too) must be signed; an approved registration can be collected until 5 minutes after it expires (like device links); a public key can belong to only one agent ever, so register and approve refuse a key already used (409) and `quilt agent login` always makes a new identity; reuse revokes the family, not the agent row, and `GET /v1/agents` reports `status` (`active`/`reused`/`expired`) so the dashboard can say why an agent is signed out; after a normal refresh the previous access key keeps working until its hour is up; a refresh that races a reuse detection re-checks and revokes its own new pair; an org agent is revoked by removing it from the org (`DELETE /v1/orgs/:slug/members/:id`, Agents: Delete) rather than a separate route; an agent member's role needs Agents: Update (not Members + Roles: Update) and may be none; the member list shows people with Members: Read and agents with Agents: Read (People tab for either); `org_members`' agent foreign key becomes composite `(agent_id, org_id)` and `agents.name` is limited to 1-40 characters; `agent_registrations.agent_id` is `on delete set null`; at most 50 teams per approval; token refresh is limited to 30 per minute per address; a failed org approval deletes the half-made agent and reopens the request; folders are edited on the People page (the Teams page shows them and an Agent pill); `web/lib/agent-setup.js` (MCP snippets) is removed with the old flow.
