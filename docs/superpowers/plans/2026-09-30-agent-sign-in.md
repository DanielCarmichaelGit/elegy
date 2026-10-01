# Quilt Agent Sign-in Implementation Plan (plan 2 of 4 in the orgs spec)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in person makes a one-time **agent invite link** (personal, or for an org with a role, teams, access and folders chosen up front), pastes it into their AI, and the AI uses it once to join as an agent with a short profile and gets a 1-hour access key and a rotating 30-day refresh key, with reuse detection. The old "Create agent / copy key" flow is removed.

**Architecture:** A new migration reshapes `agents` (no secrets; a profile: provider, type, description; `owner_user_id` or `org_id`; `invited_by`) and adds `agent_invites` and `agent_keys` (hashes only, no client access). The accounts API gets a key module (`src/api/agent-auth.js`: minting, single-use refresh with family revocation, `agentFromRequest`) and three route modules: `routes/agents.js` (token, `/me`, personal agents), `routes/agent-invites.js` (making, listing and cancelling invites) and `routes/join.js` (`/v1/join/:token`: GET explains, POST or GET-with-profile joins). Org agents fit into the existing member and team routes. A small CLI (`quilt agent join|whoami`) exercises the flow, and the website gets "Invite an agent" on the dashboard and the org People page, a new "Your agents" list, and agents on People.

**Tech Stack:** Node 22 ESM, `node:http`, `node:crypto` (SHA-256, Ed25519 key parsing), `node:test`; Supabase Postgres + `@supabase/supabase-js` 2.117; Next.js 16 App Router, React 19; Fly (`quilt-api`), Netlify (`heyquilt`).

**Spec:** `docs/superpowers/specs/2026-09-29-orgs-roles-agents-design.md` (build order item 2: "Agent sign-in", including "Agent invites", "Safeguards" and "Keys"; data-model rows `agents`, `agent_invites`, `agent_keys`; Security; Decisions). Previous plan: `docs/superpowers/plans/2026-09-29-orgs-roles-teams.md`.

## Global Constraints

- Out of scope: session passes (`/v1/sessions`, `PASS_SIGNING_KEY`, relay pass checks), desktop sign-in and the device-link signature fix, the MCP endpoint and tools, and agent safeguards 2 (the session owner's Allow / Deny the first time an agent joins each session) and 3 (the relay only sends an agent files inside its folders). Those belong to plans 3 and 4; the spec records them. `agent_rooms` is untouched. The MCP setup snippets (`web/lib/agent-setup.js`) go away with the old dashboard flow.
- Agent invites: made only by a signed-in person. Personal: `POST /v1/agent-invites` (no body fields). Org: `POST /v1/orgs/:slug/agent-invites { roleId?: uuid|null, teams?: [{ teamId, access?: 'editor'|'viewer', scopes?: [string] }] }` with **Agents: Create**; any team needs **Team membership: Create**; a `roleId` must pass `assignable()` (subset of the inviter's grid, never Owner); no `roleId` = **no role**; team `access` defaults to **viewer** (safeguard 5); at most 50 teams, each once. Both answer `{ invite, link }` with `link = ${apiUrl}/v1/join/${token}`; `apiUrl` comes from `QUILT_API_PUBLIC_URL` (default `https://api.heyquilt.com`). Token = `qj_` + 32 random bytes (base64url), stored only as its SHA-256 hash, **single use, expires 1 hour after creation** (safeguard 4). Listing: `GET /v1/agent-invites` (own personal invites) and `GET /v1/orgs/:slug/agent-invites` (Agents: Create), newest first, at most 50. Cancelling: `DELETE /v1/agent-invites/:id` (owner) and `DELETE /v1/orgs/:slug/agent-invites/:id` (Agents: Create); only a waiting invite can be cancelled (409 otherwise). Invite statuses: `waiting`, `used` (with `usedBy: { id, name, provider }`), `expired`, `cancelled`.
- Folders (`scopes`): at most **20** per team membership; each a relative path inside the project: trimmed, leading `./` and trailing `/` removed, no leading `/`, no `\`, no `..` segment, at most **200** characters; duplicates dropped. Only agent members have folders.
- Joining: `POST /v1/join/:token` JSON `{ name, provider, type, description?, publicKey? }`: `name`, `provider`, `type` each `cleanName(…, 40)` (1-40 characters); `description` optional, invisible characters stripped, cut to **180** characters; `publicKey` optional, must pass `parsePublicKey` and not belong to another agent (409). Everything is checked **before** the invite is used, so a bad request never burns it. Then: check-and-set the invite (open = not used, not cancelled, not expired), create the agent (`owner_user_id` or `org_id`, `invited_by` = the inviter, profile), for an org add the `org_members` row (the invite's role, may be null) and `team_members` rows (teams deleted since are skipped), mint the first pair, and return once: `{ agentId, accessKey, accessExpiresAt, refreshKey, refreshExpiresAt, api: apiUrl, refresh: `${apiUrl}/v1/agents/token`, mcp: `${apiUrl}/mcp`, next }` (`next` = short plain-text instructions; MCP is "coming soon"). If any step after the claim fails, the half-made agent is deleted and the invite reopened. `GET /v1/join/:token` with none of `name`/`provider`/`type` in the query returns `text/markdown` instructions only (what Quilt is, the exact POST body, and the GET alternative) and **never uses the invite**: 200 when open, 410 when used/expired/cancelled, 404 when unknown, each with a status line. `GET /v1/join/:token?name=&provider=&type=&description=` joins exactly like POST and answers the same JSON. All `/v1/join` responses carry `Cache-Control: no-store` and `X-Robots-Tag: noindex`. `/v1/join` is rate-limited per IP (default **20 per minute**; `fly-client-ip` when `QUILT_TRUST_PROXY=1`). Errors: 404 `this invite link isn't valid`; 410 `this invite was already used; ask for a new one` / `this invite has expired; ask for a new one` / `this invite was cancelled; ask for a new one`.
- Keys: access key `qa_` + 32 random bytes (base64url), valid **1 hour**; refresh key `qr_` + 32 random bytes, valid **30 days**, single use. Stored only as SHA-256 hashes in `agent_keys` rows, each with a `family_id`. `POST /v1/agents/token { refreshKey }` → a new pair in the same family; the old row's `refreshed_at` is set by CAS (`refreshed_at is null and revoked_at is null`). Presenting a refresh key whose row already has `refreshed_at` revokes every row of that family (`revoked_at`) and returns 401 `This key was already used, so this agent's keys were revoked. Invite it again.` Revoked or expired keys → 401. Revoking an agent revokes all its families. Token refresh is rate-limited per IP (default **30 per minute**).
- Agent auth for later plans: `agentFromRequest(req)` → `{ agent, keyRow }` or 401, from a `qa_` bearer (hash lookup, not expired, not revoked, agent not revoked), touching `last_used_at` at most once a minute. `GET /v1/agents/me` (agent auth) → `{ agent: { id, name, provider, type, description, kind: 'personal'|'org', org: { slug, name }|null }, teams: [{ id, name, access, scopes }], role: { name }|null }`.
- Management: `GET /v1/agents` (user) → the caller's live personal agents `[{ id, name, provider, type, description, createdAt, lastUsedAt, status: 'active'|'reused'|'expired' }]`; `DELETE /v1/agents/:id` revokes (owner only). Org agents are org members with `kind: 'agent'` (plus `provider`, `type`) in `GET /v1/orgs/:slug/members` (people need Members: Read, agents need Agents: Read). An agent member's role: `PUT /v1/orgs/:slug/members/:id` with **Agents: Update** (subset rule; `roleId: null` allowed). Its team access and folders: the team membership routes with **Team membership: Create/Update**. Removing it: `DELETE /v1/orgs/:slug/members/:id` with **Agents: Delete**, which revokes the agent.
- Data model: `agents` = `id, name (1-40), provider (1-40), type (1-40), description (≤ 180, default ''), public_key (nullable, unique), owner_user_id (→ profiles, cascade) or org_id (→ orgs, cascade), invited_by (→ auth.users, set null), created_at, last_used_at, revoked_at`; `key_prefix`, `key_hash`, `private_key_enc`, `owner_id` dropped. `agent_invites` = `id, token_hash (unique), owner_user_id or org_id, created_by, role_id, teams (jsonb array), expires_at, used_at, used_by_agent_id, cancelled_at, created_at` with a composite `(role_id, org_id) → roles (id, org_id)` key. `agent_keys` as in the spec. `agent_invites` and `agent_keys`: RLS on, **no client policies or grants**. Clients read personal agents (`owner_user_id = auth.uid()`) and org agents with `has_org_grant(org_id, 'agents', 'r')`; all writes go through the API. Migration: `supabase/migrations/20260930020000_agent_sign_in.sql`.
- Removed: `POST /v1/agents`, `src/api/agent-keys.js`, the `AGENT_KEY_SECRET` requirement and the `agentKeySecret` option, the dashboard's `NewAgent` / `createAgent` flow, `web/lib/agent-setup.js`.
- CLI: `quilt agent join <link> --name <name> [--provider <p>] [--type <t>] [--description <d>]` (defaults: provider `Quilt CLI`, type `command-line agent`) and `quilt agent whoami --name <name>`; keys saved to `~/.quilt/agents/<name>.json`, mode `0600`; names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`.
- Website: "Invite an agent" on the dashboard (personal) and on `/org/<slug>/people` (Agents: Create): the link is shown once with a Copy button and "Paste this into your AI."; an invite list shows Waiting, Used by `<name>` (`<provider>`), Expired, Cancelled, with Cancel for waiting ones. No em dashes in any user-facing copy (enforced on `web/app` and `web/components` by `web/test/no-em-dash.test.js`), in API messages, or in the join instructions. Existing classes only (`card`, `stack`, `row`, `btn`, `input`, `field`, `pill`, `notice`, `list-row`).
- Infra: Supabase project `pwebomewzuezaxoowykk`; API `https://api.heyquilt.com` (Fly app `quilt-api`, `QUILT_API_PUBLIC_URL=https://api.heyquilt.com`, deployed from the main checkout `/Users/danielcarmichael/elegy`); website `https://heyquilt.com` (Netlify site id `b9131760-8605-44f7-b9e1-3b347fc212b0`, deployed from the main checkout).
- API timestamps are epoch ms; Supabase rows are ISO strings (`rowFrom` converts every top-level `*At` column).
- Code style: Node 22 ESM, 2-space indent, no semicolons (`standard`), short comments that explain why; tests with `node:test` and `node:assert/strict`.

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/20260930020000_agent_sign_in.sql` | Reshape `agents`; `agent_invites`, `agent_keys`; RLS, grants; composite `(agent_id, org_id)` key on `org_members` |
| `src/api/memory-store.js`, `src/api/supabase-store.js` | Agents with a profile, agent members, agent invites, agent keys; agent names/profile and `kind` in member lists; team folders |
| `src/api/agent-auth.js` | `ACCESS_TTL_MS`, `REFRESH_TTL_MS`, `REUSED`, `keyStatus`, `makeAgentAuth` (`mintKeys`, `refresh`, `agentFromRequest`) |
| `src/api/team-access.js` | `ACCESS`, `accessOf`, `cleanScopes`, `MAX_SCOPES`, `MAX_SCOPE_LENGTH` |
| `src/api/join-text.js` | `joinInstructions`, `joinNext`: the plain text an AI reads |
| `src/api/http.js` | Adds `Raw` (a non-JSON reply) |
| `src/api/routes/agents.js` | `POST /v1/agents/token`, `GET /v1/agents/me`, `GET /v1/agents`, `DELETE /v1/agents/:id` |
| `src/api/routes/agent-invites.js` | Personal and org agent invites: create, list, cancel |
| `src/api/routes/join.js` | `GET` and `POST /v1/join/:token` |
| `src/api/routes/members.js`, `src/api/routes/teams.js` | Agents in the member list; agent roles; revoking by removal; folders on team membership |
| `src/api/server.js`, `bin/quilt.js`, `fly.api.toml`, `scripts/api-smoke.mjs` | Wiring, limiters, `Raw` replies, `apiUrl`; `AGENT_KEY_SECRET` removed; `QUILT_API_PUBLIC_URL`; `quilt agent` command |
| `src/agent-join.js` | `agentJoin`, `agentWhoami`, `agentFile`, `describeAgent`, `parseJoinLink` |
| `src/api/agent-keys.js`, `test/api-agent-keys.test.js` | Deleted |
| `test/api-helpers.js` | `API_URL`, limits for the new limiters, `makeAgent` |
| `test/api-migration-agents.test.js`, `test/api-store-agents.test.js`, `test/api-supabase-agents.test.js`, `test/api-agent-tokens.test.js`, `test/api-team-access.test.js`, `test/api-agent-invites.test.js`, `test/api-join.test.js`, `test/api-agent-orgs.test.js`, `test/agent-join.test.js` | New tests |
| `test/api.test.js`, `test/api-store.test.js`, `test/api-cli.test.js`, `test/api-teams.test.js`, `test/api-store-orgs.test.js`, `test/api-supabase-orgs.test.js` | Updated for the new agent shape, folders and `kind` |
| `web/lib/agent-form.js`, `web/lib/agent-view.js` | Invite form parsing; status text for agents and invites |
| `web/components/AgentInvite.js` | "Invite an agent": the form, and the link shown once with Copy |
| `web/app/dashboard/page.js`, `web/app/dashboard/actions.js` | "Your agents" and personal invites |
| `web/app/org/[slug]/people/*`, `web/app/org/[slug]/teams/page.js`, `web/lib/org-view.js` | Org agents and org invites on People; Agent pill on Teams; People tab for Agents: Read |
| `web/components/NewAgent.js`, `web/lib/agent-setup.js`, `web/test/agent-setup.test.js` | Deleted |

---

### Task 1: Migration for agent sign-in

**Files:**
- Create: `supabase/migrations/20260930020000_agent_sign_in.sql`
- Test: `test/api-migration-agents.test.js` (create)

**Interfaces:**
- Consumes: `public.agents`, `public.org_members`, `public.profiles`, `public.orgs`, `public.roles` (unique `(id, org_id)`), `public.has_org_grant(uuid, text, text)` from the earlier migrations.
- Produces (columns later tasks use through the Supabase store):
  - `agents (id, name, provider, type, description, public_key, owner_user_id, org_id, invited_by, created_at, last_used_at, revoked_at)`, unique `(id, org_id)`
  - `agent_invites (id, token_hash, owner_user_id, org_id, created_by, role_id, teams, expires_at, used_at, used_by_agent_id, cancelled_at, created_at)`
  - `agent_keys (id, agent_id, family_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, refreshed_at, revoked_at, created_at)`
  - `org_members_agent_id_fkey` = `(agent_id, org_id) → agents (id, org_id)` on delete cascade (the only `org_members → agents` relationship, so `agents (…)` embeds unambiguously)

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

test('agents lose their secrets and static owner, and gain a home, an inviter and a profile', () => {
  const s = sql()
  for (const col of ['key_prefix', 'key_hash', 'private_key_enc', 'owner_id']) assert.match(s, new RegExp(`drop column ${col},\\n`), col)
  assert.match(s, /add column owner_user_id uuid references public\.profiles \(id\) on delete cascade/)
  assert.match(s, /add column org_id uuid references public\.orgs \(id\) on delete cascade/)
  assert.match(s, /add column invited_by uuid references auth\.users \(id\) on delete set null/)
  assert.match(s, /add column provider text not null/)
  assert.match(s, /add column type text not null/)
  assert.match(s, /add column description text not null default ''/)
  assert.match(s, /alter table public\.agents alter column public_key drop not null;/)
  assert.match(s, /add constraint agents_one_home check \(\(owner_user_id is null\) <> \(org_id is null\)\)/)
  assert.match(s, /add constraint agents_name_length check \(char_length\(name\) between 1 and 40\)/)
  assert.match(s, /add constraint agents_provider_length check \(char_length\(provider\) between 1 and 40\)/)
  assert.match(s, /add constraint agents_type_length check \(char_length\(type\) between 1 and 40\)/)
  assert.match(s, /add constraint agents_description_length check \(char_length\(description\) <= 180\)/)
  assert.match(s, /add constraint agents_id_org_id_key unique \(id, org_id\)/)
  assert.ok(s.indexOf('drop policy "own agents: read"') < s.indexOf('drop column owner_id'), 'the old policies go before the column they read')
})

test("an agent member must be in the agent's own org", () => {
  const s = sql()
  assert.match(s, /alter table public\.org_members drop constraint org_members_agent_id_fkey;/)
  assert.match(s, /add constraint org_members_agent_id_fkey\s+foreign key \(agent_id, org_id\) references public\.agents \(id, org_id\) on delete cascade/)
})

test('agent invites: hashed single-use tokens, a person or an org, a same-org role', () => {
  const t = table(sql(), 'agent_invites')
  assert.match(t, /token_hash text not null unique/)
  assert.match(t, /owner_user_id uuid references public\.profiles \(id\) on delete cascade/)
  assert.match(t, /org_id uuid references public\.orgs \(id\) on delete cascade/)
  assert.match(t, /created_by uuid references auth\.users \(id\) on delete set null/)
  assert.match(t, /teams jsonb not null default '\[\]'::jsonb check \(jsonb_typeof\(teams\) = 'array'\)/)
  for (const col of ['expires_at timestamptz not null', 'used_at timestamptz', 'cancelled_at timestamptz']) assert.ok(t.includes(col), col)
  assert.match(t, /used_by_agent_id uuid references public\.agents \(id\) on delete set null/)
  assert.match(t, /check \(\(owner_user_id is null\) <> \(org_id is null\)\)/)
  assert.match(t, /check \(org_id is not null or role_id is null\)/)
  assert.match(t, /foreign key \(role_id, org_id\) references public\.roles \(id, org_id\) on delete set null \(role_id\)/)
})

test('agent keys hold hashes only, in families', () => {
  const keys = table(sql(), 'agent_keys')
  for (const col of ['access_hash text not null unique', 'refresh_hash text not null unique', 'family_id uuid not null', 'access_expires_at timestamptz not null', 'refresh_expires_at timestamptz not null', 'refreshed_at timestamptz', 'revoked_at timestamptz']) assert.ok(keys.includes(col), col)
  assert.match(keys, /agent_id uuid not null references public\.agents \(id\) on delete cascade/)
})

test('clients never touch invites or keys, and only read agents', () => {
  const s = sql()
  for (const t of ['agent_invites', 'agent_keys']) assert.match(s, new RegExp(`alter table public\\.${t} enable row level security`), t)
  assert.doesNotMatch(s, /create policy [^\n]*on public\.(agent_invites|agent_keys)/)
  for (const line of clientGrants(s)) {
    assert.doesNotMatch(line, /agent_invites|agent_keys|_hash/, line)
    assert.doesNotMatch(line, /^grant (insert|update|delete|all)/, line)
  }
  assert.match(s, /revoke all on public\.agents from anon, authenticated;/)
  assert.match(s, /revoke all on public\.agent_invites, public\.agent_keys from anon, authenticated;/)
  assert.match(s, /grant select \(id, name, provider, type, description, public_key, owner_user_id, org_id, invited_by, created_at, last_used_at, revoked_at\) on public\.agents to authenticated;/)
  assert.match(s, /grant all on public\.agents, public\.agent_invites, public\.agent_keys to service_role;/)
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
  for (const idx of [
    'agents_owner_user_id on public.agents (owner_user_id)', 'agents_org_id on public.agents (org_id)', 'agents_invited_by on public.agents (invited_by)',
    'agent_invites_owner_user_id on public.agent_invites (owner_user_id)', 'agent_invites_org_id on public.agent_invites (org_id)',
    'agent_invites_created_by on public.agent_invites (created_by)', 'agent_invites_role_id on public.agent_invites (role_id)',
    'agent_invites_used_by_agent_id on public.agent_invites (used_by_agent_id)',
    'agent_keys_agent_id on public.agent_keys (agent_id)', 'agent_keys_family_id on public.agent_keys (family_id)'
  ]) assert.ok(s.includes(`create index ${idx}`), idx)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/api-migration-agents.test.js`
Expected: FAIL with `ENOENT: no such file or directory` for the migration.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260930020000_agent_sign_in.sql`:

```sql
-- Agent sign-in: a signed-in person makes a one-time agent invite link, and an
-- AI that uses it joins as an agent with its own keys and a short profile. The
-- API no longer holds agents' private keys or a static key, so those columns
-- go. No agents exist yet (checked before this runs), so nothing carries over.

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
  add column invited_by uuid references auth.users (id) on delete set null,
  add column provider text not null,
  add column type text not null,
  add column description text not null default '';

-- An agent may bring its own Ed25519 key when it joins; when it does, the key is
-- one agent's only (unique still holds, and allows many nulls).
alter table public.agents alter column public_key drop not null;

-- A personal agent belongs to one person; an org agent to one org. Never both.
alter table public.agents add constraint agents_one_home check ((owner_user_id is null) <> (org_id is null));
alter table public.agents add constraint agents_name_length check (char_length(name) between 1 and 40);
alter table public.agents add constraint agents_provider_length check (char_length(provider) between 1 and 40);
alter table public.agents add constraint agents_type_length check (char_length(type) between 1 and 40);
alter table public.agents add constraint agents_description_length check (char_length(description) <= 180);
-- Lets org_members take a composite (agent_id, org_id) foreign key.
alter table public.agents add constraint agents_id_org_id_key unique (id, org_id);

create index agents_owner_user_id on public.agents (owner_user_id);
create index agents_org_id on public.agents (org_id);
create index agents_invited_by on public.agents (invited_by);

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
grant select (id, name, provider, type, description, public_key, owner_user_id, org_id, invited_by, created_at, last_used_at, revoked_at) on public.agents to authenticated;

create table public.agent_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  owner_user_id uuid references public.profiles (id) on delete cascade,
  org_id uuid references public.orgs (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  role_id uuid,
  -- [{ teamId, access, scopes }]: checked by the API when the invite is made, and teams are re-checked when it's used.
  teams jsonb not null default '[]'::jsonb check (jsonb_typeof(teams) = 'array'),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_agent_id uuid references public.agents (id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  check ((owner_user_id is null) <> (org_id is null)),
  -- A personal invite has no org role to give.
  check (org_id is not null or role_id is null),
  -- Composite, like org_invites, so a role from another org can never be attached.
  -- A deleted role only clears role_id: the invite is at most an hour old.
  foreign key (role_id, org_id) references public.roles (id, org_id) on delete set null (role_id)
);
create index agent_invites_owner_user_id on public.agent_invites (owner_user_id);
create index agent_invites_org_id on public.agent_invites (org_id);
create index agent_invites_created_by on public.agent_invites (created_by);
create index agent_invites_role_id on public.agent_invites (role_id);
create index agent_invites_used_by_agent_id on public.agent_invites (used_by_agent_id);

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

alter table public.agent_invites enable row level security;
alter table public.agent_keys enable row level security;

-- No client policies or grants: invite tokens and key hashes are only for the API.
revoke all on public.agent_invites, public.agent_keys from anon, authenticated;

-- The API is trusted with everything; don't depend on project default privileges.
grant all on public.agents, public.agent_invites, public.agent_keys to service_role;
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/api-migration-agents.test.js`
Expected: PASS, `# pass 7`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260930020000_agent_sign_in.sql test/api-migration-agents.test.js
git commit -m "Add the agent sign-in migration"
```

---
### Task 2: Store: the new agent shape, agent members, and retiring the static-key flow

The store's agent methods change shape, so the three old routes that use them are retired in the same task: `POST /v1/agents` goes, and `GET`/`DELETE /v1/agents` move to a new route module on the new methods. `AGENT_KEY_SECRET` and `src/api/agent-keys.js` go with them.

**Files:**
- Modify: `src/api/memory-store.js`, `src/api/supabase-store.js`, `src/api/server.js`, `bin/quilt.js`, `fly.api.toml`, `scripts/api-smoke.mjs`
- Create: `src/api/routes/agents.js`, `test/api-store-agents.test.js`, `test/api-supabase-agents.test.js`
- Delete: `src/api/agent-keys.js`, `test/api-agent-keys.test.js`
- Modify tests: `test/api.test.js`, `test/api-store.test.js`, `test/api-cli.test.js`, `test/api-helpers.js`

**Interfaces:**
- Consumes: the Task 1 columns.
- Produces (both stores; rows are camelCase with epoch-ms `*At`):
  - `createAgent({ name, provider, type, description = '', publicKey = null, ownerUserId = null, orgId = null, invitedBy = null }) -> Agent` where `Agent = { id, name, provider, type, description, publicKey, ownerUserId, orgId, invitedBy, createdAt, lastUsedAt, revokedAt }`; throws `{ code: '23505' }` for a taken public key, `{ code: '23514' }` unless exactly one of `ownerUserId`/`orgId` is set
  - `agentById(id) -> Agent|null`, `agentByPublicKey(publicKey) -> Agent|null` (null for an empty key)
  - `listPersonalAgents(userId) -> Agent[]` (not revoked, oldest first)
  - `touchAgent(id) -> void` (sets `lastUsedAt` to now)
  - `revokeAgent(id) -> boolean` (true only the first time; also revokes every key row of the agent)
  - `deleteAgent(id) -> void` (cascades to its keys and membership; an invite it used keeps a null `usedByAgentId`)
  - `addAgentMember({ orgId, agentId, roleId = null }) -> Member` (`{ code: '23503' }` unless the agent is that org's; `{ code: '23505' }` if already in)
  - `memberByAgent(orgId, agentId) -> Member|null`
  - `listMembers(orgId)` rows gain `provider` and `type` (null for people) and name agents after the agent; `listTeamMembers(teamId)` rows gain `kind: 'person'|'agent'`
  - The memory store keeps the maps `agentInvites` and `keyRows` (filled by Task 3)
  - `agentRoutes(ctx)` in `src/api/routes/agents.js` with `GET /v1/agents` → `{ agents: [{ id, name, provider, type, description, createdAt, lastUsedAt }] }` and `DELETE /v1/agents/:id` (owner only, 404 otherwise); Task 4 rewrites this file
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
const profile = (name, extra = {}) => ({ name, provider: 'Anthropic', type: 'coding agent', ...extra })

test('agents belong to one person or one org, carry a profile, and a key belongs to one agent', async () => {
  const s = setup()
  const o = await org(s)
  const mine = await s.createAgent(profile('Larry', { description: 'Writes tests', publicKey: 'pk1', ownerUserId: 'u1', invitedBy: 'u1' }))
  assert.deepEqual(
    [mine.name, mine.provider, mine.type, mine.description, mine.ownerUserId, mine.orgId, mine.invitedBy, mine.revokedAt, mine.lastUsedAt],
    ['Larry', 'Anthropic', 'coding agent', 'Writes tests', 'u1', null, 'u1', null, null]
  )
  const theirs = await s.createAgent(profile('Bot', { orgId: o.id, invitedBy: 'u1' }))
  assert.deepEqual([theirs.orgId, theirs.publicKey, theirs.description], [o.id, null, ''])
  await s.createAgent(profile('NoKey', { ownerUserId: 'u2' }))
  await assert.rejects(s.createAgent(profile('Dup', { publicKey: 'pk1', ownerUserId: 'u2' })), (err) => err.code === '23505')
  await assert.rejects(s.createAgent(profile('Both', { ownerUserId: 'u1', orgId: o.id })), (err) => err.code === '23514')
  await assert.rejects(s.createAgent(profile('Neither')), (err) => err.code === '23514')
  assert.equal((await s.agentById(mine.id)).name, 'Larry')
  assert.equal((await s.agentByPublicKey('pk1')).id, mine.id)
  assert.equal(await s.agentByPublicKey('nope'), null)
  assert.equal(await s.agentByPublicKey(null), null)
  assert.deepEqual((await s.listPersonalAgents('u1')).map((a) => a.id), [mine.id], 'org agents are not personal')
})

test('touching and revoking an agent; revoked agents leave the personal list', async () => {
  const s = setup()
  const a = await s.createAgent(profile('Larry', { ownerUserId: 'u1', invitedBy: 'u1' }))
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
  const bot = await s.createAgent(profile('Bot', { orgId: o.id, invitedBy: 'u1' }))
  const mine = await s.createAgent(profile('Larry', { ownerUserId: 'u1', invitedBy: 'u1' }))
  const m = await s.addAgentMember({ orgId: o.id, agentId: bot.id, roleId: null })
  assert.deepEqual([m.agentId, m.userId, m.roleId], [bot.id, null, null])
  await assert.rejects(s.addAgentMember({ orgId: other.id, agentId: bot.id }), (err) => err.code === '23503')
  await assert.rejects(s.addAgentMember({ orgId: o.id, agentId: mine.id }), (err) => err.code === '23503', 'a personal agent')
  await assert.rejects(s.addAgentMember({ orgId: o.id, agentId: bot.id }), (err) => err.code === '23505', 'once per org')
  assert.equal((await s.memberByAgent(o.id, bot.id)).id, m.id)
  assert.deepEqual((await s.listMembers(o.id)).map((x) => [x.name, x.provider, x.type]), [['Dana', null, null], ['Bot', 'Anthropic', 'coding agent']])
  const team = await s.createTeam({ orgId: o.id, name: 'Core' })
  await s.addTeamMember({ teamId: team.id, memberId: m.id, access: 'viewer' })
  await s.addTeamMember({ teamId: team.id, memberId: (await s.memberOf(o.id, 'u1')).id, access: 'editor' })
  assert.deepEqual((await s.listTeamMembers(team.id)).map((x) => [x.name, x.kind]), [['Bot', 'agent'], ['Dana', 'person']])
})

test('deleting an agent, its org or its person removes it and its membership', async () => {
  const s = setup()
  const o = await org(s)
  const bot = await s.createAgent(profile('Bot', { orgId: o.id, invitedBy: 'u2' }))
  await s.addAgentMember({ orgId: o.id, agentId: bot.id })
  await s.deleteAgent(bot.id)
  assert.equal(await s.agentById(bot.id), null)
  assert.equal(await s.memberByAgent(o.id, bot.id), null)
  const bot2 = await s.createAgent(profile('Bot', { orgId: o.id, invitedBy: 'u2' }))
  await s.addAgentMember({ orgId: o.id, agentId: bot2.id })
  const larry = await s.createAgent(profile('Larry', { ownerUserId: 'u2', invitedBy: 'u2' }))
  await s.deleteUser('u2')
  assert.equal(await s.agentById(larry.id), null, "a person's own agents go with them")
  assert.equal((await s.agentById(bot2.id)).invitedBy, null, 'org agents stay; the inviter is forgotten')
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
const agentRow = { id: 'a1', name: 'Larry', provider: 'Anthropic', type: 'coding agent', description: '', public_key: null, owner_user_id: 'u1', org_id: null, invited_by: 'u1', created_at: ISO, last_used_at: null, revoked_at: null }

test('supabase createAgent writes the profile and home, and selects no secrets', async () => {
  const { client, calls } = fakeDb(() => agentRow)
  const a = await createSupabaseStore({ client }).createAgent({ name: 'Larry', provider: 'Anthropic', type: 'coding agent', ownerUserId: 'u1', invitedBy: 'u1' })
  assert.deepEqual([a.id, a.provider, a.ownerUserId, a.orgId, a.createdAt], ['a1', 'Anthropic', 'u1', null, Date.parse(ISO)])
  assert.deepEqual(calls[0].ops.find(([op]) => op === 'insert')[1], { name: 'Larry', provider: 'Anthropic', type: 'coding agent', description: '', public_key: null, owner_user_id: 'u1', org_id: null, invited_by: 'u1' })
  assert.equal(calls[0].ops.find(([op]) => op === 'select')[1], 'id, name, provider, type, description, public_key, owner_user_id, org_id, invited_by, created_at, last_used_at, revoked_at')
})

test("supabase listPersonalAgents reads only the person's live agents; agentByPublicKey skips empty keys", async () => {
  const { client, calls } = fakeDb(() => [agentRow])
  const s = createSupabaseStore({ client })
  const [a] = await s.listPersonalAgents('u1')
  assert.equal(a.name, 'Larry')
  assert.ok(has(calls[0], 'eq', 'owner_user_id', 'u1'))
  assert.ok(has(calls[0], 'is', 'revoked_at', null))
  assert.equal(await s.agentByPublicKey(null), null)
  assert.equal(calls.length, 1, 'no query for an empty key')
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

test('supabase member lists name agents from the agents table, with their profile', async () => {
  const { client, calls } = fakeDb((q) => q.table === 'org_members'
    ? [{ id: 'm2', org_id: 'o1', user_id: null, agent_id: 'a1', role_id: null, joined_at: ISO, profiles: null, agents: { name: 'Bot', provider: 'OpenAI', type: 'coding agent' } }]
    : [{ team_id: 't1', member_id: 'm2', access: 'viewer', scopes: ['src'], added_at: ISO, org_members: { user_id: null, agent_id: 'a1', profiles: null, agents: { name: 'Bot' } } }])
  const s = createSupabaseStore({ client })
  const [m] = await s.listMembers('o1')
  assert.deepEqual([m.name, m.provider, m.type, m.agentId, 'agents' in m, 'profiles' in m], ['Bot', 'OpenAI', 'coding agent', 'a1', false, false])
  assert.match(calls[0].ops.find(([op]) => op === 'select')[1], /agents \(name, provider, type\)/)
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
  const agentInvites = new Map(); const keyRows = new Map()
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
  // An org member is a person (named by their profile) or an agent (named when it joined).
  const memberName = (m) => (m?.agentId ? agents.get(m.agentId)?.name || '' : nameOf(m?.userId))
  // Deleting an agent takes its keys and membership with it, like the cascades in
  // Postgres; an invite it used only forgets it (on delete set null).
  const dropAgent = (id) => {
    agents.delete(id)
    for (const [k, key] of keyRows) if (key.agentId === id) keyRows.delete(k)
    for (const [k, m] of members) if (m.agentId === id) dropMember(k)
    for (const i of agentInvites.values()) if (i.usedByAgentId === id) i.usedByAgentId = null
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
    // Agents hold their own keys; at most a public key is kept here. Mirrors
    // agents_one_home (a person's or an org's, never both) and the unique public_key.
    async createAgent ({ name, provider, type, description = '', publicKey = null, ownerUserId = null, orgId = null, invitedBy = null }) {
      if ((ownerUserId == null) === (orgId == null)) throw Object.assign(new Error('an agent belongs to one person or one org'), { code: '23514' })
      if (publicKey && all(agents, (a) => a.publicKey === publicKey).length) throw duplicate('agent')
      const row = { id: uuid(), name, provider, type, description, publicKey, ownerUserId, orgId, invitedBy, createdAt: now(), lastUsedAt: null, revokedAt: null }
      agents.set(row.id, row); return copy(row)
    },
    async agentById (id) { return copy(agents.get(id)) },
    async agentByPublicKey (publicKey) { return publicKey ? copy(all(agents, (a) => a.publicKey === publicKey)[0]) : null },
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
    // Only for undoing a half-finished join.
    async deleteAgent (id) { dropAgent(id) },
    async deleteUser (userId) {
      profiles.delete(userId); users.delete(userId)
      for (const [id, d] of devices) if (d.userId === userId) devices.delete(id)
      for (const [id, a] of agents) if (a.ownerUserId === userId) dropAgent(id)
      for (const a of agents.values()) if (a.invitedBy === userId) a.invitedBy = null
      for (const [id, i] of agentInvites) if (i.ownerUserId === userId) agentInvites.delete(id)
      for (const i of agentInvites.values()) if (i.createdBy === userId) i.createdBy = null
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
      for (const [k, i] of agentInvites) if (i.orgId === id) agentInvites.delete(k)
      for (const [k, m] of members) if (m.orgId === id) dropMember(k)
```

Replace `listMembers`:

```js
    async listMembers (orgId) { return all(members, (m) => m.orgId === orgId).map((m) => ({ ...copy(m), name: nameOf(m.userId) })).sort((a, b) => a.joinedAt - b.joinedAt) },
```

with

```js
    async listMembers (orgId) {
      return all(members, (m) => m.orgId === orgId)
        .map((m) => {
          const a = m.agentId ? agents.get(m.agentId) : null
          return { ...copy(m), name: memberName(m), provider: a?.provider ?? null, type: a?.type ?? null }
        })
        .sort((a, b) => a.joinedAt - b.joinedAt)
    },
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
const AGENT = 'id, name, provider, type, description, public_key, owner_user_id, org_id, invited_by, created_at, last_used_at, revoked_at'
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
    async createAgent ({ name, provider, type, description = '', publicKey = null, ownerUserId = null, orgId = null, invitedBy = null }) {
      return rowFrom(await one(db.from('agents')
        .insert({ name, provider, type, description, public_key: publicKey, owner_user_id: ownerUserId, org_id: orgId, invited_by: invitedBy })
        .select(AGENT).single()))
    },
    async agentById (id) { return rowFrom(await one(db.from('agents').select(AGENT).eq('id', id).maybeSingle())) },
    async agentByPublicKey (publicKey) {
      if (!publicKey) return null
      return rowFrom(await one(db.from('agents').select(AGENT).eq('public_key', publicKey).maybeSingle()))
    },
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
    // Only for undoing a half-finished join; cascades to its keys and membership.
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
      const rows = await one(db.from('org_members').select(`${MEMBER}, profiles (name), agents (name, provider, type)`).eq('org_id', orgId).order('joined_at'))
      return rows.map(({ profiles, agents, ...r }) => ({ ...rowFrom(r), name: profiles?.name || agents?.name || '', provider: agents?.provider ?? null, type: agents?.type ?? null }))
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
// A person's personal agents. (Task 4 adds the agents' own key and /me routes.)
import { HttpError, needId } from '../http.js'

const agentView = (a) => ({ id: a.id, name: a.name, provider: a.provider, type: a.type, description: a.description, createdAt: a.createdAt, lastUsedAt: a.lastUsedAt })

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
- In the `startApi` parameter list, delete `agentKeySecret, `.
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
  const a = await store.createAgent({ name: 'Larry', provider: 'Anthropic', type: 'coding agent', ownerUserId: 'u1', invitedBy: 'u1' })
  const list = await call('GET', '/v1/agents', null, 'user:u1')
  assert.deepEqual(list.body.agents.map((x) => [x.id, x.name, x.provider, x.type]), [[a.id, 'Larry', 'Anthropic', 'coding agent']])
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
  const a = await s.createAgent({ name: 'A', provider: 'Anthropic', type: 'coding agent', ownerUserId: 'gone', invitedBy: 'gone' })
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

Run: `npm test && grep -rn "agentKeySecret\|AGENT_KEY_SECRET\|agent-keys\|agentByKey\|listAgents(" src bin test scripts`
Expected: tests PASS, `# fail 0`; the grep prints nothing.

- [ ] **Step 9: Commit**

```bash
git add -A src/api bin/quilt.js fly.api.toml scripts/api-smoke.mjs test
git commit -m "Reshape agents in the stores and retire the static agent key"
```

---
### Task 3: Store: agent invites, agent keys and team folders

**Files:**
- Modify: `src/api/memory-store.js`, `src/api/supabase-store.js`
- Test: `test/api-store-agents.test.js`, `test/api-supabase-agents.test.js` (append); `test/api-store-orgs.test.js`, `test/api-supabase-orgs.test.js` (update)

**Interfaces:**
- Consumes: Task 2's `agentInvites` and `keyRows` maps, `createAgent`, `revokeAgent`, `dropAgent`.
- Produces (both stores):
  - `createAgentInvite({ tokenHash, ownerUserId = null, orgId = null, createdBy = null, roleId = null, teams = [], expiresAt }) -> Invite` where `Invite = { id, tokenHash, ownerUserId, orgId, createdBy, roleId, teams: [{ teamId, access, scopes }], expiresAt, usedAt: null, usedByAgentId: null, cancelledAt: null, createdAt }`; `{ code: '23514' }` unless exactly one of `ownerUserId`/`orgId` (and no role without an org); `{ code: '23503' }` for a role from another org
  - `agentInviteByToken(hash) -> Invite|null`, `agentInviteById(id) -> Invite|null`
  - `listAgentInvites({ ownerUserId } | { orgId }) -> Invite[]` (newest first, at most 50)
  - `claimAgentInvite(id) -> boolean` (sets `usedAt` only while not used, not cancelled, not expired)
  - `releaseAgentInvite(id) -> void` (clears `usedAt` and `usedByAgentId`, undoing a claim)
  - `setInviteAgent(id, agentId) -> void`
  - `cancelAgentInvite(id) -> boolean` (sets `cancelledAt` only while not used and not cancelled)
  - deleting a role clears `roleId` on agent invites that named it
  - `createAgentKeys({ agentId, familyId, accessHash, refreshHash, accessExpiresAt, refreshExpiresAt }) -> KeyRow` where `KeyRow = { id, agentId, familyId, accessHash, refreshHash, accessExpiresAt, refreshExpiresAt, refreshedAt: null, revokedAt: null, createdAt }`
  - `agentKeyByAccess(hash)`, `agentKeyByRefresh(hash) -> KeyRow|null`, `listAgentKeys(agentId) -> KeyRow[]`
  - `claimRefresh(id) -> boolean` (sets `refreshedAt` only if unset and not revoked); `revokeFamily(familyId) -> void`
  - `addTeamMember({ teamId, memberId, access, scopes = [] })`; `setTeamAccess(teamId, memberId, access, scopes?)` (folders unchanged when `scopes` is `undefined`); `teamsOfMember(memberId) -> [{ teamId, access, scopes }]`

- [ ] **Step 1: Write the failing tests**

Append to `test/api-store-agents.test.js`:

```js
test('agent invites: a person or an org, found by token, used once while open, cancelled once', async () => {
  const s = setup()
  const o = await org(s)
  const role = (await s.listRoles(o.id)).find((r) => r.builtin === 'member')
  const t = Date.now()
  const mine = await s.createAgentInvite({ tokenHash: 'h1', ownerUserId: 'u1', createdBy: 'u1', expiresAt: t + 60_000 })
  assert.deepEqual([mine.usedAt, mine.usedByAgentId, mine.cancelledAt, mine.teams, mine.roleId], [null, null, null, [], null])
  const theirs = await s.createAgentInvite({ tokenHash: 'h2', orgId: o.id, createdBy: 'u1', roleId: role.id, teams: [{ teamId: 't1', access: 'viewer', scopes: ['src'] }], expiresAt: t + 60_000 })
  assert.deepEqual(theirs.teams, [{ teamId: 't1', access: 'viewer', scopes: ['src'] }])
  await assert.rejects(s.createAgentInvite({ tokenHash: 'h3', ownerUserId: 'u1', orgId: o.id, expiresAt: t }), (err) => err.code === '23514')
  await assert.rejects(s.createAgentInvite({ tokenHash: 'h3', ownerUserId: 'u1', roleId: role.id, expiresAt: t }), (err) => err.code === '23514', 'no role without an org')
  const other = await org(s, 'other')
  await assert.rejects(s.createAgentInvite({ tokenHash: 'h3', orgId: other.id, roleId: role.id, expiresAt: t }), (err) => err.code === '23503')
  assert.equal((await s.agentInviteByToken('h1')).id, mine.id)
  assert.equal((await s.agentInviteById(theirs.id)).orgId, o.id)
  assert.equal(await s.agentInviteByToken('nope'), null)
  assert.deepEqual((await s.listAgentInvites({ ownerUserId: 'u1' })).map((i) => i.id), [mine.id])
  assert.deepEqual((await s.listAgentInvites({ orgId: o.id })).map((i) => i.id), [theirs.id])

  assert.equal(await s.claimAgentInvite(mine.id), true)
  assert.equal(await s.claimAgentInvite(mine.id), false, 'once')
  assert.equal(await s.cancelAgentInvite(mine.id), false, 'a used invite is not cancelled')
  await s.releaseAgentInvite(mine.id)
  assert.equal((await s.agentInviteById(mine.id)).usedAt, null, 'a failed join reopens it')
  const bot = await s.createAgent(profile('Bot', { ownerUserId: 'u1' }))
  assert.equal(await s.claimAgentInvite(mine.id), true)
  await s.setInviteAgent(mine.id, bot.id)
  assert.equal((await s.agentInviteById(mine.id)).usedByAgentId, bot.id)

  assert.equal(await s.cancelAgentInvite(theirs.id), true)
  assert.equal(await s.cancelAgentInvite(theirs.id), false)
  assert.equal(await s.claimAgentInvite(theirs.id), false, 'a cancelled invite is never used')
  const old = await s.createAgentInvite({ tokenHash: 'h4', ownerUserId: 'u1', expiresAt: Date.now() - 1 })
  assert.equal(await s.claimAgentInvite(old.id), false, 'an expired invite is never used')
})

test("deleting a role clears it from agent invites; deleting the inviter's org or account removes theirs", async () => {
  const s = setup()
  const o = await org(s)
  const lead = await s.createRole({ orgId: o.id, name: 'Lead', grants: {} })
  const i = await s.createAgentInvite({ tokenHash: 'h1', orgId: o.id, createdBy: 'u2', roleId: lead.id, expiresAt: Date.now() + 60_000 })
  await s.deleteRole(lead.id)
  assert.equal((await s.agentInviteById(i.id)).roleId, null)
  const p = await s.createAgentInvite({ tokenHash: 'h2', ownerUserId: 'u2', createdBy: 'u2', expiresAt: Date.now() + 60_000 })
  await s.deleteUser('u2')
  assert.equal(await s.agentInviteById(p.id), null)
  assert.equal((await s.agentInviteById(i.id)).createdBy, null)
  await s.deleteOrg(o.id)
  assert.equal(await s.agentInviteById(i.id), null)
})

test('agent keys: found by either hash; a refresh key is spent once; a family is revoked together', async () => {
  const s = setup()
  const a = await s.createAgent(profile('Larry', { ownerUserId: 'u1', invitedBy: 'u1' }))
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
  const bot = await s.createAgent(profile('Bot', { orgId: o.id, invitedBy: 'u1' }))
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
test('supabase agent invites: ISO expiry, filtered lists, and check-and-set claim and cancel', async () => {
  const row = { id: 'i1', token_hash: 'h', owner_user_id: 'u1', org_id: null, created_by: 'u1', role_id: null, teams: [], expires_at: ISO, used_at: null, used_by_agent_id: null, cancelled_at: null, created_at: ISO }
  const { client, calls } = fakeDb((q) => (q.ops.some(([op]) => op === 'update') ? [{ id: 'i1' }] : q.ops.some(([op]) => op === 'limit') ? [row] : row))
  const s = createSupabaseStore({ client })
  const made = await s.createAgentInvite({ tokenHash: 'h', ownerUserId: 'u1', createdBy: 'u1', expiresAt: Date.parse(ISO) })
  assert.deepEqual([made.expiresAt, made.usedAt, made.teams], [Date.parse(ISO), null, []])
  assert.equal(calls[0].ops.find(([op]) => op === 'insert')[1].expires_at, ISO)
  await s.agentInviteByToken('h')
  assert.ok(has(calls[1], 'eq', 'token_hash', 'h'))
  await s.listAgentInvites({ orgId: 'o1' })
  assert.ok(has(calls[2], 'eq', 'org_id', 'o1'))
  assert.ok(has(calls[2], 'order', 'created_at', { ascending: false }))
  assert.ok(has(calls[2], 'limit', 50))
  await s.listAgentInvites({ ownerUserId: 'u1' })
  assert.ok(has(calls[3], 'eq', 'owner_user_id', 'u1'))
  assert.equal(await s.claimAgentInvite('i1'), true)
  assert.ok(has(calls[4], 'is', 'used_at', null))
  assert.ok(has(calls[4], 'is', 'cancelled_at', null))
  assert.ok(calls[4].ops.some(([op, col]) => op === 'gt' && col === 'expires_at'), 'only while unexpired')
  assert.equal(await s.cancelAgentInvite('i1'), true)
  assert.ok(has(calls[5], 'is', 'used_at', null))
  assert.ok(has(calls[5], 'is', 'cancelled_at', null))
  await s.releaseAgentInvite('i1')
  assert.ok(has(calls[6], 'update', { used_at: null, used_by_agent_id: null }))
  await s.setInviteAgent('i1', 'a1')
  assert.ok(has(calls[7], 'update', { used_by_agent_id: 'a1' }))
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
Expected: FAIL: `s.createAgentInvite is not a function`, `s.createAgentKeys is not a function`, and the two `scopes` deepEqual mismatches.

- [ ] **Step 3: Implement the memory store**

In `src/api/memory-store.js`, after the `fkViolation` helper at the top, add:

```js
// Postgres's check-violation code, mirrored for the checks the schema makes.
const checkViolation = (what) => Object.assign(new Error(what), { code: '23514' })
const tooManyFolders = (scopes) => { if (scopes.length > 20) throw checkViolation('at most 20 folders') }
```

In `deleteRole`, change its last line `      roles.delete(id)` to:

```js
      // agent_invites' role key is "on delete set null (role_id)": the invite keeps going without a role.
      for (const i of agentInvites.values()) if (i.roleId === id) i.roleId = null
      roles.delete(id)
```

After `async deleteAgent (id) { dropAgent(id) },` add:

```js
    // Agent invites: only the token's hash is kept. Mirrors the one-home and
    // no-role-without-an-org checks and the composite (role_id, org_id) key.
    async createAgentInvite ({ tokenHash, ownerUserId = null, orgId = null, createdBy = null, roleId = null, teams = [], expiresAt }) {
      if ((ownerUserId == null) === (orgId == null) || (roleId && !orgId)) throw checkViolation('an invite is for one person or one org')
      if (!roleInOrg(roleId, orgId)) throw fkViolation('role', 'is not in this org')
      const row = { id: uuid(), tokenHash, ownerUserId, orgId, createdBy, roleId, teams: copy(teams), expiresAt, usedAt: null, usedByAgentId: null, cancelledAt: null, createdAt: now() }
      agentInvites.set(row.id, row); return copy(row)
    },
    async agentInviteByToken (h) { return copy(all(agentInvites, (i) => i.tokenHash === h)[0]) },
    async agentInviteById (id) { return copy(agentInvites.get(id)) },
    async listAgentInvites ({ ownerUserId, orgId }) {
      return all(agentInvites, (i) => (orgId ? i.orgId === orgId : i.ownerUserId === ownerUserId))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(copy)
    },
    // Check-and-set: an invite is used once, and only while it's open.
    async claimAgentInvite (id) {
      const i = agentInvites.get(id)
      if (!i || i.usedAt || i.cancelledAt || i.expiresAt <= now()) return false
      i.usedAt = now(); return true
    },
    // Undoes a claim when making the agent failed, so the link can be tried again.
    async releaseAgentInvite (id) { const i = agentInvites.get(id); if (i) Object.assign(i, { usedAt: null, usedByAgentId: null }) },
    async setInviteAgent (id, agentId) { agentInvites.get(id).usedByAgentId = agentId },
    // Check-and-set: only a waiting invite is cancelled.
    async cancelAgentInvite (id) {
      const i = agentInvites.get(id)
      if (!i || i.usedAt || i.cancelledAt) return false
      i.cancelledAt = now(); return true
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
const AGENT_INVITE = 'id, token_hash, owner_user_id, org_id, created_by, role_id, teams, expires_at, used_at, used_by_agent_id, cancelled_at, created_at'
const AGENT_KEY = 'id, agent_id, family_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, refreshed_at, revoked_at, created_at'
```

After `async deleteAgent (id) { await one(db.from('agents').delete().eq('id', id)) },` add:

```js
    // Agent invites: only the token's hash is stored. A deleted role clears
    // role_id by itself (on delete set null (role_id)).
    async createAgentInvite (i) {
      return rowFrom(await one(db.from('agent_invites').insert(toSnake({ ...i, expiresAt: ts(i.expiresAt) })).select(AGENT_INVITE).single()))
    },
    async agentInviteByToken (h) { return rowFrom(await one(db.from('agent_invites').select(AGENT_INVITE).eq('token_hash', h).maybeSingle())) },
    async agentInviteById (id) { return rowFrom(await one(db.from('agent_invites').select(AGENT_INVITE).eq('id', id).maybeSingle())) },
    async listAgentInvites ({ ownerUserId, orgId }) {
      const q = db.from('agent_invites').select(AGENT_INVITE)
      return (await one((orgId ? q.eq('org_id', orgId) : q.eq('owner_user_id', ownerUserId)).order('created_at', { ascending: false }).limit(50))).map(rowFrom)
    },
    // Check-and-set: an invite is used once, and only while it's open.
    async claimAgentInvite (id) {
      const at = new Date().toISOString()
      const rows = await one(db.from('agent_invites').update({ used_at: at }).eq('id', id).is('used_at', null).is('cancelled_at', null).gt('expires_at', at).select('id'))
      return rows.length > 0
    },
    // Undoes a claim when making the agent failed, so the link can be tried again.
    async releaseAgentInvite (id) { await one(db.from('agent_invites').update({ used_at: null, used_by_agent_id: null }).eq('id', id)) },
    async setInviteAgent (id, agentId) { await one(db.from('agent_invites').update({ used_by_agent_id: agentId }).eq('id', id)) },
    // Check-and-set: only a waiting invite is cancelled.
    async cancelAgentInvite (id) {
      const rows = await one(db.from('agent_invites').update({ cancelled_at: new Date().toISOString() }).eq('id', id).is('used_at', null).is('cancelled_at', null).select('id'))
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
git commit -m "Store agent invites, key pairs and team folders"
```

---
### Task 4: API: agent keys, refresh with reuse detection, `agentFromRequest` and `/v1/agents/me`

**Files:**
- Create: `src/api/agent-auth.js`, `test/api-agent-tokens.test.js`
- Modify: `src/api/routes/agents.js` (rewrite), `src/api/server.js`, `test/api-helpers.js`

**Interfaces:**
- Consumes: Task 3's key store methods; Task 2's `agentById`, `touchAgent`, `listPersonalAgents`, `revokeAgent`, `memberByAgent`; existing `orgById`, `roleById`, `listTeams`, `teamsOfMember` (with `scopes`); `newToken`, `hashToken` (`src/api/tokens.js`).
- Produces:
  - `src/api/agent-auth.js`: `ACCESS_TTL_MS = 3_600_000`; `REFRESH_TTL_MS = 2_592_000_000`; `REUSED` (the exact 401 message); `keyStatus(rows: KeyRow[], at: number) -> 'active'|'reused'|'expired'`; `makeAgentAuth({ store, now, bearer }) -> { mintKeys(agentId, familyId?) -> Promise<{ agentId, accessKey, accessExpiresAt, refreshKey, refreshExpiresAt }>, refresh(refreshKey) -> Promise<same>, agentFromRequest(req) -> Promise<{ agent, keyRow }> }`
  - `startApi({ …, tokenLimit = 30 })`; the route context `ctx` gains `limitTokens` and `agentAuth` (later plans use `ctx.agentAuth.agentFromRequest`)
  - Routes: `POST /v1/agents/token`, `GET /v1/agents/me`, `GET /v1/agents` (now with `status`), `DELETE /v1/agents/:id`
  - `test/api-helpers.js`: `makeAgent(t, { name, provider, type, description, ownerUserId, orgId, invitedBy, accessTtl, refreshTtl }) -> { agent, accessKey, refreshKey }`

- [ ] **Step 1: Add the test helper and write the failing tests**

In `test/api-helpers.js`, add to the imports:

```js
import crypto from 'node:crypto'
import { newToken, hashToken } from '../src/api/tokens.js'
```

change `inviteSendLimit: 1000, mailer` to `inviteSendLimit: 1000, tokenLimit: 1000, mailer`, and append:

```js

/** A joined agent with a working key pair, made straight through the store. */
export async function makeAgent (t, { name = 'Larry', provider = 'Anthropic', type = 'coding agent', description = '', ownerUserId = null, orgId = null, invitedBy = 'owner', accessTtl = 60 * 60 * 1000, refreshTtl = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const agent = await t.store.createAgent({ name, provider, type, description, ownerUserId, orgId, invitedBy })
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
  assert.equal(REUSED, "This key was already used, so this agent's keys were revoked. Invite it again.")
  assert.equal(keyStatus([{ revokedAt: null, refreshExpiresAt: 2000 }], 1000), 'active')
  assert.equal(keyStatus([{ revokedAt: 500, refreshExpiresAt: 2000 }], 1000), 'reused')
  assert.equal(keyStatus([{ revokedAt: null, refreshExpiresAt: 900 }], 1000), 'expired')
  assert.equal(keyStatus([], 1000), 'expired')
})

test('an access key signs a personal agent in; /me says who it is', async () => {
  const { agent, accessKey } = await makeAgent(t, { name: 'Larry', description: 'Writes tests', ownerUserId: 'mem' })
  const r = await me(accessKey)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { agent: { id: agent.id, name: 'Larry', provider: 'Anthropic', type: 'coding agent', description: 'Writes tests', kind: 'personal', org: null }, teams: [], role: null })
  assert.ok((await t.store.agentById(agent.id)).lastUsedAt > 0, 'last used is recorded')
  assert.equal((await me('qa_nope')).status, 401)
  assert.equal((await t.call('GET', '/v1/agents/me', null, 'mem')).status, 401, "a person's sign-in is not an agent's")
})

test('last used is written at most once a minute', async () => {
  const { accessKey } = await makeAgent(t, { ownerUserId: 'mem' })
  let touches = 0
  const counting = { ...t.store, touchAgent: async (id) => { touches++; return t.store.touchAgent(id) } }
  const t2 = await startTestApi({ store: counting })
  try {
    for (let i = 0; i < 3; i++) assert.equal((await t2.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${accessKey}` })).status, 200)
  } finally { await t2.close() }
  assert.equal(touches, 1)
})

test('/me for an org agent lists its org, role and teams with folders', async () => {
  const o = await makeOrg(t, 'Agent Me Co')
  const lead = await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: { teams: { r: true } } })
  const { agent, accessKey } = await makeAgent(t, { name: 'Bot', provider: 'OpenAI', orgId: o.org.id })
  const m = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id, roleId: lead.id })
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  await t.store.addTeamMember({ teamId: core.id, memberId: m.id, access: 'editor', scopes: ['src'] })
  assert.deepEqual((await me(accessKey)).body, {
    agent: { id: agent.id, name: 'Bot', provider: 'OpenAI', type: 'coding agent', description: '', kind: 'org', org: { slug: o.slug, name: 'Agent Me Co' } },
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

test('the personal agents list shows the profile, when each was added and last used, and its key status', async () => {
  const { agent } = await makeAgent(t, { name: 'Listed', provider: 'Cursor', type: 'editor agent', description: 'Fixes lint', ownerUserId: 'out' })
  const [a] = (await t.call('GET', '/v1/agents', null, 'out')).body.agents
  assert.deepEqual([a.id, a.name, a.provider, a.type, a.description, a.status, a.lastUsedAt], [agent.id, 'Listed', 'Cursor', 'editor agent', 'Fixes lint', 'active', null])
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
export const REUSED = "This key was already used, so this agent's keys were revoked. Invite it again."

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
    if (!row) throw new HttpError(401, "This key isn't valid. Invite the agent again.")
    if (row.revokedAt) throw new HttpError(401, "This agent's keys were revoked. Invite it again.")
    if (row.refreshedAt) { await store.revokeFamily(row.familyId); throw new HttpError(401, REUSED) }
    if (row.refreshExpiresAt <= now()) throw new HttpError(401, 'This key has expired. Invite the agent again.')
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
    if (keyRow.revokedAt) throw new HttpError(401, "this agent's keys were revoked; invite it again")
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

const profileOf = (a) => ({ id: a.id, name: a.name, provider: a.provider, type: a.type, description: a.description })

export function agentRoutes ({ store, user, now, limitTokens, agentAuth }) {
  return [
    ['POST', /^\/v1\/agents\/token$/, async (req, body) => {
      limitTokens(req)
      return agentAuth.refresh(body.refreshKey)
    }],

    ['GET', /^\/v1\/agents\/me$/, async (req) => {
      const { agent } = await agentAuth.agentFromRequest(req)
      if (!agent.orgId) return { agent: { ...profileOf(agent), kind: 'personal', org: null }, teams: [], role: null }
      const [org, m, teams] = await Promise.all([store.orgById(agent.orgId), store.memberByAgent(agent.orgId, agent.id), store.listTeams(agent.orgId)])
      const [role, mine] = await Promise.all([m?.roleId ? store.roleById(agent.orgId, m.roleId) : null, m ? store.teamsOfMember(m.id) : []])
      const names = new Map(teams.map((x) => [x.id, x.name]))
      return {
        agent: { ...profileOf(agent), kind: 'org', org: { slug: org.slug, name: org.name } },
        teams: mine.map((x) => ({ id: x.teamId, name: names.get(x.teamId) || '', access: x.access, scopes: x.scopes })),
        role: role ? { name: role.name } : null
      }
    }],

    ['GET', /^\/v1\/agents$/, async (req) => {
      const u = await user(req)
      const agents = await store.listPersonalAgents(u.userId)
      return {
        agents: await Promise.all(agents.map(async (a) => ({
          ...profileOf(a),
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
### Task 5: API: agent invites (personal and org)

**Files:**
- Create: `src/api/team-access.js`, `src/api/routes/agent-invites.js`, `test/api-team-access.test.js`, `test/api-agent-invites.test.js`
- Modify: `src/api/server.js`, `test/api-helpers.js`

**Interfaces:**
- Consumes: Task 3's invite store methods; `agentById`; `orgAccess` (`need`, `assignable`); `teamById`, `listTeams`, `listRoles`; `newToken`, `hashToken`; `HttpError`, `needId`.
- Produces:
  - `src/api/team-access.js`: `ACCESS = ['editor', 'viewer']`, `accessOf(v) -> 'editor'|'viewer'` (400 otherwise), `MAX_SCOPES = 20`, `MAX_SCOPE_LENGTH = 200`, `cleanScopes(input) -> string[]` (400 on anything else)
  - `src/api/routes/agent-invites.js`: `AGENT_INVITE_TTL_MS = 3_600_000`; `inviteStatus(invite, at) -> 'waiting'|'used'|'expired'|'cancelled'`; `agentInviteRoutes(ctx)` with `POST|GET /v1/agent-invites`, `DELETE /v1/agent-invites/:id`, `POST|GET /v1/orgs/:slug/agent-invites`, `DELETE /v1/orgs/:slug/agent-invites/:id`
  - Invite view: `{ id, kind: 'personal'|'org', status, usedBy: { id, name, provider }|null, role: string|null, teams: [{ id, name, access, scopes }], createdAt, expiresAt, usedAt }`; create answers `{ invite, link }`
  - `startApi({ …, apiUrl = 'https://api.heyquilt.com' })` (trailing slashes dropped); `ctx.apiUrl`
  - `test/api-helpers.js`: `API_URL = 'https://api.quilt.test'` passed as `apiUrl`

- [ ] **Step 1: Write the failing tests**

In `test/api-helpers.js`, after `export const SITE = 'https://quilt.test'` add `export const API_URL = 'https://api.quilt.test'`, and change `startApi({ store, verifyUser, siteUrl: SITE, ` to `startApi({ store, verifyUser, siteUrl: SITE, apiUrl: API_URL, `.

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

Create `test/api-agent-invites.test.js`:

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, API_URL } from './api-helpers.js'
import { newToken, hashToken } from '../src/api/tokens.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const LINK = new RegExp(`^${API_URL.replace(/\./g, '\\.')}/v1/join/qj_[A-Za-z0-9_-]{43}$`)

test('a person makes a personal invite: a one-time link that lasts an hour, stored only as a hash', async () => {
  assert.equal((await t.call('POST', '/v1/agent-invites', {})).status, 401)
  const r = await t.call('POST', '/v1/agent-invites', {}, 'mem')
  assert.equal(r.status, 200)
  assert.match(r.body.link, LINK)
  assert.deepEqual([r.body.invite.kind, r.body.invite.status, r.body.invite.usedBy, r.body.invite.role, r.body.invite.teams], ['personal', 'waiting', null, null, []])
  assert.ok(Math.abs(r.body.invite.expiresAt - (Date.now() + 60 * 60 * 1000)) < 5000)
  const token = r.body.link.split('/v1/join/')[1]
  const stored = await t.store.agentInviteById(r.body.invite.id)
  assert.equal(stored.tokenHash, hashToken(token))
  assert.equal(JSON.stringify(stored).includes(token), false)
  assert.ok((await t.call('GET', '/v1/agent-invites', null, 'mem')).body.invites.some((i) => i.id === r.body.invite.id))
  assert.equal((await t.call('GET', '/v1/agent-invites', null, 'lim')).body.invites.some((i) => i.id === r.body.invite.id), false)
})

test('a waiting personal invite is cancelled by its owner only, once', async () => {
  const { invite } = (await t.call('POST', '/v1/agent-invites', {}, 'mem')).body
  assert.equal((await t.call('DELETE', `/v1/agent-invites/${invite.id}`, null, 'lim')).status, 404)
  assert.equal((await t.call('DELETE', '/v1/agent-invites/not-a-uuid', null, 'mem')).status, 404)
  assert.equal((await t.call('DELETE', `/v1/agent-invites/${invite.id}`, null, 'mem')).status, 200)
  assert.equal((await t.call('DELETE', `/v1/agent-invites/${invite.id}`, null, 'mem')).status, 409)
  const listed = (await t.call('GET', '/v1/agent-invites', null, 'mem')).body.invites.find((i) => i.id === invite.id)
  assert.equal(listed.status, 'cancelled')
})

test('an invite past its hour shows as expired', async () => {
  const old = await t.store.createAgentInvite({ tokenHash: hashToken(newToken('qj_')), ownerUserId: 'out', createdBy: 'out', expiresAt: Date.now() - 1 })
  const listed = (await t.call('GET', '/v1/agent-invites', null, 'out')).body.invites.find((i) => i.id === old.id)
  assert.equal(listed.status, 'expired')
})

test('an org invite needs Agents: Create, and carries a role and teams; access defaults to viewer', async () => {
  const o = await makeOrg(t, 'Invite Bots Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const web = await t.store.createTeam({ orgId: o.org.id, name: 'Web' })
  const lead = await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: { teams: { r: true } } })
  const base = `/v1/orgs/${o.slug}/agent-invites`
  assert.equal((await t.call('POST', base, {}, 'mem')).status, 403, 'Member has no Agents: Create')
  assert.equal((await t.call('POST', base, {}, 'out')).status, 404, 'not in the org')
  const r = await t.call('POST', base, { roleId: lead.id, teams: [{ teamId: core.id, access: 'editor', scopes: ['src/', './docs'] }, { teamId: web.id }] }, 'admin')
  assert.equal(r.status, 200)
  assert.match(r.body.link, LINK)
  assert.deepEqual([r.body.invite.kind, r.body.invite.role], ['org', 'Lead'])
  assert.deepEqual(r.body.invite.teams, [{ id: core.id, name: 'Core', access: 'editor', scopes: ['src', 'docs'] }, { id: web.id, name: 'Web', access: 'viewer', scopes: [] }])
  const stored = await t.store.agentInviteById(r.body.invite.id)
  assert.deepEqual([stored.orgId, stored.roleId, stored.createdBy, stored.ownerUserId], [o.org.id, lead.id, 'admin', null])
  const none = await t.call('POST', base, {}, 'admin')
  assert.deepEqual([none.body.invite.role, none.body.invite.teams], [null, []], 'no role and no teams is fine')
  const listed = (await t.call('GET', base, null, 'admin')).body.invites
  assert.deepEqual(listed.map((i) => i.id).sort(), [r.body.invite.id, none.body.invite.id].sort())
  assert.equal((await t.call('GET', base, null, 'mem')).status, 403)
})

test('org invite choices are checked against the inviter: roles within their grid, teams they may add to', async () => {
  const o = await makeOrg(t, 'Invite Rights Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const inviter = await t.store.createRole({ orgId: o.org.id, name: 'Inviter', grants: { agents: { c: true }, teams: { r: true } } })
  await t.store.setMemberRole(o.mem.id, inviter.id)
  const go = (body, who = 'mem') => t.call('POST', `/v1/orgs/${o.slug}/agent-invites`, body, who)
  assert.equal((await go({ teams: [{ teamId: core.id }] })).status, 403, 'no Team membership: Create')
  assert.equal((await go({ roleId: o.role('admin').id })).status, 403, 'Admin holds more than Inviter')
  assert.equal((await go({ roleId: o.role('owner').id }, 'owner')).status, 403, 'never Owner')
  assert.equal((await go({ roleId: 'not-a-uuid' })).status, 404)
  assert.equal((await go({ roleId: o.role('member').id })).status, 200, 'Member is within Inviter')
})

test('org invite teams are real teams of this org, once each, editor or viewer, folders inside the project', async () => {
  const o = await makeOrg(t, 'Invite Check Co'); const other = await makeOrg(t, 'Invite Elsewhere Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const theirs = await t.store.createTeam({ orgId: other.org.id, name: 'Theirs' })
  const go = (teams) => t.call('POST', `/v1/orgs/${o.slug}/agent-invites`, { teams }, 'admin')
  assert.equal((await go([{ teamId: theirs.id }])).status, 404)
  assert.equal((await go([{ teamId: core.id }, { teamId: core.id, access: 'editor' }])).status, 400)
  assert.equal((await go([{ teamId: core.id, access: 'owner' }])).status, 400)
  assert.equal((await go([{ teamId: core.id, scopes: ['../secrets'] }])).status, 400)
  assert.equal((await go([{ teamId: core.id, scopes: Array.from({ length: 21 }, (_, i) => `d${i}`) }])).status, 400)
  assert.equal((await go('Core')).status, 400)
  assert.equal((await go([{ teamId: core.id, scopes: ['src'] }])).status, 200)
})

test('org invites are cancelled with Agents: Create, and only in their own org', async () => {
  const o = await makeOrg(t, 'Invite Cancel Co'); const other = await makeOrg(t, 'Invite Cancel Other')
  const { invite } = (await t.call('POST', `/v1/orgs/${o.slug}/agent-invites`, {}, 'admin')).body
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/agent-invites/${invite.id}`, null, 'mem')).status, 403)
  assert.equal((await t.call('DELETE', `/v1/orgs/${other.slug}/agent-invites/${invite.id}`, null, 'owner')).status, 404)
  assert.equal((await t.call('DELETE', `/v1/agent-invites/${invite.id}`, null, 'admin')).status, 404, 'not a personal invite')
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/agent-invites/${invite.id}`, null, 'admin')).status, 200)
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/agent-invites/${invite.id}`, null, 'admin')).status, 409)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/api-team-access.test.js test/api-agent-invites.test.js`
Expected: FAIL: `Cannot find module '…/src/api/team-access.js'`, and `POST /v1/agent-invites` answers 404.

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

- [ ] **Step 4: Write the invite routes**

Create `src/api/routes/agent-invites.js`:

```js
// Agent invites: a signed-in person makes a one-time link (good for an hour)
// that their AI uses to join, as their personal agent or as an org's agent with
// the role, teams and folders chosen here. Only the link's hash is stored.
import { HttpError, needId } from '../http.js'
import { newToken, hashToken } from '../tokens.js'
import { orgAccess } from '../org-access.js'
import { accessOf, cleanScopes } from '../team-access.js'

export const AGENT_INVITE_TTL_MS = 60 * 60 * 1000
const MAX_TEAMS = 50

export const inviteStatus = (i, at) => (i.cancelledAt ? 'cancelled' : i.usedAt ? 'used' : i.expiresAt <= at ? 'expired' : 'waiting')

export function agentInviteRoutes ({ store, user, now, apiUrl }) {
  const orgFor = async (req, slug) => { const u = await user(req); return { u, ...(await orgAccess(store, u.userId, slug)) } }
  const teamNames = async (orgId) => new Map((await store.listTeams(orgId)).map((x) => [x.id, x.name]))

  async function view (i, names = new Map(), roleName = null) {
    const agent = i.usedByAgentId ? await store.agentById(i.usedByAgentId) : null
    return {
      id: i.id,
      kind: i.orgId ? 'org' : 'personal',
      status: inviteStatus(i, now()),
      usedBy: agent ? { id: agent.id, name: agent.name, provider: agent.provider } : null,
      role: roleName,
      teams: i.teams.map((x) => ({ id: x.teamId, name: names.get(x.teamId) || '', access: x.access, scopes: x.scopes })),
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      usedAt: i.usedAt
    }
  }

  // The link is shown once; only its hash is kept.
  async function make (userId, fields) {
    const token = newToken('qj_')
    const invite = await store.createAgentInvite({ tokenHash: hashToken(token), createdBy: userId, expiresAt: now() + AGENT_INVITE_TTL_MS, ...fields })
    return { invite, link: `${apiUrl}/v1/join/${token}` }
  }

  // What an org invite hands out, checked against the inviter's own rights now.
  async function orgChoices (a, body) {
    const role = body.roleId ? await a.assignable(body.roleId) : null
    const list = body.teams ?? []
    if (!Array.isArray(list) || list.length > MAX_TEAMS) throw new HttpError(400, 'teams must be a list')
    if (list.length) a.need('team_members', 'c')
    const teams = []
    for (const item of list) {
      const team = await store.teamById(a.org.id, needId(item?.teamId, 'team'))
      if (!team) throw new HttpError(404, 'no such team')
      if (teams.some((x) => x.teamId === team.id)) throw new HttpError(400, 'each team can only be picked once')
      // Viewer unless the inviter chose editor: an agent starts read-only.
      teams.push({ teamId: team.id, access: accessOf(item.access ?? 'viewer'), scopes: cleanScopes(item.scopes ?? []) })
    }
    return { role, teams }
  }

  async function cancel (i) {
    if (!await store.cancelAgentInvite(i.id)) throw new HttpError(409, 'this invite was already used or cancelled')
    return { ok: true }
  }

  return [
    ['POST', /^\/v1\/agent-invites$/, async (req) => {
      const u = await user(req)
      const { invite, link } = await make(u.userId, { ownerUserId: u.userId })
      return { invite: await view(invite), link }
    }],

    ['GET', /^\/v1\/agent-invites$/, async (req) => {
      const u = await user(req)
      return { invites: await Promise.all((await store.listAgentInvites({ ownerUserId: u.userId })).map((i) => view(i))) }
    }],

    ['DELETE', /^\/v1\/agent-invites\/([^/]+)$/, async (req, body, [id]) => {
      const u = await user(req)
      const i = await store.agentInviteById(needId(id, 'invite'))
      if (!i || i.ownerUserId !== u.userId) throw new HttpError(404, 'no such invite')
      return cancel(i)
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/agent-invites$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('agents', 'c')
      const { role, teams } = await orgChoices(a, body)
      const { invite, link } = await make(a.u.userId, { orgId: a.org.id, roleId: role ? role.id : null, teams })
      return { invite: await view(invite, await teamNames(a.org.id), role ? role.name : null), link }
    }],

    ['GET', /^\/v1\/orgs\/([^/]+)\/agent-invites$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('agents', 'c')
      const [invites, names, roles] = await Promise.all([store.listAgentInvites({ orgId: a.org.id }), teamNames(a.org.id), store.listRoles(a.org.id)])
      const roleName = new Map(roles.map((r) => [r.id, r.name]))
      return { invites: await Promise.all(invites.map((i) => view(i, names, roleName.get(i.roleId) || null))) }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)\/agent-invites\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('agents', 'c')
      const i = await store.agentInviteById(needId(id, 'invite'))
      if (!i || i.orgId !== a.org.id) throw new HttpError(404, 'no such invite')
      return cancel(i)
    }]
  ]
}
```

- [ ] **Step 5: Wire it into the server**

In `src/api/server.js`:

- After `import { makeAgentAuth } from './agent-auth.js'` add `import { agentInviteRoutes } from './routes/agent-invites.js'`.
- In the `startApi` parameter list, change `siteUrl, mailer` to `siteUrl, apiUrl = 'https://api.heyquilt.com', mailer`.
- After `const site = String(siteUrl || '').replace(/\/+$/, '')` add:

```js
  // Where agents reach this API: invite links and the join instructions point here.
  const api = String(apiUrl).replace(/\/+$/, '')
```

- Change the `ctx` line to:

```js
  const ctx = { store, user, now, site, apiUrl: api, mailer, log, limit: limitInvites, limitSend: limitInviteSend, limitTokens, agentAuth }
```

- Change the push to `routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx), ...agentRoutes(ctx), ...agentInviteRoutes(ctx))`.

- [ ] **Step 6: Run the tests**

Run: `node --test test/api-team-access.test.js test/api-agent-invites.test.js && npm test`
Expected: PASS, `# pass 3` and `# pass 7`, then the whole suite `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/api/team-access.js src/api/routes/agent-invites.js src/api/server.js test/api-helpers.js test/api-team-access.test.js test/api-agent-invites.test.js
git commit -m "Let people make one-time agent invite links"
```

---
### Task 6: API: `/v1/join/:token`, where an AI uses its invite

**Files:**
- Create: `src/api/join-text.js`, `src/api/routes/join.js`, `test/api-join.test.js`
- Modify: `src/api/http.js`, `src/api/server.js`, `bin/quilt.js`, `fly.api.toml`, `scripts/api-smoke.mjs`, `test/api-helpers.js`

**Interfaces:**
- Consumes: Task 3's invite store methods (`agentInviteByToken`, `claimAgentInvite`, `releaseAgentInvite`, `setInviteAgent`), `createAgent`, `agentByPublicKey`, `deleteAgent`, `addAgentMember`, `teamById`, `addTeamMember`; `ctx.agentAuth.mintKeys` (Task 4); `ctx.apiUrl` (Task 5); `inviteStatus` (Task 5); `cleanName`, `stripInvisible`; `parsePublicKey` (`src/identity.js`).
- Produces:
  - `src/api/http.js`: `class Raw { status, body, type }` (a non-JSON reply; `type` defaults to `text/markdown; charset=utf-8`)
  - `src/api/join-text.js`: `joinInstructions({ link, apiUrl, status: 'waiting'|'used'|'expired'|'cancelled'|'unknown', expiresAt }) -> string`; `joinNext({ name, apiUrl }) -> string`
  - `joinRoutes(ctx)` with `POST /v1/join/:token` and `GET /v1/join/:token`
  - `startApi({ …, joinLimit = 20 })`; every `/v1/join/…` response carries `x-robots-tag: noindex` (and `cache-control: no-store`, as all API responses do)
  - `quilt api` reads `QUILT_API_PUBLIC_URL` (default `https://api.heyquilt.com`; with `--memory`, `http://<host>:<port>`)

- [ ] **Step 1: Write the failing tests**

In `test/api-helpers.js`, change `tokenLimit: 1000, mailer` to `tokenLimit: 1000, joinLimit: 1000, mailer`.

Create `test/api-join.test.js`:

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, API_URL } from './api-helpers.js'
import { generateIdentity } from '../src/identity.js'
import { newToken, hashToken } from '../src/api/tokens.js'
import { joinInstructions, joinNext } from '../src/api/join-text.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())

const PROFILE = { name: 'Larry', provider: 'Anthropic', type: 'coding agent', description: 'Writes tests' }
// A fresh personal invite; returns its token (the path after /v1/join/).
async function invite (who = 'mem', path = '/v1/agent-invites', body = {}) {
  const r = await t.call('POST', path, body, who)
  return { token: r.body.link.split('/v1/join/')[1], id: r.body.invite.id }
}
const join = (token, body = PROFILE) => t.call('POST', `/v1/join/${token}`, body)
const raw = async (path) => {
  const res = await fetch(t.api.url + path)
  return { status: res.status, text: await res.text(), headers: res.headers }
}
const statusOf = async (who, id) => (await t.call('GET', '/v1/agent-invites', null, who)).body.invites.find((i) => i.id === id).status

test('the instructions explain both ways to join, with no em dashes', () => {
  const text = joinInstructions({ link: 'https://api.x/v1/join/qj_abc', apiUrl: 'https://api.x', status: 'waiting', expiresAt: Date.parse('2026-10-01T12:00:00Z') })
  assert.match(text, /Status: this invite is open\. It works once, until 2026-10-01T12:00:00\.000Z\./)
  assert.match(text, /POST https:\/\/api\.x\/v1\/join\/qj_abc/)
  assert.match(text, /"name": /)
  assert.match(text, /GET https:\/\/api\.x\/v1\/join\/qj_abc\?name=/)
  assert.match(text, /POST https:\/\/api\.x\/v1\/agents\/token/)
  assert.match(text, /does not use the invite/)
  for (const [status, line] of [['used', /already used/], ['expired', /has expired/], ['cancelled', /was cancelled/], ['unknown', /isn't valid/]]) {
    assert.match(joinInstructions({ link: 'l', apiUrl: 'a', status }), line, status)
  }
  const next = joinNext({ name: 'Larry', apiUrl: 'https://api.x' })
  assert.match(next, /Larry/)
  assert.match(next, /https:\/\/api\.x\/v1\/agents\/me/)
  for (const s of [text, next]) assert.equal(s.includes('\u2014'), false, 'no em dash')
})

test('an AI joins with POST: a personal agent with its profile and its first keys, once', async () => {
  const { token, id } = await invite('mem')
  const r = await join(token)
  assert.equal(r.status, 200)
  assert.match(r.body.accessKey, /^qa_/)
  assert.match(r.body.refreshKey, /^qr_/)
  assert.ok(r.body.accessExpiresAt > Date.now() && r.body.refreshExpiresAt > r.body.accessExpiresAt)
  assert.deepEqual([r.body.api, r.body.refresh, r.body.mcp], [API_URL, `${API_URL}/v1/agents/token`, `${API_URL}/mcp`])
  assert.match(r.body.next, /Larry/)
  const agent = await t.store.agentById(r.body.agentId)
  assert.deepEqual([agent.name, agent.provider, agent.type, agent.description, agent.ownerUserId, agent.orgId, agent.invitedBy, agent.publicKey], ['Larry', 'Anthropic', 'coding agent', 'Writes tests', 'mem', null, 'mem', null])
  const me = await t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${r.body.accessKey}` })
  assert.deepEqual([me.status, me.body.agent.kind], [200, 'personal'])
  const listed = (await t.call('GET', '/v1/agent-invites', null, 'mem')).body.invites.find((i) => i.id === id)
  assert.deepEqual([listed.status, listed.usedBy], ['used', { id: agent.id, name: 'Larry', provider: 'Anthropic' }])
  const again = await join(token, { ...PROFILE, name: 'Other' })
  assert.deepEqual([again.status, again.body.error], [410, 'this invite was already used; ask for a new one'])
})

test('a plain GET only explains: it never uses the invite, and is not cached or indexed', async () => {
  const { token, id } = await invite('mem')
  const r = await raw(`/v1/join/${token}`)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /^text\/markdown/)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal(r.headers.get('x-robots-tag'), 'noindex')
  assert.match(r.text, /Status: this invite is open/)
  assert.ok(r.text.includes(`POST ${API_URL}/v1/join/${token}`))
  await raw(`/v1/join/${token}`)
  assert.equal(await statusOf('mem', id), 'waiting', 'still open after two previews')
  assert.equal((await join(token)).status, 200)
  const used = await raw(`/v1/join/${token}`)
  assert.equal(used.status, 410)
  assert.match(used.text, /already used/)
})

test('a GET that names the agent joins, for AIs that can only fetch', async () => {
  const { token } = await invite('mem')
  const partial = await raw(`/v1/join/${token}?name=Fetchy&provider=OpenAI`)
  assert.equal(partial.status, 400, 'type is missing')
  assert.equal(partial.headers.get('x-robots-tag'), 'noindex')
  const r = await t.call('GET', `/v1/join/${token}?name=Fetchy&provider=OpenAI&type=chat%20assistant`)
  assert.equal(r.status, 200)
  const agent = await t.store.agentById(r.body.agentId)
  assert.deepEqual([agent.name, agent.provider, agent.type, agent.description], ['Fetchy', 'OpenAI', 'chat assistant', ''])
})

test('a bad request never burns the invite', async () => {
  const { token, id } = await invite('mem')
  assert.equal((await join(token, { name: 'X', type: 'coding agent' })).status, 400, 'no provider')
  assert.equal((await join(token, { ...PROFILE, name: '  ' })).status, 400)
  assert.equal((await join(token, { ...PROFILE, publicKey: 'nope' })).status, 400)
  assert.equal((await t.call('POST', `/v1/join/${token}`)).status, 400, 'no body')
  assert.equal(await statusOf('mem', id), 'waiting')
  const long = await join(token, { ...PROFILE, name: 'n'.repeat(60), description: 'd'.repeat(300) })
  const agent = await t.store.agentById(long.body.agentId)
  assert.deepEqual([agent.name.length, agent.description.length], [40, 180])
})

test('an agent may bring its own public key, which belongs to one agent only', async () => {
  const id = generateIdentity()
  const a = await invite('mem'); const b = await invite('mem')
  const r = await join(a.token, { ...PROFILE, publicKey: id.publicKey })
  assert.equal((await t.store.agentById(r.body.agentId)).publicKey, id.publicKey)
  assert.equal((await join(b.token, { ...PROFILE, publicKey: id.publicKey })).status, 409)
  assert.equal(await statusOf('mem', b.id), 'waiting')
})

test('expired, cancelled and unknown invites are refused, and their GET says why', async () => {
  const expired = newToken('qj_')
  await t.store.createAgentInvite({ tokenHash: hashToken(expired), ownerUserId: 'mem', createdBy: 'mem', expiresAt: Date.now() - 1 })
  const cancelled = await invite('mem')
  await t.call('DELETE', `/v1/agent-invites/${cancelled.id}`, null, 'mem')
  assert.deepEqual([(await join(expired)).status, (await join(expired)).body.error], [410, 'this invite has expired; ask for a new one'])
  assert.equal((await join(cancelled.token)).status, 410)
  assert.equal((await join(newToken('qj_'))).status, 404)
  assert.equal((await join('nonsense')).status, 404)
  const e = await raw(`/v1/join/${expired}`)
  assert.deepEqual([e.status, /has expired/.test(e.text)], [410, true])
  const c = await raw(`/v1/join/${cancelled.token}`)
  assert.deepEqual([c.status, /was cancelled/.test(c.text)], [410, true])
  const u = await raw(`/v1/join/${newToken('qj_')}`)
  assert.deepEqual([u.status, /isn't valid/.test(u.text), u.headers.get('x-robots-tag')], [404, true, 'noindex'])
})

test('an org invite makes an org agent with the role, teams and folders it was given', async () => {
  const o = await makeOrg(t, 'Join Bots Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const web = await t.store.createTeam({ orgId: o.org.id, name: 'Web' })
  const gone = await t.store.createTeam({ orgId: o.org.id, name: 'Gone' })
  const lead = await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: { teams: { r: true } } })
  const { token } = await invite('admin', `/v1/orgs/${o.slug}/agent-invites`, { roleId: lead.id, teams: [{ teamId: core.id, access: 'editor', scopes: ['src'] }, { teamId: web.id }, { teamId: gone.id }] })
  await t.store.deleteTeam(gone.id)
  const r = await join(token, { name: 'Bot', provider: 'OpenAI', type: 'coding agent' })
  assert.equal(r.status, 200)
  const me = (await t.call('GET', '/v1/agents/me', null, null, { authorization: `Bearer ${r.body.accessKey}` })).body
  assert.deepEqual(me.agent.org, { slug: o.slug, name: 'Join Bots Co' })
  assert.deepEqual(me.role, { name: 'Lead' })
  assert.deepEqual(me.teams.map((x) => [x.name, x.access, x.scopes]).sort(), [['Core', 'editor', ['src']], ['Web', 'viewer', []]], 'a team deleted since is skipped')
  const agent = await t.store.agentById(r.body.agentId)
  assert.deepEqual([agent.orgId, agent.ownerUserId, agent.invitedBy], [o.org.id, null, 'admin'])
})

test('two joins racing on one invite: only one agent is made', async () => {
  const { token } = await invite('mem')
  const [a, b] = await Promise.all([join(token, { ...PROFILE, name: 'A' }), join(token, { ...PROFILE, name: 'B' })])
  assert.deepEqual([a.status, b.status].sort(), [200, 410])
})

test('a join that fails part way removes the half-made agent and reopens the invite', async () => {
  const o = await makeOrg(t, 'Join Flaky Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  const { token, id } = await invite('admin', `/v1/orgs/${o.slug}/agent-invites`, { teams: [{ teamId: core.id }] })
  const broken = await startTestApi({ store: { ...t.store, addTeamMember: async () => { throw new Error('db down') } } })
  try {
    assert.equal((await broken.call('POST', `/v1/join/${token}`, { ...PROFILE, name: 'Half' })).status, 500)
  } finally { await broken.close() }
  const after = await t.store.agentInviteById(id)
  assert.deepEqual([after.usedAt, after.usedByAgentId], [null, null])
  assert.equal((await t.store.listMembers(o.org.id)).some((m) => m.name === 'Half'), false, 'the half-made agent is gone')
  assert.equal((await join(token)).status, 200, 'and the link still works')
})

test('joining is rate-limited per address', async () => {
  const limited = await startTestApi({ joinLimit: 2 })
  try {
    for (const want of [404, 404, 429]) assert.equal((await fetch(`${limited.api.url}/v1/join/qj_nope`)).status, want)
  } finally { await limited.close() }
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/api-join.test.js`
Expected: FAIL with `Cannot find module '…/src/api/join-text.js'`.

- [ ] **Step 3: Write the instructions text**

Create `src/api/join-text.js`:

```js
// What an AI reads when it opens an agent invite link. Plain text, so any AI
// that can fetch a URL can follow it.
const STATUS = {
  waiting: (expiresAt) => `Status: this invite is open. It works once, until ${new Date(expiresAt).toISOString()}.`,
  used: () => 'Status: this invite was already used. Ask the person who sent it for a new one.',
  expired: () => 'Status: this invite has expired. Ask the person who sent it for a new one.',
  cancelled: () => 'Status: this invite was cancelled. Ask the person who sent it for a new one.',
  unknown: () => "Status: this invite link isn't valid. Check that you copied all of it."
}

export function joinInstructions ({ link, apiUrl, status, expiresAt }) {
  return [
    '# Join Quilt as an agent',
    '',
    STATUS[status](expiresAt),
    '',
    'Quilt lets people and AI agents work in the same project folder in real time. A person invited you to join as their agent.',
    '',
    'To join, send one request:',
    '',
    `POST ${link}`,
    'Content-Type: application/json',
    '',
    '{"name": "your name, up to 40 characters", "provider": "who made you, e.g. Anthropic, OpenAI or Cursor", "type": "what you are, e.g. coding agent", "description": "optional, up to 180 characters"}',
    '',
    'If you can only fetch URLs, open this instead (description is optional):',
    '',
    `GET ${link}?name=...&provider=...&type=...&description=...`,
    '',
    'The reply is JSON with an access key (valid for 1 hour) and a refresh key (valid for 30 days, single use). Keep both secret.',
    `Send the access key as "Authorization: Bearer <accessKey>". For a new pair, POST ${apiUrl}/v1/agents/token with {"refreshKey": "<refreshKey>"}. Using a refresh key twice revokes your keys.`,
    '',
    'Opening this link without a name does not use the invite.',
    ''
  ].join('\n')
}

/** The short "what now" an agent gets with its first keys. */
export function joinNext ({ name, apiUrl }) {
  return `You joined Quilt as ${name}. Send your access key as "Authorization: Bearer <accessKey>" to ${apiUrl}. It lasts 1 hour; for a new pair, POST ${apiUrl}/v1/agents/token with {"refreshKey": "<refreshKey>"} (each refresh key works once). Check who you are with GET ${apiUrl}/v1/agents/me. Session tools over MCP at ${apiUrl}/mcp are coming soon.`
}
```

- [ ] **Step 4: Let routes answer with plain text**

Append to `src/api/http.js`:

```js

/** A non-JSON reply, e.g. the plain-text join instructions an AI reads. */
export class Raw {
  constructor (status, body, type = 'text/markdown; charset=utf-8') { this.status = status; this.body = body; this.type = type }
}
```

In `src/api/server.js`:

- Change `import { HttpError } from './http.js'` to `import { HttpError, Raw } from './http.js'`.
- Replace

```js
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) })
      res.end(JSON.stringify(data))
    }
```

with

```js
    // Join links are secrets in a URL: never cache them, and ask crawlers not to index them.
    const extra = String(req.url).startsWith('/v1/join/') ? { 'x-robots-tag': 'noindex' } : {}
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra, ...cors(req) })
      res.end(type === 'application/json' ? JSON.stringify(data) : data)
    }
```

- Replace `      if (Array.isArray(out)) send(out[0], out[1]); else send(200, out)` with:

```js
      if (out instanceof Raw) send(out.status, out.body, out.type)
      else if (Array.isArray(out)) send(out[0], out[1])
      else send(200, out)
```

- [ ] **Step 5: Write the join routes**

Create `src/api/routes/join.js`:

```js
// An AI opening an agent invite link. A GET without a name only explains, so
// link previews and scanners never use the invite up; a POST, or a GET with
// name, provider and type, uses it once and hands back the agent's first keys.
import { HttpError, Raw, cleanName, stripInvisible } from '../http.js'
import { hashToken } from '../tokens.js'
import { parsePublicKey } from '../../identity.js'
import { joinInstructions, joinNext } from '../join-text.js'
import { inviteStatus } from './agent-invites.js'

const MAX_DESCRIPTION = 180
const GONE = {
  used: 'this invite was already used; ask for a new one',
  expired: 'this invite has expired; ask for a new one',
  cancelled: 'this invite was cancelled; ask for a new one'
}

export function joinRoutes ({ store, now, apiUrl, limitJoin, agentAuth }) {
  const inviteFor = async (token) => (String(token).startsWith('qj_') ? store.agentInviteByToken(hashToken(token)) : null)
  const statusOf = (invite) => (invite ? inviteStatus(invite, now()) : 'unknown')

  // The agent's profile, checked in full before the invite is touched.
  function profile (src) {
    const publicKey = src.publicKey == null || src.publicKey === '' ? null : String(src.publicKey)
    if (publicKey && !parsePublicKey(publicKey)) throw new HttpError(400, 'publicKey must be an Ed25519 key (spki, base64url)')
    return {
      name: cleanName(src.name, 40, 'give your name (up to 40 characters)'),
      provider: cleanName(src.provider, 40, 'give your provider, e.g. Anthropic, OpenAI or Cursor'),
      type: cleanName(src.type, 40, 'give your type, e.g. coding agent'),
      description: stripInvisible(src.description ?? '').slice(0, MAX_DESCRIPTION).join('').trim(),
      publicKey
    }
  }

  async function join (token, src) {
    const invite = await inviteFor(token)
    const status = statusOf(invite)
    if (status === 'unknown') throw new HttpError(404, "this invite link isn't valid")
    if (status !== 'waiting') throw new HttpError(410, GONE[status])
    // Everything the agent sent is checked first, so a typo never burns the invite.
    const p = profile(src)
    if (p.publicKey && await store.agentByPublicKey(p.publicKey)) throw new HttpError(409, 'that publicKey already belongs to an agent')
    // Claim first, so two joins racing on one link can't both make an agent.
    if (!await store.claimAgentInvite(invite.id)) throw new HttpError(410, GONE.used)
    let agent
    try {
      agent = await store.createAgent({ ...p, ownerUserId: invite.ownerUserId, orgId: invite.orgId, invitedBy: invite.createdBy })
      if (invite.orgId) {
        const m = await store.addAgentMember({ orgId: invite.orgId, agentId: agent.id, roleId: invite.roleId })
        for (const x of invite.teams) {
          // A team deleted since the invite was made is skipped.
          if (await store.teamById(invite.orgId, x.teamId)) await store.addTeamMember({ teamId: x.teamId, memberId: m.id, access: x.access, scopes: x.scopes })
        }
      }
      await store.setInviteAgent(invite.id, agent.id)
      const keys = await agentAuth.mintKeys(agent.id)
      return { ...keys, api: apiUrl, refresh: `${apiUrl}/v1/agents/token`, mcp: `${apiUrl}/mcp`, next: joinNext({ name: agent.name, apiUrl }) }
    } catch (err) {
      // Undo the half-made agent and reopen the link, so the AI can simply try again.
      if (agent) await store.deleteAgent(agent.id).catch(() => {})
      await store.releaseAgentInvite(invite.id).catch(() => {})
      throw err
    }
  }

  return [
    ['POST', /^\/v1\/join\/([^/]+)$/, async (req, body, [token]) => {
      limitJoin(req)
      return join(token, body)
    }],

    ['GET', /^\/v1\/join\/([^/]+)$/, async (req, body, [token]) => {
      limitJoin(req)
      const q = new URL(req.url, 'http://x').searchParams
      // Only a GET that names the agent uses the invite.
      if (['name', 'provider', 'type'].some((k) => q.has(k))) return join(token, Object.fromEntries(q))
      const invite = await inviteFor(token)
      const status = statusOf(invite)
      const text = joinInstructions({ link: `${apiUrl}/v1/join/${encodeURIComponent(token)}`, apiUrl, status, expiresAt: invite?.expiresAt })
      return new Raw(status === 'waiting' ? 200 : status === 'unknown' ? 404 : 410, text)
    }]
  ]
}
```

- [ ] **Step 6: Wire it in**

In `src/api/server.js`:

- After `import { agentInviteRoutes } from './routes/agent-invites.js'` add `import { joinRoutes } from './routes/join.js'`.
- In the `startApi` parameter list, change `tokenLimit = 30, trustProxy` to `tokenLimit = 30, joinLimit = 20, trustProxy`.
- After the `limitTokens` line add:

```js
  const limitJoin = makeLimiter(joinLimit, 'too many tries; wait a minute and try again')
```

- Change the `ctx` line to:

```js
  const ctx = { store, user, now, site, apiUrl: api, mailer, log, limit: limitInvites, limitSend: limitInviteSend, limitTokens, limitJoin, agentAuth }
```

- Change the push to `routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx), ...agentRoutes(ctx), ...agentInviteRoutes(ctx), ...joinRoutes(ctx))`.

In `bin/quilt.js` `apiCmd()`, change

```js
  const api = await startApi({
    port: Number(values.port || env.PORT || 8787), host, store, verifyUser, mailer,
```

to

```js
  const port = Number(values.port || env.PORT || 8787)
  const api = await startApi({
    port, host, store, verifyUser, mailer,
    // Where agents reach this API (invite links point here).
    apiUrl: env.QUILT_API_PUBLIC_URL || (values.memory ? `http://${host}:${port}` : 'https://api.heyquilt.com'),
```

In `fly.api.toml`, under `[env]` after `QUILT_TRUST_PROXY = "1"` add:

```toml
  QUILT_API_PUBLIC_URL = "https://api.heyquilt.com"
```

In `scripts/api-smoke.mjs`, before the line `if (!JWT) {`, add:

```js
// Join links never leak into caches or search, and an unknown one only explains.
const bogus = await fetch(`${API}/v1/join/qj_smoke`); ok(bogus.status === 404 && bogus.headers.get('x-robots-tag') === 'noindex', 'join link unknown')
```

and before `console.log('all good')` add:

```js
const inv = await call('POST', '/v1/agent-invites', {}, JWT); ok(inv.b?.link?.includes('/v1/join/qj_'), 'agent invite made')
const preview = await fetch(inv.b.link); ok(preview.status === 200 && (await preview.text()).includes('Status: this invite is open'), 'join link explains')
ok((await call('DELETE', `/v1/agent-invites/${inv.b.invite.id}`, null, JWT)).s === 200, 'agent invite cancelled (a preview did not use it)')
```

- [ ] **Step 7: Run the tests**

Run: `node --test test/api-join.test.js && npm test`
Expected: PASS, `# pass 11` for the new file, then the whole suite `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/api/http.js src/api/join-text.js src/api/routes/join.js src/api/server.js bin/quilt.js fly.api.toml scripts/api-smoke.mjs test/api-helpers.js test/api-join.test.js
git commit -m "Let an AI join through its invite link"
```

---
### Task 7: API: org agents in the member and team routes

**Files:**
- Create: `test/api-agent-orgs.test.js`
- Modify: `src/api/routes/members.js` (rewrite), `src/api/routes/teams.js` (rewrite), `test/api-teams.test.js`

**Interfaces:**
- Consumes: `orgAccess` (`need`, `can`, `covers`, `assignable`); `addAgentMember`, `memberByAgent`, `revokeAgent` (Task 2); `listMembers` rows with `provider`/`type`, `listTeamMembers` rows with `kind`/`scopes`, `addTeamMember`/`setTeamAccess` with `scopes` (Tasks 2-3); `accessOf`, `cleanScopes` (Task 5); `makeAgent` (Task 4).
- Produces:
  - `GET /v1/orgs/:slug/members` rows: `{ id, kind, userId, agentId, name, provider, type, email, roleId, role, isOwner, isYou, joinedAt, teams: [{ id, name, access, scopes }] }` (people need Members: Read, agents need Agents: Read)
  - `PUT /v1/orgs/:slug/members/:id` on an agent: Agents: Update, `roleId` may be null; `DELETE` on an agent: Agents: Delete, revokes it
  - `GET /v1/orgs/:slug/teams`: `members: [{ memberId, name, access, kind, scopes }]`, `people: [{ memberId, name, kind }]`
  - `POST /v1/orgs/:slug/teams/:id/members { memberId, access, scopes? }` and `PUT …/members/:memberId { access, scopes? }` answer `{ member: { memberId, access, scopes } }`; folders only for agents

- [ ] **Step 1: Write the failing tests**

Create `test/api-agent-orgs.test.js`:

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, makeAgent } from './api-helpers.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const bearer = (key) => ({ authorization: `Bearer ${key}` })

test('org agents are listed with people as kind agent, with their profile, for those who may read agents', async () => {
  const o = await makeOrg(t, 'Listing Co')
  const { agent } = await makeAgent(t, { name: 'Bot', provider: 'OpenAI', orgId: o.org.id })
  const m = await t.store.addAgentMember({ orgId: o.org.id, agentId: agent.id })
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  await t.store.addTeamMember({ teamId: core.id, memberId: m.id, access: 'viewer', scopes: ['src'] })
  const r = await t.call('GET', `/v1/orgs/${o.slug}/members`, null, 'admin')
  const bot = r.body.members.find((x) => x.id === m.id)
  assert.deepEqual(
    [bot.kind, bot.name, bot.provider, bot.type, bot.agentId, bot.email, bot.role, bot.userId, bot.isYou, bot.isOwner],
    ['agent', 'Bot', 'OpenAI', 'coding agent', agent.id, '', null, null, false, false]
  )
  assert.deepEqual(bot.teams, [{ id: core.id, name: 'Core', access: 'viewer', scopes: ['src'] }])
  const mo = r.body.members.find((x) => x.userId === 'mem')
  assert.deepEqual([mo.kind, mo.provider, mo.type], ['person', null, null])
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

Run: `node --test test/api-agent-orgs.test.js test/api-teams.test.js`
Expected: FAIL: agent members are missing `kind`/`provider`, agent role changes answer 403 (Members/Roles: Update checks), the team routes ignore `scopes`, and the `scopes`/`kind` deepEqual mismatches in `api-teams`.

- [ ] **Step 3: Rewrite the member routes**

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
          provider: m.provider ?? null,
          type: m.type ?? null,
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

- [ ] **Step 4: Rewrite the team routes**

Replace `src/api/routes/teams.js` with:

```js
// Flat teams inside an org, and who's in each: people and agents with editor or
// viewer access, and for agents, optional folders.
import { HttpError, needId, cleanName } from '../http.js'
import { orgAccess } from '../org-access.js'
import { accessOf, cleanScopes } from '../team-access.js'

const kindOf = (m) => (m.agentId ? 'agent' : 'person')
const memberView = (tm) => ({ memberId: tm.memberId, access: tm.access, scopes: tm.scopes || [] })

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

- [ ] **Step 5: Run the tests**

Run: `node --test test/api-agent-orgs.test.js test/api-teams.test.js && npm test`
Expected: PASS, `# pass 4` for the new file, then `api-teams`, then the whole suite `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/members.js src/api/routes/teams.js test/api-agent-orgs.test.js test/api-teams.test.js
git commit -m "Show org agents among members, with roles, teams and folders"
```

---
### Task 8: CLI: `quilt agent join` and `quilt agent whoami`

**Files:**
- Create: `src/agent-join.js`, `test/agent-join.test.js`
- Modify: `bin/quilt.js`

**Interfaces:**
- Consumes: `generateIdentity` (`src/identity.js`); `quiltHome` (`src/legacy.js`); `POST /v1/join/:token` (Task 6), `POST /v1/agents/token` and `GET /v1/agents/me` (Task 4); `API_URL` and `startTestApi` (`test/api-helpers.js`).
- Produces (`src/agent-join.js`):
  - `DEFAULTS = { provider: 'Quilt CLI', type: 'command-line agent' }`
  - `agentFile(name, dir = quiltHome()) -> string` (`<dir>/agents/<name>.json`; throws on a bad name)
  - `parseJoinLink(link) -> { api, token }` (`api` = the link's origin; throws on anything that isn't `…/v1/join/qj_…`)
  - `agentJoin({ link, name, provider, type, description, dir, fetch, log }) -> Saved` where `Saved = { name, api, agentId, accessKey, accessExpiresAt, refreshKey, refreshExpiresAt, identity }`, written with mode `0600`
  - `agentWhoami({ name, dir, fetch, now }) -> /v1/agents/me body` (refreshes first when the access key is within a minute of expiry, saving the new pair)
  - `describeAgent(me) -> string`
  - CLI: `quilt agent join <link> --name <name> [--provider <p>] [--type <t>] [--description <d>]`, `quilt agent whoami --name <name>`

- [ ] **Step 1: Write the failing tests**

Create `test/agent-join.test.js`:

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { startTestApi, API_URL } from './api-helpers.js'
import { agentJoin, agentWhoami, agentFile, describeAgent, parseJoinLink, DEFAULTS } from '../src/agent-join.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-agent-'))
// A fresh personal invite link, pointed at the test API instead of the public address.
const newLink = async (who = 'mem') => (await t.call('POST', '/v1/agent-invites', {}, who)).body.link.replace(API_URL, t.api.url)

test('quilt agent join uses the link once and saves its keys privately', async () => {
  const dir = tmp()
  const lines = []
  const saved = await agentJoin({ link: await newLink(), name: 'larry', dir, log: (l) => lines.push(l) })
  assert.match(lines[0], /Joined Quilt as larry/)
  assert.match(saved.accessKey, /^qa_/)
  const file = agentFile('larry', dir)
  assert.equal(file, path.join(dir, 'agents', 'larry.json'))
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual([onDisk.agentId, onDisk.api, !!onDisk.identity.privateKey, onDisk.refreshKey], [saved.agentId, t.api.url, true, saved.refreshKey])
  const agent = await t.store.agentById(saved.agentId)
  assert.deepEqual([agent.name, agent.provider, agent.type, agent.publicKey], ['larry', DEFAULTS.provider, DEFAULTS.type, onDisk.identity.publicKey])
})

test('quilt agent whoami says who the agent is, refreshing an expired access key first', async () => {
  const dir = tmp()
  const saved = await agentJoin({ link: await newLink(), name: 'whoami-bot', provider: 'Anthropic', type: 'coding', dir, log: () => {} })
  const me = await agentWhoami({ name: 'whoami-bot', dir })
  assert.deepEqual([me.agent.id, me.agent.kind], [saved.agentId, 'personal'])
  assert.equal(describeAgent(me), 'whoami-bot (Anthropic, coding): your personal agent')
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
  const me = { agent: { name: 'Bot', provider: 'OpenAI', type: 'coding agent', kind: 'org', org: { slug: 'acme', name: 'Acme' } }, role: { name: 'Lead' }, teams: [{ name: 'Core', access: 'editor', scopes: ['src', 'docs'] }, { name: 'Web', access: 'viewer', scopes: [] }] }
  assert.equal(describeAgent(me), 'Bot (OpenAI, coding agent): an agent in Acme\nRole: Lead\nTeam Core: editor, folders src, docs\nTeam Web: viewer')
})

test('used and malformed links, bad names and unknown agents are refused clearly', async () => {
  const link = await newLink()
  await agentJoin({ link, name: 'first', dir: tmp(), log: () => {} })
  await assert.rejects(agentJoin({ link, name: 'second', dir: tmp(), log: () => {} }), /already used/)
  for (const bad of ['nope', 'https://api.heyquilt.com/v1/agents', 'ftp://x/v1/join/qj_a']) assert.throws(() => parseJoinLink(bad), /invite link/, bad)
  assert.deepEqual(parseJoinLink('https://api.heyquilt.com/v1/join/qj_abc'), { api: 'https://api.heyquilt.com', token: 'qj_abc' })
  assert.throws(() => agentFile('../evil', tmp()), /--name/)
  await assert.rejects(agentWhoami({ name: 'nobody', dir: tmp() }), /quilt agent join <link> --name nobody/)
})

test('quilt agent needs a subcommand, a link to join, and a name', () => {
  const bin = new URL('../bin/quilt.js', import.meta.url).pathname
  for (const args of [['agent'], ['agent', 'join', '--name', 'x'], ['agent', 'join', 'https://x/v1/join/qj_a'], ['agent', 'whoami'], ['agent', 'dance', '--name', 'x']]) {
    const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 1, args.join(' '))
    assert.match(r.stderr, /quilt agent join <link> --name <name>/)
  }
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/agent-join.test.js`
Expected: FAIL with `Cannot find module '…/src/agent-join.js'`.

- [ ] **Step 3: Write the module**

Create `src/agent-join.js`:

```js
// `quilt agent join|whoami`: join Quilt as an agent from a terminal, the way an
// AI uses an invite link: send a short profile to the link, get keys back, and
// keep them in ~/.quilt/agents/<name>.json (readable only by you).
import fs from 'node:fs'
import path from 'node:path'
import { quiltHome } from './legacy.js'
import { generateIdentity } from './identity.js'

export const DEFAULTS = { provider: 'Quilt CLI', type: 'command-line agent' }
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/
const NOT_A_LINK = "That doesn't look like an agent invite link. Copy the whole link from Quilt."
// Refresh a little early so the access key doesn't lapse mid-request.
const EARLY_MS = 60 * 1000

export function agentFile (name, dir = quiltHome()) {
  if (!NAME.test(String(name || ''))) throw new Error('--name must be 1 to 40 letters, numbers, dots, dashes or underscores')
  return path.join(dir, 'agents', `${name}.json`)
}

/** The API's address and the token in an invite link. */
export function parseJoinLink (link) {
  let u
  try { u = new URL(String(link)) } catch { throw new Error(NOT_A_LINK) }
  const m = u.pathname.match(/^\/v1\/join\/(qj_[A-Za-z0-9_-]+)\/?$/)
  if (!m || !['http:', 'https:'].includes(u.protocol)) throw new Error(NOT_A_LINK)
  return { api: u.origin, token: m[1] }
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
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new Error(`No agent called ${name} here. Run: quilt agent join <link> --name ${name}`) }
}

/** Uses an invite link once and saves the agent's keys. */
export async function agentJoin ({ link, name, provider = DEFAULTS.provider, type = DEFAULTS.type, description = '', dir, fetch: fetchImpl = globalThis.fetch, log = console.log }) {
  const file = agentFile(name, dir)
  const { api, token } = parseJoinLink(link)
  // The agent's own Ed25519 key, for joining sessions in later versions.
  const identity = generateIdentity()
  const r = await send(fetchImpl, api, 'POST', `/v1/join/${token}`, { name, provider, type, description, publicKey: identity.publicKey })
  if (!r.ok) throw new Error(r.body?.error || `Couldn't join Quilt (${r.status}).`)
  const saved = { name, api, agentId: r.body.agentId, accessKey: r.body.accessKey, accessExpiresAt: r.body.accessExpiresAt, refreshKey: r.body.refreshKey, refreshExpiresAt: r.body.refreshExpiresAt, identity }
  save(file, saved)
  log(`Joined Quilt as ${name}. Keys saved in ${file}`)
  return saved
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
  const lines = [`${me.agent.name} (${me.agent.provider}, ${me.agent.type}): ${where}`]
  if (me.role) lines.push(`Role: ${me.role.name}`)
  for (const t of me.teams) lines.push(`Team ${t.name}: ${t.access}${t.scopes.length ? `, folders ${t.scopes.join(', ')}` : ''}`)
  return lines.join('\n')
}
```

- [ ] **Step 4: Add the command**

In `bin/quilt.js`:

- In `HELP`, after the `quilt api …` line add:

```
  quilt agent join <link> --name <name>               Join Quilt as an agent with an invite link from the website
  quilt agent whoami --name <name>                    Show who a joined agent is
```

- In `main()`'s switch, after `case 'api': return apiCmd()` add `    case 'agent': return agentCmd()`.
- After the `apiCmd` function add:

```js
async function agentCmd () {
  const usage = 'usage: quilt agent join <link> --name <name> [--provider <p>] [--type <t>] [--description <d>]\n       quilt agent whoami --name <name>'
  const [sub, ...rest] = argv
  let parsed = { values: {}, positionals: [] }
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: { name: { type: 'string' }, provider: { type: 'string' }, type: { type: 'string' }, description: { type: 'string' } } })
  } catch { fail(usage) }
  const { values, positionals } = parsed
  if (!values.name || !((sub === 'join' && positionals[0]) || sub === 'whoami')) fail(usage)
  const { agentJoin, agentWhoami, describeAgent } = await import('../src/agent-join.js')
  try {
    if (sub === 'join') await agentJoin({ link: positionals[0], name: values.name, provider: values.provider, type: values.type, description: values.description })
    else console.log(describeAgent(await agentWhoami({ name: values.name })))
  } catch (err) {
    fail(err.message)
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/agent-join.test.js && npm test`
Expected: PASS, `# pass 5` for the new file, then the whole suite `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/agent-join.js bin/quilt.js test/agent-join.test.js
git commit -m "Add quilt agent join and whoami"
```

---
### Task 9: Website: "Invite an agent" and "Your agents" on the dashboard

**Files:**
- Create: `web/lib/agent-form.js`, `web/lib/agent-view.js`, `web/components/AgentInvite.js`, `web/components/AgentInviteList.js`, `web/test/agent-form.test.js`, `web/test/agent-view.test.js`
- Modify: `web/app/dashboard/page.js` (rewrite), `web/app/dashboard/actions.js`
- Delete: `web/components/NewAgent.js`, `web/lib/agent-setup.js`, `web/test/agent-setup.test.js`

**Interfaces:**
- Consumes: API `POST|GET /v1/agent-invites`, `DELETE /v1/agent-invites/:id` (Task 5), `GET /v1/agents` (profile + `status`), `DELETE /v1/agents/:id` (Task 4); `apiCall`, `requireUser`, `when`, `safeMessage`.
- Produces:
  - `web/lib/agent-form.js`: `splitFolders(s) -> string[]`; `inviteFromForm(formData) -> { roleId: string|null, teams: [{ teamId, access, scopes }] }` (fields `roleId`, repeated `teamId`/`access`/`folders`; rows without a team skipped; access is `editor` only when chosen, else `viewer`)
  - `web/lib/agent-view.js`: `agentStatus(status) -> null | { label, why }`; `inviteStatusText(invite) -> string`; `AGENT_JOIN_COMMAND = 'quilt agent join <link> --name my-agent'`
  - `<AgentInvite action slug? roles? teams? />` (client): org choices when `roles`/`teams` are given; after a successful action (`{ link }`) shows the link once with Copy and Done; shows `{ error }`
  - `<AgentInviteList invites cancel slug? />`: status, when it was made, its teams and role, and Cancel for waiting invites
  - Dashboard actions `createAgentInvite(prev, formData) -> { link } | { error }`, `cancelAgentInvite(formData)`

- [ ] **Step 1: Write the failing tests**

Create `web/test/agent-form.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inviteFromForm, splitFolders } from '../lib/agent-form.js'

test('splitFolders splits on commas and drops blanks; the API tidies each folder', () => {
  assert.deepEqual(splitFolders(' src, docs/ ,,web '), ['src', 'docs/', 'web'])
  assert.deepEqual(splitFolders(null), [])
})

test('inviteFromForm reads the role and each filled-in team row in order, viewer unless editor was chosen', () => {
  const f = new FormData()
  f.append('slug', 'acme')
  f.append('roleId', '')
  for (const [teamId, access, folders] of [['t1', 'editor', 'src, docs'], ['', 'viewer', 'ignored'], ['t2', 'owner', '']]) {
    f.append('teamId', teamId); f.append('access', access); f.append('folders', folders)
  }
  assert.deepEqual(inviteFromForm(f), {
    roleId: null,
    teams: [{ teamId: 't1', access: 'editor', scopes: ['src', 'docs'] }, { teamId: 't2', access: 'viewer', scopes: [] }]
  })
  f.set('roleId', 'r1')
  assert.equal(inviteFromForm(f).roleId, 'r1')
  assert.deepEqual(inviteFromForm(new FormData()), { roleId: null, teams: [] })
})
```

Create `web/test/agent-view.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentStatus, inviteStatusText, AGENT_JOIN_COMMAND } from '../lib/agent-view.js'

test('agentStatus explains a signed-out agent and says nothing for an active one', () => {
  assert.equal(agentStatus('active'), null)
  assert.equal(agentStatus(undefined), null)
  assert.equal(agentStatus('toString'), null)
  assert.equal(agentStatus('reused').label, 'Signed out')
  assert.match(agentStatus('reused').why, /old key/)
  assert.equal(agentStatus('expired').label, 'Signed out')
  assert.match(agentStatus('expired').why, /30 days/)
})

test('inviteStatusText names who used an invite', () => {
  assert.equal(inviteStatusText({ status: 'waiting' }), 'Waiting')
  assert.equal(inviteStatusText({ status: 'used', usedBy: { name: 'Larry', provider: 'Anthropic' } }), 'Used by Larry (Anthropic)')
  assert.equal(inviteStatusText({ status: 'used', usedBy: null }), 'Used')
  assert.equal(inviteStatusText({ status: 'expired' }), 'Expired')
  assert.equal(inviteStatusText({ status: 'cancelled' }), 'Cancelled')
  assert.equal(AGENT_JOIN_COMMAND, 'quilt agent join <link> --name my-agent')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd web && npm test`
Expected: FAIL: `Cannot find module '…/web/lib/agent-form.js'` and `…/web/lib/agent-view.js'`.

- [ ] **Step 3: Write the helpers**

Create `web/lib/agent-form.js`:

```js
// Reading the agent invite form. Pure, so it's unit-tested directly.

/** "src, docs/ ,web" to ['src', 'docs/', 'web']: the API tidies each folder. */
export function splitFolders (s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean)
}

/** The role and teams an org invite hands out. Rows without a team are skipped. */
export function inviteFromForm (formData) {
  const access = formData.getAll('access').map(String)
  const folders = formData.getAll('folders').map(String)
  const teams = formData.getAll('teamId').map(String)
    .map((teamId, i) => ({ teamId, access: access[i] === 'editor' ? 'editor' : 'viewer', scopes: splitFolders(folders[i]) }))
    .filter((t) => t.teamId)
  return { roleId: String(formData.get('roleId') || '') || null, teams }
}
```

Create `web/lib/agent-view.js`:

```js
// Words for agents and agent invites on the website. Pure.
const STATUS = {
  reused: { label: 'Signed out', why: 'An old key of this agent was used again, so its keys were revoked. Invite it again.' },
  expired: { label: 'Signed out', why: "It wasn't used for 30 days. Invite it again." }
}

/** Why an agent is signed out, or null while it can still refresh its keys. */
export function agentStatus (status) {
  return Object.hasOwn(STATUS, status) ? STATUS[status] : null
}

const INVITE = { waiting: 'Waiting', expired: 'Expired', cancelled: 'Cancelled' }

/** An invite's state, naming the agent that used it. */
export function inviteStatusText (invite) {
  if (invite.status === 'used') return invite.usedBy ? `Used by ${invite.usedBy.name} (${invite.usedBy.provider})` : 'Used'
  return Object.hasOwn(INVITE, invite.status) ? INVITE[invite.status] : 'Waiting'
}

export const AGENT_JOIN_COMMAND = 'quilt agent join <link> --name my-agent'
```

- [ ] **Step 4: Write the invite components**

Create `web/components/AgentInvite.js`:

```js
'use client'
import { useActionState, useState } from 'react'

function TeamRow ({ teams }) {
  return (
    <div className='row'>
      <select className='input' name='teamId' defaultValue='' aria-label='Team'>
        <option value=''>Pick a team</option>
        {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <select className='input' name='access' defaultValue='viewer' aria-label='Access'>
        <option value='viewer'>Viewer</option>
        <option value='editor'>Editor</option>
      </select>
      <input className='input' name='folders' placeholder='Folders, e.g. src, docs (optional)' aria-label='Folders' style={{ flex: '1 1 200px' }} />
    </div>
  )
}

// For an org: an optional role, and the teams the agent joins.
function OrgChoices ({ roles, teams }) {
  const [rows, setRows] = useState(teams.length ? 1 : 0)
  return (
    <div className='stack'>
      {roles.length > 0 && (
        <div className='field'>
          <label htmlFor='invite-role'>Org role</label>
          <select id='invite-role' className='input' name='roleId' defaultValue=''>
            <option value=''>No role (team access only)</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>)}
      {teams.length > 0 && (
        <div className='stack'>
          <b>Teams</b>
          {Array.from({ length: rows }, (_, i) => <TeamRow key={i} teams={teams} />)}
          {rows < teams.length && <button type='button' className='btn ghost' onClick={() => setRows(rows + 1)}>Add another team</button>}
          <p className='muted'>Agents start as viewers. Folders limit it to parts of the project; leave them empty for all of it.</p>
        </div>)}
    </div>
  )
}

/** "Invite an agent": makes a one-time link and shows it once, with Copy. */
export default function AgentInvite ({ action, slug, roles, teams }) {
  const [state, formAction, pending] = useActionState(action, null)
  // Done hides the link without touching the action state, so it isn't shown again until a new invite.
  const [shown, setShown] = useState(true)
  const [copied, setCopied] = useState(false)
  const forOrg = Array.isArray(roles) || Array.isArray(teams)

  const copyLink = async () => {
    await navigator.clipboard.writeText(state.link)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (state?.link && shown) {
    return (
      <div className='stack notice'>
        <b>Paste this into your AI.</b>
        <code style={{ wordBreak: 'break-all' }}>{state.link}</code>
        <div className='row'>
          <button type='button' className='btn primary' onClick={copyLink}>{copied ? 'Copied' : 'Copy'}</button>
          <button type='button' className='btn ghost' onClick={() => setShown(false)}>Done</button>
        </div>
        <p className='muted'>It works once, within an hour. Anyone with the link can use it, so only give it to your own AI.</p>
      </div>
    )
  }
  return (
    <form action={formAction} className='stack' onSubmit={() => setShown(true)}>
      {slug && <input type='hidden' name='slug' value={slug} />}
      {forOrg && <OrgChoices roles={roles || []} teams={teams || []} />}
      <div className='row'><button className='btn primary' disabled={pending}>{pending ? 'Making a link…' : 'Invite an agent'}</button></div>
      {state?.error && <p className='notice bad'>{state.error}</p>}
    </form>
  )
}
```

Create `web/components/AgentInviteList.js`:

```js
import { when } from '@/lib/org-view.js'
import { inviteStatusText } from '@/lib/agent-view.js'

// Recent agent invites: who used them, and Cancel for the ones still waiting.
export default function AgentInviteList ({ invites, cancel, slug }) {
  if (!invites?.length) return null
  return (
    <div>
      {invites.map((i) => (
        <div key={i.id} className='list-row'>
          <span>
            <b>{inviteStatusText(i)}</b>
            <br />
            <span className='muted'>
              Made {when(i.createdAt)}
              {i.status === 'waiting' && ` · expires ${when(i.expiresAt)}`}
              {i.role && ` · role ${i.role}`}
              {i.teams.length > 0 && ` · ${i.teams.map((t) => `${t.name} (${t.access})`).join(', ')}`}
            </span>
          </span>
          {i.status === 'waiting' && (
            <form action={cancel}>
              {slug && <input type='hidden' name='slug' value={slug} />}
              <input type='hidden' name='id' value={i.id} />
              <button className='btn ghost danger'>Cancel</button>
            </form>)}
        </div>))}
    </div>
  )
}
```

- [ ] **Step 5: Rebuild the dashboard's agents section**

```bash
git rm web/components/NewAgent.js web/lib/agent-setup.js web/test/agent-setup.test.js
```

In `web/app/dashboard/actions.js`, replace the whole `createAgent` function and its comment line (`// Creating an agent mints a key and an identity, so it goes through the API. The key comes back once.`) with:

```js
// An agent invite link is shown once, so it comes back to the form rather than through a redirect.
export async function createAgentInvite () {
  const user = await requireUser('/dashboard')
  const r = await apiCall(user, 'POST', '/v1/agent-invites', {})
  if (!r.ok) return { error: r.data?.error || 'Couldn’t make an invite link. Try again.' }
  revalidatePath('/dashboard')
  return { link: r.data.link }
}

export async function cancelAgentInvite (formData) {
  const user = await requireUser('/dashboard')
  await apiCall(user, 'DELETE', `/v1/agent-invites/${encodeURIComponent(String(formData.get('id')))}`)
  revalidatePath('/dashboard')
}
```

(`revokeAgent` stays as it is.)

Replace `web/app/dashboard/page.js` with:

```js
import { headers, cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Header from '@/components/Header.js'
import FirstOrg from '@/components/FirstOrg.js'
import SpaceSwitcher from '@/components/SpaceSwitcher.js'
import AgentInvite from '@/components/AgentInvite.js'
import AgentInviteList from '@/components/AgentInviteList.js'
import { requireUser } from '@/lib/session.js'
import { createClient } from '@/lib/supabase/server.js'
import { apiCall } from '@/lib/api.js'
import { myOrgs } from '@/lib/org.js'
import { SPACE_COOKIE, spaceHome } from '@/lib/space.js'
import { safeMessage, when } from '@/lib/org-view.js'
import { agentStatus, AGENT_JOIN_COMMAND } from '@/lib/agent-view.js'
import { downloadFor, DOWNLOADS } from '@/lib/platform.js'
import { unlinkComputer, revokeAgent, askToJoin, createAgentInvite, cancelAgentInvite } from './actions.js'

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
  const [{ data: computers }, agentsRes, invitesRes, discover, { data: profile }] = await Promise.all([
    supabase.from('devices').select('id, name, platform, last_seen_at, revoked_at').is('revoked_at', null).order('last_seen_at', { ascending: false }),
    apiCall(user, 'GET', '/v1/agents'),
    apiCall(user, 'GET', '/v1/agent-invites'),
    // Orgs on the person's own (confirmed, non-public) email domain that take join requests.
    apiCall(user, 'GET', '/v1/orgs/discover'),
    // Only an org account ever gets a FirstOrg card, even if a personal account somehow has stray org_name metadata.
    supabase.from('profiles').select('kind').eq('id', user.id).maybeSingle()
  ])
  // The API lists only agents that aren't revoked.
  const agents = agentsRes.data?.agents || []
  const invites = (invitesRes.data?.invites || []).slice(0, 10)
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
                      <span className='muted'>{a.provider} · {a.type}{a.description ? ` · ${a.description}` : ''}</span>
                      <br />
                      <span className='muted'>{s ? s.why : `Added ${when(a.createdAt)} · last used ${when(a.lastUsedAt)}`}</span>
                    </span>
                    <form action={revokeAgent}><input type='hidden' name='id' value={a.id} /><button className='btn ghost danger'>Revoke</button></form>
                  </div>)
              })}
            </div>)}
          <div className='stack'>
            <h3>Invite an agent</h3>
            <p className='muted'>Make a one-time link and paste it into your AI (Claude Code, Cursor, ChatGPT and others). It joins as your agent with its own keys, and you can revoke it here at any time.</p>
            <AgentInvite action={createAgentInvite} />
            <AgentInviteList invites={invites} cancel={cancelAgentInvite} />
            <p className='muted'>From a terminal: <code>{AGENT_JOIN_COMMAND}</code></p>
          </div>
        </section>
      </main>
    </>
  )
}
```

- [ ] **Step 6: Run the tests**

Run: `cd web && npm test && grep -rn "agent-setup\|NewAgent\|createAgent(\|keyPrefix" app components lib test`
Expected: tests PASS, `# fail 0` (including `no-em-dash` and the route smoke tests); the grep prints nothing.

- [ ] **Step 7: Commit**

```bash
git add -A web/lib web/components web/app/dashboard web/test
git commit -m "Invite agents and list them on the dashboard"
```

---

### Task 10: Website: org agents and agent invites on People; Teams shows agents

**Files:**
- Modify: `web/app/org/[slug]/people/page.js` (rewrite), `web/app/org/[slug]/people/actions.js` (rewrite), `web/app/org/[slug]/teams/page.js`, `web/lib/org-view.js`, `web/test/org-view.test.js`

**Interfaces:**
- Consumes: API `GET /v1/orgs/:slug/members` (`kind`, `provider`, `type`, `teams[].scopes`), `PUT|DELETE /v1/orgs/:slug/members/:id` (Task 7), `PUT /v1/orgs/:slug/teams/:id/members/:memberId { access, scopes }` (Task 7), `POST|GET /v1/orgs/:slug/agent-invites`, `DELETE /v1/orgs/:slug/agent-invites/:id` (Task 5), `GET /v1/orgs/:slug/teams`, `GET /v1/orgs/:slug/roles`; `AgentInvite`, `AgentInviteList`, `inviteFromForm`, `splitFolders` (Task 9); `orgAction`, `enc` (`web/lib/org-actions.js`); `allowed`, `assignableRoles` (`web/lib/org-view.js`); `isSlug` (`web/lib/space.js`).
- Produces:
  - `orgTabs` shows People for Members: Read **or** Agents: Read
  - People actions: `setRole`, `removeMember` (revokes an agent), `setAgentTeam`, `createOrgAgentInvite(prev, formData) -> { link } | { error }`, `cancelOrgAgentInvite`

- [ ] **Step 1: Write the failing test**

Append to `web/test/org-view.test.js`:

```js
test('orgTabs shows People to those who may read agents, even without Members: Read', () => {
  const watcher = { isOwner: false, grants: { agents: { r: true } } }
  assert.deepEqual(orgTabs('acme', watcher).map((t) => t.label), ['Overview', 'People', 'Teams'])
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd web && npm test`
Expected: FAIL: the new orgTabs test gets `['Overview', 'Teams']`.

- [ ] **Step 3: Show People for Agents: Read**

In `web/lib/org-view.js`, change

```js
    allowed(me, 'members', 'r') && { href: `${base}/people`, label: 'People' },
```

to

```js
    (allowed(me, 'members', 'r') || allowed(me, 'agents', 'r')) && { href: `${base}/people`, label: 'People' },
```

- [ ] **Step 4: Rewrite the People actions and page**

Replace `web/app/org/[slug]/people/actions.js` with:

```js
'use server'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { isSlug } from '@/lib/space.js'
import { orgAction, enc } from '@/lib/org-actions.js'
import { inviteFromForm, splitFolders } from '@/lib/agent-form.js'

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

// The invite link is shown once, so it comes back to the form rather than through a redirect.
export async function createOrgAgentInvite (prev, formData) {
  const slug = String(formData.get('slug') || '')
  if (!isSlug(slug)) return { error: 'Something went wrong. Try again.' }
  const user = await requireUser(`/org/${slug}/people`)
  const r = await apiCall(user, 'POST', `/v1/orgs/${slug}/agent-invites`, inviteFromForm(formData))
  if (!r.ok) return { error: r.data?.error || 'Couldn’t make an invite link. Try again.' }
  revalidatePath(`/org/${slug}/people`)
  return { link: r.data.link }
}

export async function cancelOrgAgentInvite (formData) {
  await orgAction(formData, 'people', 'DELETE', `/agent-invites/${enc(formData.get('id'))}`)
}
```

Replace `web/app/org/[slug]/people/page.js` with:

```js
import { notFound } from 'next/navigation'
import Notice from '@/components/Notice.js'
import AgentInvite from '@/components/AgentInvite.js'
import AgentInviteList from '@/components/AgentInviteList.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgMe } from '@/lib/org.js'
import { allowed, assignableRoles } from '@/lib/org-view.js'
import { setRole, removeMember, setAgentTeam, createOrgAgentInvite, cancelOrgAgentInvite } from './actions.js'
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
          <option value='viewer'>Viewer</option>
          <option value='editor'>Editor</option>
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
  const canInvite = allowed(me, 'agents', 'c')
  const [membersRes, rolesRes, teamsRes, invitesRes] = await Promise.all([
    apiCall(user, 'GET', `/v1/orgs/${slug}/members`),
    canAssign || canSetAgentRole || canInvite ? apiCall(user, 'GET', `/v1/orgs/${slug}/roles`) : null,
    canInvite && allowed(me, 'team_members', 'c') ? apiCall(user, 'GET', `/v1/orgs/${slug}/teams`) : null,
    canInvite ? apiCall(user, 'GET', `/v1/orgs/${slug}/agent-invites`) : null
  ])
  const members = membersRes.data?.members || []
  const roles = assignableRoles(rolesRes?.data?.roles, me)
  const pick = (list) => list.map(({ id, name }) => ({ id, name }))
  const canPick = (m) => roles.length > 0 && (!m.roleId || roles.some((r) => r.id === m.roleId))
  return (
    <div className='stack'>
      <section className='card stack'>
        <h2>People and agents</h2>
        <Notice q={q} />
        {!membersRes.ok && <p className='notice bad'>Couldn't load the member list right now.</p>}
        <div>
          {members.map((m) => m.kind === 'agent'
            ? (
              <div key={m.id} className='list-row'>
                <span className='stack' style={{ gap: 6 }}>
                  <span><b>{m.name}</b> <span className='pill'>Agent</span> <span className='muted'>{m.provider} · {m.type}</span></span>
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
      {canInvite && (
        <section className='card stack'>
          <h2>Invite an agent</h2>
          <p className='muted'>Choose what the agent gets, then paste the one-time link into your AI. It joins {me.org.name} as an agent with its own keys.</p>
          <AgentInvite action={createOrgAgentInvite} slug={slug} roles={pick(roles)} teams={pick(teamsRes?.data?.teams || [])} />
          <AgentInviteList invites={(invitesRes?.data?.invites || []).slice(0, 10)} cancel={cancelOrgAgentInvite} slug={slug} />
        </section>)}
    </div>
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

- [ ] **Step 5: Run the tests**

Run: `cd web && npm test`
Expected: PASS, `# fail 0` (including `no-em-dash` and the route smoke tests).

- [ ] **Step 6: Commit**

```bash
git add web/app/org web/lib/org-view.js web/test/org-view.test.js
git commit -m "Show org agents and agent invites on People"
```

---
### Task 11: Deploy and check end to end

**Files:**
- None new (deploys what Tasks 1-10 built).

**Interfaces:**
- Consumes: everything above; the Supabase MCP (`execute_sql`, `apply_migration`, `list_tables`, `get_advisors`); the Fly and Netlify CLIs.
- Produces: the migration applied to project `pwebomewzuezaxoowykk`, `quilt-api` redeployed with `QUILT_API_PUBLIC_URL` and without `AGENT_KEY_SECRET`, the website redeployed to `https://heyquilt.com`.

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

Expected: `agents = 0`, `agent_rooms = 0`, `org_agents = 0`. If any is not 0, stop and ask the person: the migration drops agent key columns and adds required profile columns without carrying anything over.

- [ ] **Step 3: Apply the migration (controller)**

With the Supabase MCP: `apply_migration` on project `pwebomewzuezaxoowykk`, name `agent_sign_in`, query = the contents of `supabase/migrations/20260930020000_agent_sign_in.sql` (it runs as one transaction). Then:
- `list_tables` (schema `public`): `agents`, `agent_invites`, `agent_keys` present with RLS enabled; `agents` has `provider`, `type`, `description`, `owner_user_id`, `org_id`, `invited_by` and no `key_hash`.
- `get_advisors` type `security`: no new errors for these tables (RLS enabled with no policies on `agent_invites`/`agent_keys` is an INFO-level note and expected: only the API reads them).
- `get_advisors` type `performance`: no unindexed foreign keys on the new columns.

(From here until Step 4 finishes, the old API's agent routes fail; there are no agents, so only the dashboard's "Your agents" list is briefly unavailable.)

- [ ] **Step 4: Merge, push and deploy the API (controller)**

`fly.api.toml` now sets `QUILT_API_PUBLIC_URL = "https://api.heyquilt.com"` under `[env]`, so the deploy sets it on Fly.

```bash
git -C /Users/danielcarmichael/elegy merge claude/loving-boyd-2dd130
git -C /Users/danielcarmichael/elegy push
cd /Users/danielcarmichael/elegy && fly deploy --config fly.api.toml --app quilt-api --remote-only --ha=false
curl -s https://api.heyquilt.com/healthz
curl -s -i https://api.heyquilt.com/v1/join/qj_nope | head -20
cd /Users/danielcarmichael/elegy && QUILT_API=https://api.heyquilt.com node scripts/api-smoke.mjs
```

Expected: `{"ok":true}`; `HTTP/2 404` with `x-robots-tag: noindex`, `cache-control: no-store`, `content-type: text/markdown; charset=utf-8` and a body starting `# Join Quilt as an agent` with the line `Status: this invite link isn't valid.`; the smoke script prints `ok   health`, `ok   device/start`, `ok   poll pending`, `ok   join link unknown`, then `set QUILT_TEST_JWT to check approve, profile and agents`. If the machine fails to start, `fly logs --app quilt-api` shows why.

- [ ] **Step 5: Remove the old secret (controller)**

Only now that the new API is live and no longer reads it:

```bash
fly secrets unset AGENT_KEY_SECRET --app quilt-api
curl -s https://api.heyquilt.com/healthz
```

Expected: Fly restarts the machine; `{"ok":true}`; `fly secrets list --app quilt-api` no longer shows `AGENT_KEY_SECRET`.

- [ ] **Step 6: Deploy the website (controller)**

From the main checkout (the Netlify CLI resolves the base from the main repo):

```bash
cd /Users/danielcarmichael/elegy/web && npm ci && cd .. && NETLIFY_SITE_ID=b9131760-8605-44f7-b9e1-3b347fc212b0 netlify deploy --build --prod
```

Expected: `Deploy is live!`.

- [ ] **Step 7: Check it end to end (controller + person)**

1. The person, signed in at `https://heyquilt.com/dashboard`, clicks **Invite an agent** under "Your agents", sees the link with **Copy** and "Paste this into your AI.", and sends the controller that link. The invite list shows it as **Waiting**.
2. A preview never uses an invite: the person makes a second invite and sends that link too; the controller runs `curl -s -i <second link>`. Expected: `200`, `x-robots-tag: noindex`, and `Status: this invite is open.`; on the dashboard that invite is still **Waiting**. The person then clicks **Cancel** on it; `curl -s -i <second link>` now answers `410` with `Status: this invite was cancelled.`
3. The controller, in the main checkout, runs `node bin/quilt.js agent join <first link> --name test-agent --provider Anthropic --type coding`. Expected: `Joined Quilt as test-agent. Keys saved in …/.quilt/agents/test-agent.json`.
4. The controller runs `node bin/quilt.js agent whoami --name test-agent`. Expected: `test-agent (Anthropic, coding): your personal agent`.
5. The person reloads the dashboard: "Your agents" lists **test-agent** with an Agent pill, `Anthropic · coding`, when it was added and last used, and Revoke; the invite shows **Used by test-agent (Anthropic)**. Running the same `agent join` command again fails with `this invite was already used; ask for a new one`.
6. Org check (if the person has an org with a team): on the org's People page, under "Invite an agent", the person picks one team, leaves access at **Viewer**, enters folder `src`, and sends the controller the link; the controller runs `node bin/quilt.js agent join <link> --name test-org-agent --provider Anthropic --type coding`, then `whoami`. Expected: `test-org-agent (Anthropic, coding): an agent in <org>` and `Team <team>: viewer, folders src`. On People the agent shows with an **Agent** pill and `Anthropic · coding`; the person changes its folders to `docs`, saves (sees "Saved."), then clicks **Revoke**, and `whoami` fails with `this agent's keys were revoked; invite it again`.
7. The person revokes **test-agent** on the dashboard; `whoami --name test-agent` fails the same way. The controller deletes the local test files: `rm ~/.quilt/agents/test-agent.json ~/.quilt/agents/test-org-agent.json`.

Fix anything that fails with a new commit, redeploy the part that changed (Step 4 or 6), and repeat the failing check.

---

## Self-review notes

- **Spec coverage (build-order item 2, "Agent sign-in"):** agent invites made only by a signed-in person, personal from the dashboard or org from People with Agents: Create, role under the subset rule and never Owner, teams under Team membership: Create with access defaulting to viewer and folders under the relay's rules, one-time `qj_` links hashed and expiring after 1 hour, `QUILT_API_PUBLIC_URL`: Tasks 1, 3, 5, 9, 10. Links shown once with Copy and "Paste this into your AI", invite list with waiting / used by / expired / cancelled and Cancel: Tasks 5, 9, 10. `POST /v1/join`, the explain-only `GET`, `GET` with a profile, `no-store` and `noindex` headers, per-IP rate limit, the agent profile (name, provider, type, description, optional public key), first key pair once with `api`, `refresh`, `mcp`, `next`: Tasks 1, 2, 6. Keys (`qa_` 1 hour, `qr_` 30 days single use, `POST /v1/agents/token`, families, reuse revokes the family, SHA-256 hashes only, revoking an agent revokes every family, "the dashboard shows why"): Tasks 3, 4, 9. "Replaces": dashboard Create agent flow, `key_hash`/`private_key_enc`/`key_prefix`/`owner_id` and `AGENT_KEY_SECRET` removed, `agent_rooms` untouched: Tasks 1, 2, 9, 11. Data model rows `agents`, `agent_invites`, `agent_keys` and their RLS: Task 1. Agents C/R/U/D and Team membership C/U for agents: Tasks 5, 7. Website personal Agents list with profile and revoke, People & agents with an agent badge, provider/type, teams and folders: Tasks 9, 10. Safeguards 1, 4 and 5 are built here (Tasks 5, 6); safeguards 2 and 3 are recorded in the spec for plans 3 and 4 and are out of scope here. Session passes, desktop sign-in and MCP are later plans.
- **Placeholder scan:** every code step has full code; every run step has a command and the expected result. The only person-supplied actions are making invites, cancelling and revoking on the website (Task 11).
- **Name consistency:** store methods `createAgent`, `agentById`, `agentByPublicKey`, `listPersonalAgents`, `touchAgent`, `revokeAgent`, `deleteAgent`, `addAgentMember`, `memberByAgent`, `createAgentInvite`, `agentInviteByToken`, `agentInviteById`, `listAgentInvites`, `claimAgentInvite`, `releaseAgentInvite`, `setInviteAgent`, `cancelAgentInvite`, `createAgentKeys`, `agentKeyByAccess`, `agentKeyByRefresh`, `listAgentKeys`, `claimRefresh`, `revokeFamily`, and `addTeamMember`/`setTeamAccess`/`teamsOfMember` with `scopes` are the same in Tasks 2-8 and in both stores. `makeAgentAuth` returns `mintKeys`, `refresh`, `agentFromRequest`, used as `ctx.agentAuth.*` by `routes/agents.js` and `routes/join.js`. `inviteStatus` (Task 5) is reused by `routes/join.js`; its values `waiting`/`used`/`expired`/`cancelled` match `inviteStatusText` on the website, and `keyStatus` values `active`/`reused`/`expired` match `agentStatus`. `accessOf`, `cleanScopes` live in `src/api/team-access.js`; `joinInstructions`, `joinNext` in `src/api/join-text.js`; `Raw` in `src/api/http.js`. Website names `inviteFromForm`, `splitFolders`, `AgentInvite`, `AgentInviteList`, `createAgentInvite`, `cancelAgentInvite`, `createOrgAgentInvite`, `cancelOrgAgentInvite`, `setAgentTeam`, `agentStatus`, `inviteStatusText`, `AGENT_JOIN_COMMAND` match between their definitions and uses. `API_URL` in the tests is the API's `apiUrl`.
- **Decisions made in this plan beyond the brief:** see the reply to the coordinator; they are also visible in the code comments (key messages say "invite it again"; listing and cancelling org invites needs Agents: Create; a deleted role only clears an invite's role; teams deleted before the join are skipped; a failed join deletes the half-made agent and reopens the link; `GET` with any of name/provider/type is treated as a join attempt; the description is cut to 180 characters rather than refused; `/v1/join` allows 20 tries a minute per address; the CLI sends its own Ed25519 public key, defaults provider `Quilt CLI` and type `command-line agent`, and talks to the link's own origin; `QUILT_API_PUBLIC_URL` is set in `fly.api.toml` `[env]`).
