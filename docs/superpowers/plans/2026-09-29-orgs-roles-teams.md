# Quilt Orgs, Roles and Teams Implementation Plan (plan 1 of 4 in the orgs spec)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People can create orgs (at sign-up with "A team", or later from the space switcher), give members custom C/R/U/D roles, organise them into flat teams with editor/viewer access, invite people by email, and let people on the org's own email domain ask to join — all managed from a website Org area.

**Architecture:** Two pure modules (`src/api/permissions.js`, `src/api/domains.js`) hold the permission grid and the public-mail blocklist. A new Supabase migration adds seven tables with read-only row-level security; every write goes through the accounts API, which checks the caller's grid (and the no-self-promotion subset rule) using the service role. The API gets org, member, team, invite and join-request routes in three route modules, plus an SMTP mailer for invite emails. The Next.js website gets a "Just me / A team" sign-up choice, a space switcher remembered in a `quilt_space` cookie, and `/org/<slug>/…` pages that read through the API and write through server actions.

**Tech Stack:** Node 22 ESM, `node:http`, `node:test`; Supabase Postgres + `@supabase/supabase-js` 2.117; `nodemailer` (new) over SMTP; Next.js 16 App Router, React 19, `@supabase/ssr`; Fly (`quilt-api`), Netlify (`heyquilt`).

**Spec:** `docs/superpowers/specs/2026-09-29-orgs-roles-agents-design.md` (build order item 1). Context: `docs/superpowers/specs/2026-09-29-website-and-agent-api-design.md`, and the earlier plans `docs/superpowers/plans/2026-09-29-accounts-api.md`, `docs/superpowers/plans/2026-09-29-website.md`.

## Global Constraints

- Out of scope for this plan: agent sign-in (registration, approval page, access/refresh keys), session passes, desktop sign-in, MCP. The existing `agents` table, `POST/GET/DELETE /v1/agents` and the dashboard's agent section stay exactly as they are. `org_members.agent_id` exists but nothing writes it yet.
- Permission grid (rows × Create/Read/Update/Delete; "—" cells are not ops and get no checkbox):
  - Org settings (`org`): Read "see name, domain rule"; Update "change name, domain rule". Create —, Delete — ("deleting the org is Owner-only").
  - Members (`members`): Read "see the member list"; Update "change a member's org role"; Delete "remove a member". Create — ("people join via invites/requests").
  - Agents (`agents`): Create "approve agents into the org"; Read "see org agents"; Update "change an agent's role/teams/folders"; Delete "revoke an agent".
  - Teams (`teams`): Create "create teams"; Read "see all teams (members always see their own)"; Update "rename a team"; Delete "delete a team".
  - Team membership (`team_members`): Create "add people/agents to teams"; Read "see who's in each team"; Update "change editor/viewer and folders"; Delete "remove from a team".
  - User invites (`invites`): Create "send email invites; approve domain requests"; Read "see pending invites/requests"; Update "resend"; Delete "cancel invites; deny requests".
  - Roles (`roles`): Create "create roles"; Read "see roles"; Update "edit a role's grid; assign roles (with Members: Update)"; Delete "delete a role (not while assigned)".
  - Billing (`billing`): "reserved for per-seat plans (later)" — no checkboxes in this plan.
- Built-in roles: **Owner** — every permission, plus transfer ownership and delete the org; exactly one per org; not editable, not assignable except through "transfer ownership". **Admin** — every checkbox; editable. **Member** — Teams: Read; editable. New people default to **Member**.
- Rules the API enforces on every change: (1) you need the checkbox for what you're doing; (2) no self-promotion — you can only create/edit a role whose checkboxes are a subset of your own, and only assign roles that are a subset of your own; you can't change your own role; nobody can edit or assign Owner; (3) an org always has exactly one owner, and ownership transfer is an explicit Owner-only action; (4) deleting a role that is assigned is refused.
- Teams: flat list per org; members have access `editor` or `viewer`; `scopes` (folders) are for agents, at most 20 path prefixes — stored as `'{}'` for people in this plan.
- Email invites: link `<site>/invite/<token>`, token prefix `qi_`, stored only as a SHA-256 hash, expires in **7 days**; the invitee must be signed in with **that confirmed email** (case-insensitive).
- Domain requests: the org domain can be set only by someone with Org settings: Update, only to the domain of their own confirmed email, never a public mail domain (blocklist: gmail.com, googlemail.com, yahoo.*, outlook.com, hotmail.com, live.com, msn.com, icloud.com, me.com, aol.com, proton.me, protonmail.com, gmx.*, mail.com, yandex.*, zoho.com, fastmail.com, hey.com, qq.com, 163.com and similar). Approving needs User invites: Create (choosing a role); denying needs User invites: Delete.
- Rate limits keyed on `fly-client-ip` (when `QUILT_TRUST_PROXY=1`), like device linking — applied to invite lookup/acceptance and join requests.
- Email confirmation must be **on** in Supabase Auth, with a custom SMTP provider (Resend or Postmark), before orgs launch.
- The API sends invite emails itself over SMTP: env `SMTP_URL` (e.g. `smtp://user:pass@smtp.resend.com:587`) and `SMTP_FROM`; `quilt api --memory` prints emails to the console.
- Space switcher cookie: `quilt_space` = `personal` or an org slug. Org pages live under `/org/<slug>/…`. Slugs: lowercase `[a-z0-9-]`, from the name, unique with a numeric suffix (`acme`, `acme-2`, …).
- Supabase project `pwebomewzuezaxoowykk`; API `https://quilt-api.fly.dev` (Fly app `quilt-api`); website `https://heyquilt.netlify.app` (Netlify site id `b9131760-8605-44f7-b9e1-3b347fc212b0`, deployed from the main checkout `/Users/danielcarmichael/elegy`).
- API timestamps are epoch ms; Supabase rows are ISO strings. Website row-level-security reads must name columns (never `select('*')`).
- Look: the existing website classes (`card`, `stack`, `row`, `btn`, `input`, `field`, `pill`, `notice`) — simple, few fields, no gradients.
- Code style: Node 22 ESM, 2-space indent, no semicolons (`standard`), short comments that explain why; tests with `node:test` and `node:assert/strict`.

---

## File map

| File | Responsibility |
|---|---|
| `src/api/permissions.js` | The grid: `RESOURCES`, `ALLOWED`, `LABELS`, `OPS`, `can`, `isSubset`, `normalizeGrants`, `BUILTIN` |
| `src/api/domains.js` | `emailDomain`, `isDomain`, `isPublicDomain` (public mail blocklist) |
| `src/api/slugs.js` | `slugify`, `uniqueSlug` |
| `supabase/migrations/20260930000000_orgs.sql` | `orgs`, `roles`, `org_members`, `teams`, `team_members`, `org_invites`, `join_requests`; RLS; grants; `create_org`, `transfer_org`, `my_org_ids` |
| `src/api/memory-store.js`, `src/api/supabase-store.js` | New store methods (users, orgs, roles, members, teams, invites, join requests) |
| `src/api/http.js` | `HttpError`, `UUID`, `needId`, `cleanName` (moved out of `server.js`, shared by route modules) |
| `src/api/org-access.js` | `orgAccess(store, userId, slug)`: the caller's role, grants and the checks every org route makes |
| `src/api/routes/orgs.js` | Orgs, settings, domain, transfer, delete, roles |
| `src/api/routes/members.js`, `src/api/routes/teams.js` | Member list/role/remove; teams and team membership |
| `src/api/routes/invites.js`, `src/api/invite-email.js` | Email invites, accepting, domain discovery and join requests; the invite email text |
| `src/api/mailer.js` | `createSmtpMailer` (nodemailer), `createConsoleMailer` |
| `src/api/server.js`, `bin/quilt.js`, `fly.api.toml` | Wiring: route modules, limiter, mailer, env |
| `test/api-helpers.js` | Test API over a memory store, fake mailer, a cast of people, `makeOrg` |
| `test/api-permissions.test.js`, `test/api-migration-orgs.test.js`, `test/api-store-orgs.test.js`, `test/api-supabase-orgs.test.js`, `test/api-orgs.test.js`, `test/api-teams.test.js`, `test/api-invites.test.js`, `test/api-mailer.test.js`, `test/permissions-sync.test.js` | Tests |
| `web/lib/permissions.js` | Copy of `src/api/permissions.js` (a root test keeps them identical) |
| `web/lib/space.js`, `web/lib/space-cookie.js` | Space cookie name, `spaceHome`, `isSlug`; `rememberSpace` |
| `web/lib/org.js`, `web/lib/org-view.js`, `web/lib/org-actions.js`, `web/lib/role-form.js`, `web/lib/signup.js` | Org data loaders, pure view helpers, the shared form-action helper, grid form parsing, sign-up metadata |
| `web/components/SpaceSwitcher.js`, `Notice.js`, `RoleGrid.js`, `FirstOrg.js` | UI pieces |
| `web/app/spaces/actions.js`, `web/app/orgs/new/*` | Switching spaces, creating an org |
| `web/app/org/[slug]/layout.js`, `page.js`, `actions.js` and `people/`, `roles/`, `teams/`, `invites/`, `settings/` | The Org area |
| `web/app/invite/[token]/*` | Accepting an invite |
| `web/app/signup/SignUpForm.js`, `web/app/dashboard/*`, `web/lib/session.js`, `web/proxy.js`, `web/app/globals.css` | Sign-up choice, first-org creation, switcher, discovery, private routes, styles |

---

### Task 1: Permission grid, public mail domains and slugs

**Files:**
- Create: `src/api/permissions.js`, `src/api/domains.js`, `src/api/slugs.js`
- Test: `test/api-permissions.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `permissions.js`: `OPS = ['c','r','u','d']`; `ALLOWED: { [resource]: op[] }`; `RESOURCES = ['org','members','agents','teams','team_members','invites','roles','billing']`; `LABELS: { [resource]: string }`; `normalizeGrants(input) -> { [resource]: { [op]: true } }` (sparse, only true cells); `can(grants, resource, op) -> boolean`; `isSubset(a, b) -> boolean` (every cell of `a` is in `b`); `BUILTIN = { owner, admin, member }` grant objects.
  - `domains.js`: `emailDomain(email) -> string` ('' when invalid), `isDomain(d) -> boolean`, `isPublicDomain(domain) -> boolean`.
  - `slugs.js`: `slugify(name) -> string` (never empty, never `personal`/`new`/`discover`), `uniqueSlug(name, taken: async (slug) => boolean) -> Promise<string>`.

- [ ] **Step 1: Write the failing tests**

Create `test/api-permissions.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OPS, ALLOWED, RESOURCES, LABELS, can, isSubset, normalizeGrants, BUILTIN } from '../src/api/permissions.js'
import { emailDomain, isDomain, isPublicDomain } from '../src/api/domains.js'
import { slugify, uniqueSlug } from '../src/api/slugs.js'

test('the grid has the spec rows, and only the cells the spec gives checkboxes', () => {
  assert.deepEqual(OPS, ['c', 'r', 'u', 'd'])
  assert.deepEqual(RESOURCES, ['org', 'members', 'agents', 'teams', 'team_members', 'invites', 'roles', 'billing'])
  assert.deepEqual(ALLOWED.org, ['r', 'u'])
  assert.deepEqual(ALLOWED.members, ['r', 'u', 'd'])
  for (const r of ['agents', 'teams', 'team_members', 'invites', 'roles']) assert.deepEqual(ALLOWED[r], ['c', 'r', 'u', 'd'], r)
  assert.deepEqual(ALLOWED.billing, [], 'reserved for per-seat plans')
  assert.equal(LABELS.team_members, 'Team membership')
  assert.equal(LABELS.invites, 'User invites')
})

test('can: only real cells, only when granted', () => {
  assert.equal(can({ org: { r: true } }, 'org', 'r'), true)
  assert.equal(can({ org: { c: true } }, 'org', 'c'), false, 'Org settings has no Create')
  assert.equal(can({ members: { c: true } }, 'members', 'c'), false, 'people join via invites')
  assert.equal(can({}, 'teams', 'r'), false)
  assert.equal(can(null, 'teams', 'r'), false)
  assert.equal(can({ nope: { r: true } }, 'nope', 'r'), false)
  assert.equal(can({ teams: { r: 'true' } }, 'teams', 'r'), true)
  assert.equal(can({ teams: { r: 'false' } }, 'teams', 'r'), false)
})

test('normalizeGrants drops unknown rows and ops and coerces checkbox values', () => {
  assert.deepEqual(
    normalizeGrants({ org: { r: 'on', u: false, c: true }, teams: { r: 1, x: true }, bogus: { r: true }, members: 'yes', billing: { r: true } }),
    { org: { r: true }, teams: { r: true } }
  )
  assert.deepEqual(normalizeGrants(null), {})
  assert.deepEqual(normalizeGrants([]), {})
  assert.deepEqual(normalizeGrants({ __proto__: { r: true } }), {})
})

test('isSubset is the no-self-promotion rule', () => {
  assert.equal(isSubset({ teams: { r: true } }, BUILTIN.admin), true)
  assert.equal(isSubset(BUILTIN.admin, { teams: { r: true } }), false)
  assert.equal(isSubset({}, {}), true)
  assert.equal(isSubset({ org: { c: true } }, {}), true, 'a cell that is not an op grants nothing')
  assert.equal(isSubset({ roles: { c: true, r: true } }, { roles: { r: true } }), false)
})

test('built-in roles: Owner and Admin hold every checkbox, Member only Teams: Read', () => {
  assert.deepEqual(BUILTIN.owner, BUILTIN.admin)
  for (const r of RESOURCES) for (const op of ALLOWED[r]) assert.equal(can(BUILTIN.admin, r, op), true, `${r}.${op}`)
  assert.equal('billing' in BUILTIN.admin, false)
  assert.deepEqual(BUILTIN.member, { teams: { r: true } })
})

test('emailDomain and isDomain', () => {
  assert.equal(emailDomain('Dana@Acme.COM'), 'acme.com')
  assert.equal(emailDomain(' a@b@c.io '), 'c.io')
  assert.equal(emailDomain('nope'), '')
  assert.equal(emailDomain('@acme.com'), '')
  assert.equal(emailDomain('x@localhost'), '')
  assert.equal(emailDomain(null), '')
  assert.equal(isDomain('eng.acme.co.uk'), true)
  assert.equal(isDomain('acme'), false)
  assert.equal(isDomain('-acme.com'), false)
})

test('public mail domains are never an org domain', () => {
  for (const d of ['gmail.com', 'GMAIL.COM', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'gmx.de', 'gmx.net', 'yandex.ru', 'yandex.com',
    'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'mail.com',
    'zoho.com', 'fastmail.com', 'hey.com', 'qq.com', '163.com']) assert.equal(isPublicDomain(d), true, d)
  for (const d of ['acme.com', 'yahoo-inc.com', 'mygmail.com', 'eng.acme.io']) assert.equal(isPublicDomain(d), false, d)
})

test('slugify makes URL-safe slugs and avoids reserved words', () => {
  assert.equal(slugify('Acme, Inc.'), 'acme-inc')
  assert.equal(slugify('Café Ünïcode'), 'cafe-unicode')
  assert.equal(slugify('  '), 'org')
  assert.equal(slugify('---'), 'org')
  assert.equal(slugify('Personal'), 'personal-org')
  assert.equal(slugify('New'), 'new-org')
  const long = slugify('a'.repeat(39) + ' b c')
  assert.ok(long.length <= 40 && !long.endsWith('-'), long)
  assert.match(slugify('Ω Rockets!! 2026'), /^[a-z0-9]+(-[a-z0-9]+)*$/)
})

test('uniqueSlug adds a number until the slug is free', async () => {
  const taken = new Set(['acme', 'acme-2'])
  assert.equal(await uniqueSlug('Acme', async (s) => taken.has(s)), 'acme-3')
  assert.equal(await uniqueSlug('Zeta', async (s) => taken.has(s)), 'zeta')
})
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test test/api-permissions.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/api/permissions.js`.

- [ ] **Step 3: Implement**

Create `src/api/permissions.js`:

```js
// Org permissions: a grid of resources × create/read/update/delete. Pure, so the
// API and the website (web/lib/permissions.js is a copy) agree on every check.

export const OPS = ['c', 'r', 'u', 'd']

// Which checkboxes each row has. Cells the spec marks "—" aren't ops at all;
// Billing is reserved for per-seat plans and has none yet.
export const ALLOWED = {
  org: ['r', 'u'],
  members: ['r', 'u', 'd'],
  agents: ['c', 'r', 'u', 'd'],
  teams: ['c', 'r', 'u', 'd'],
  team_members: ['c', 'r', 'u', 'd'],
  invites: ['c', 'r', 'u', 'd'],
  roles: ['c', 'r', 'u', 'd'],
  billing: []
}

export const RESOURCES = Object.keys(ALLOWED)

export const LABELS = {
  org: 'Org settings',
  members: 'Members',
  agents: 'Agents',
  teams: 'Teams',
  team_members: 'Team membership',
  invites: 'User invites',
  roles: 'Roles',
  billing: 'Billing'
}

// Checkbox values arrive as true, 'on' or 'true' depending on who sends them.
const truthy = (v) => v === true || v === 1 || v === 'true' || v === 'on'

/** Keeps only real rows and ops, as `{ resource: { op: true } }` with no false cells. */
export function normalizeGrants (input) {
  const out = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  for (const resource of RESOURCES) {
    if (!Object.hasOwn(input, resource)) continue
    const row = input[resource]
    if (!row || typeof row !== 'object') continue
    const ops = {}
    for (const op of ALLOWED[resource]) if (truthy(row[op])) ops[op] = true
    if (Object.keys(ops).length) out[resource] = ops
  }
  return out
}

export function can (grants, resource, op) {
  return !!(Object.hasOwn(ALLOWED, resource) && ALLOWED[resource].includes(op) && truthy(grants?.[resource]?.[op]))
}

/** True when every checkbox in `a` is also in `b` — the no-self-promotion rule. */
export function isSubset (a, b) {
  return Object.entries(normalizeGrants(a)).every(([resource, ops]) => Object.keys(ops).every((op) => can(b, resource, op)))
}

const everything = () => Object.fromEntries(RESOURCES
  .filter((r) => ALLOWED[r].length)
  .map((r) => [r, Object.fromEntries(ALLOWED[r].map((op) => [op, true]))]))

// Owner is also special-cased in every check (always allowed, never editable or
// assignable); its stored grid is just "everything" for display.
export const BUILTIN = {
  owner: everything(),
  admin: everything(),
  member: { teams: { r: true } }
}
```

Create `src/api/domains.js`:

```js
// Public mail providers: anyone can get an address there, so an org can never
// claim one of these domains for join requests.
const PUBLIC = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'mail.com', 'zoho.com', 'zohomail.com', 'fastmail.com', 'fastmail.fm',
  'hey.com', 'qq.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'naver.com', 'daum.net', 'mail.ru', 'inbox.ru', 'list.ru',
  'bk.ru', 'rambler.ru', 'web.de', 't-online.de', 'tutanota.com', 'tuta.io', 'hushmail.com', 'rediffmail.com', 'ymail.com',
  'rocketmail.com', 'outlook.co.uk', 'hotmail.co.uk', 'live.co.uk', 'duck.com', 'mailbox.org', 'posteo.de'
])
// Providers with a domain per country: yahoo.co.uk, gmx.de, yandex.ru, ...
const FAMILIES = /^(yahoo|gmx|yandex)\.[a-z]{2,}(\.[a-z]{2,})?$/
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export function isDomain (d) {
  return DOMAIN.test(String(d || ''))
}

/** The lowercase domain of an email address, or '' if it doesn't have a real one. */
export function emailDomain (email) {
  const s = String(email || '').trim().toLowerCase()
  const at = s.lastIndexOf('@')
  if (at < 1) return ''
  const d = s.slice(at + 1).replace(/\.$/, '')
  return isDomain(d) ? d : ''
}

export function isPublicDomain (domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/\.$/, '')
  return PUBLIC.has(d) || FAMILIES.test(d)
}
```

Create `src/api/slugs.js`:

```js
// Org addresses: /org/<slug>. Lowercase letters, digits and single hyphens.
// "personal" is the space switcher's name for your own space; "new" and
// "discover" are words routes might want.
const RESERVED = new Set(['personal', 'new', 'discover'])

export function slugify (name) {
  const s = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  if (!s) return 'org'
  return RESERVED.has(s) ? `${s}-org` : s
}

/** The first of base, base-2, base-3, ... that `taken` says is free. */
export async function uniqueSlug (name, taken) {
  const base = slugify(name)
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`
    if (!await taken(slug)) return slug
  }
}
```

- [ ] **Step 4: Run to see it pass**

Run: `node --test test/api-permissions.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/api/permissions.js src/api/domains.js src/api/slugs.js test/api-permissions.test.js
git commit -m "Add the org permission grid, public mail domains and slugs"
```

---

### Task 2: Supabase migration for orgs, roles, teams, invites and join requests

**Files:**
- Create: `supabase/migrations/20260930000000_orgs.sql`
- Test: `test/api-migration-orgs.test.js`

**Interfaces:**
- Consumes: the slug format from Task 1 (`^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 48 chars: 40 + a numeric suffix).
- Produces: tables `orgs`, `roles`, `org_members`, `teams`, `team_members`, `org_invites`, `join_requests` with the columns below; service-role-only functions `public.create_org(p_name text, p_slug text, p_owner uuid, p_owner_grants jsonb, p_admin_grants jsonb, p_member_grants jsonb) returns public.orgs` and `public.transfer_org(p_org uuid, p_to uuid) returns void`; RLS helper `public.my_org_ids()`. `org_members.user_id` and `join_requests.user_id` reference `public.profiles (id)` so PostgREST can embed `profiles (name)`.

- [ ] **Step 1: Write the failing test**

Create `test/api-migration-orgs.test.js`:

```js
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
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test test/api-migration-orgs.test.js`
Expected: FAIL with `ENOENT: no such file or directory` for the migration.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260930000000_orgs.sql`:

```sql
-- Quilt orgs: orgs, custom roles, members, flat teams, email invites and
-- domain join requests. Members read their own org's non-secret rows through
-- row-level security; every write goes through the accounts API (service role),
-- which checks the caller's permission grid.

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 48),
  -- No cascade: the API makes an owner transfer or delete their orgs before deleting their account.
  owner_id uuid not null references auth.users (id),
  domain text check (domain is null or domain = lower(domain)),
  domain_requests boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  builtin text check (builtin in ('owner', 'admin', 'member')),
  grants jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);
create unique index roles_one_builtin on public.roles (org_id, builtin) where builtin is not null;

create table public.org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- profiles(id) mirrors auth.users(id) and lets the API embed names.
  user_id uuid references public.profiles (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete cascade,
  -- No action (checked at the end of the statement), so deleting an org can
  -- cascade to both its members and its roles; the API refuses deleting a role in use.
  role_id uuid references public.roles (id),
  joined_at timestamptz not null default now(),
  check ((user_id is null) <> (agent_id is null)),
  check (user_id is null or role_id is not null),
  unique (org_id, user_id),
  unique (org_id, agent_id)
);
create index org_members_user_id on public.org_members (user_id);
create index org_members_role_id on public.org_members (role_id);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table public.team_members (
  team_id uuid not null references public.teams (id) on delete cascade,
  member_id uuid not null references public.org_members (id) on delete cascade,
  access text not null check (access in ('editor', 'viewer')),
  -- Folder limits, for agents (a later plan); the relay's scope rules allow up to 20.
  scopes text[] not null default '{}' check (cardinality(scopes) <= 20),
  added_at timestamptz not null default now(),
  primary key (team_id, member_id)
);
create index team_members_member_id on public.team_members (member_id);

create table public.org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  email text not null check (email = lower(email)),
  role_id uuid not null references public.roles (id) on delete cascade,
  token_hash text not null unique,
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
create index org_invites_org_id on public.org_invites (org_id);
create index org_invites_role_id on public.org_invites (role_id);

create table public.join_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- The confirmed address they asked with, so approvers can see who's asking.
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index join_requests_one_pending on public.join_requests (org_id, user_id) where status = 'pending';
create index join_requests_user_id on public.join_requests (user_id);

alter table public.orgs enable row level security;
alter table public.roles enable row level security;
alter table public.org_members enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.org_invites enable row level security;
alter table public.join_requests enable row level security;

-- The orgs the signed-in person belongs to. Security definer so the policy on
-- org_members can use it without recursing into itself.
create function public.my_org_ids () returns setof uuid
language sql stable security definer set search_path = '' as $$
  select org_id from public.org_members where user_id = (select auth.uid())
$$;

create policy "members read their orgs" on public.orgs for select to authenticated using (id in (select public.my_org_ids()));
create policy "members read their org's roles" on public.roles for select to authenticated using (org_id in (select public.my_org_ids()));
create policy "members read their org's members" on public.org_members for select to authenticated using (org_id in (select public.my_org_ids()));
create policy "members read their org's teams" on public.teams for select to authenticated using (org_id in (select public.my_org_ids()));
create policy "members read their org's team members" on public.team_members for select to authenticated
  using (team_id in (select id from public.teams where org_id in (select public.my_org_ids())));
create policy "own join requests: read" on public.join_requests for select to authenticated using ((select auth.uid()) = user_id);
-- org_invites has no client policy: only the API touches it.

-- Column privileges: reads only, and never token hashes.
revoke all on public.orgs, public.roles, public.org_members, public.teams, public.team_members, public.org_invites, public.join_requests from anon, authenticated;
grant select (id, name, slug, owner_id, domain, domain_requests, created_at) on public.orgs to authenticated;
grant select (id, org_id, name, builtin, grants, created_at) on public.roles to authenticated;
grant select (id, org_id, user_id, agent_id, role_id, joined_at) on public.org_members to authenticated;
grant select (id, org_id, name, created_at) on public.teams to authenticated;
grant select (team_id, member_id, access, scopes, added_at) on public.team_members to authenticated;
grant select (id, org_id, user_id, status, decided_at, created_at) on public.join_requests to authenticated;

-- The API is trusted with everything; don't depend on project default privileges.
grant all on public.orgs, public.roles, public.org_members, public.teams, public.team_members, public.org_invites, public.join_requests to service_role;

-- A new org with its three built-in roles and its owner, in one transaction.
-- The grids come from the API (src/api/permissions.js BUILTIN) so there's one source.
create function public.create_org (p_name text, p_slug text, p_owner uuid, p_owner_grants jsonb, p_admin_grants jsonb, p_member_grants jsonb)
returns public.orgs
language plpgsql security invoker set search_path = '' as $$
declare
  o public.orgs;
  owner_role uuid;
begin
  insert into public.orgs (name, slug, owner_id) values (p_name, p_slug, p_owner) returning * into o;
  insert into public.roles (org_id, name, builtin, grants) values (o.id, 'Owner', 'owner', p_owner_grants) returning id into owner_role;
  insert into public.roles (org_id, name, builtin, grants) values (o.id, 'Admin', 'admin', p_admin_grants), (o.id, 'Member', 'member', p_member_grants);
  insert into public.org_members (org_id, user_id, role_id) values (o.id, p_owner, owner_role);
  return o;
end $$;

-- Ownership moves in one step, so there is always exactly one owner: the old
-- owner becomes an Admin and the new one takes the Owner role.
create function public.transfer_org (p_org uuid, p_to uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  old_owner uuid;
begin
  select owner_id into old_owner from public.orgs where id = p_org for update;
  if not exists (select 1 from public.org_members where org_id = p_org and user_id = p_to) then
    raise exception 'not a member of this org';
  end if;
  update public.org_members set role_id = (select id from public.roles where org_id = p_org and builtin = 'admin')
    where org_id = p_org and user_id = old_owner;
  update public.org_members set role_id = (select id from public.roles where org_id = p_org and builtin = 'owner')
    where org_id = p_org and user_id = p_to;
  update public.orgs set owner_id = p_to where id = p_org;
end $$;

-- These aren't meant to be called over the API by anyone but the service role.
revoke execute on function public.create_org(text, text, uuid, jsonb, jsonb, jsonb), public.transfer_org(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_org(text, text, uuid, jsonb, jsonb, jsonb), public.transfer_org(uuid, uuid) to service_role;
revoke execute on function public.my_org_ids() from public, anon;
grant execute on function public.my_org_ids() to authenticated;
```

(No new trigger functions, so `20260929000001_lock_trigger_functions.sql` needs no companion.)

- [ ] **Step 4: Run to see it pass**

Run: `node --test test/api-migration-orgs.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260930000000_orgs.sql test/api-migration-orgs.test.js
git commit -m "Add the orgs migration: roles, members, teams, invites, join requests"
```

The migration is applied to the live project in Task 14.

---
### Task 3: Store — accounts' emails, orgs, roles and members

**Files:**
- Modify: `src/api/memory-store.js` (whole file below), `src/api/supabase-store.js`
- Test: `test/api-store-orgs.test.js`, `test/api-supabase-orgs.test.js`

**Interfaces:**
- Consumes: `BUILTIN` (Task 1) — passed in by callers as `grants: { owner, admin, member }`; the Task 2 tables and `create_org` / `transfer_org`.
- Produces (both stores; ids are uuids; timestamps epoch ms):
  - `addUser(userId, { name, email, confirmed = true })` (memory only, tests and `--memory`)
  - `userEmail(userId) -> { email, confirmed } | null`
  - `createOrg({ name, slug, ownerId, grants }) -> Org` where `Org = { id, name, slug, ownerId, domain, domainRequests, createdAt }`; makes roles Owner/Admin/Member (`builtin` 'owner'/'admin'/'member') and the owner's member row. Throws an error with `code: '23505'` on a taken slug.
  - `orgBySlug(slug) -> Org | null`, `orgById(id) -> Org | null`, `orgsForUser(userId) -> (Org & { roleId })[]` sorted by name, `orgsByDomain(domain) -> Org[]` (only `domainRequests` on), `updateOrg(id, { name?, domain?, domainRequests? }) -> Org`, `deleteOrg(id)`, `transferOrg(orgId, toUserId)`
  - `listRoles(orgId) -> Role[]` where `Role = { id, orgId, name, builtin, grants, createdAt }`, `roleById(orgId, id) -> Role | null`, `createRole({ orgId, name, grants }) -> Role` (23505 on a taken name), `updateRole(id, { name?, grants? }) -> Role`, `deleteRole(id)`, `roleInUse(id) -> boolean` (held by a member, or on an open invite)
  - `memberOf(orgId, userId) -> Member | null` where `Member = { id, orgId, userId, agentId, roleId, joinedAt }`, `memberById(orgId, id) -> Member | null`, `listMembers(orgId) -> (Member & { name })[]`, `addMember({ orgId, userId, roleId }) -> Member` (returns the existing row if already a member), `setMemberRole(id, roleId) -> Member`, `removeMember(id)` (also leaves the org's teams)
  - `deleteUser(userId)` now also drops the person's memberships and join requests (memory; Supabase cascades).

- [ ] **Step 1: Write the failing memory-store tests**

Create `test/api-store-orgs.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/api/memory-store.js'
import { BUILTIN } from '../src/api/permissions.js'

function setup () {
  const s = createMemoryStore()
  s.addUser('u1', { name: 'Dana', email: 'dana@acme.com' })
  s.addUser('u2', { name: 'Eli', email: 'eli@acme.com', confirmed: false })
  return s
}
const newOrg = (s, name = 'Acme', slug = 'acme', ownerId = 'u1') => s.createOrg({ name, slug, ownerId, grants: BUILTIN })

test('userEmail says whether the address is confirmed', async () => {
  const s = setup()
  assert.deepEqual(await s.userEmail('u1'), { email: 'dana@acme.com', confirmed: true })
  assert.deepEqual(await s.userEmail('u2'), { email: 'eli@acme.com', confirmed: false })
  assert.equal(await s.userEmail('nobody'), null)
})

test('creating an org makes the three built-in roles and the owner as a member', async () => {
  const s = setup()
  const org = await newOrg(s)
  assert.deepEqual([org.name, org.slug, org.ownerId, org.domain, org.domainRequests], ['Acme', 'acme', 'u1', null, false])
  const roles = await s.listRoles(org.id)
  assert.deepEqual(roles.map((r) => [r.name, r.builtin]).sort(), [['Admin', 'admin'], ['Member', 'member'], ['Owner', 'owner']])
  assert.deepEqual(roles.find((r) => r.builtin === 'member').grants, { teams: { r: true } })
  const me = await s.memberOf(org.id, 'u1')
  assert.equal(me.roleId, roles.find((r) => r.builtin === 'owner').id)
  await assert.rejects(newOrg(s, 'Other', 'acme'), (err) => err.code === '23505')
  assert.equal((await s.orgBySlug('acme')).id, org.id)
  assert.equal((await s.orgById(org.id)).slug, 'acme')
  assert.equal(await s.orgBySlug('nope'), null)
})

test('orgsForUser lists each org with the person\'s role, by name', async () => {
  const s = setup()
  const zeta = await newOrg(s, 'Zeta', 'zeta')
  const acme = await newOrg(s, 'Acme', 'acme')
  const list = await s.orgsForUser('u1')
  assert.deepEqual(list.map((o) => o.slug), ['acme', 'zeta'])
  assert.equal(list[1].id, zeta.id)
  assert.equal(list[0].roleId, (await s.memberOf(acme.id, 'u1')).roleId)
  assert.deepEqual(await s.orgsForUser('u2'), [])
})

test('updating an org, and finding orgs open to join requests by domain', async () => {
  const s = setup()
  const org = await newOrg(s)
  assert.equal((await s.updateOrg(org.id, { name: 'Acme Co', domain: 'acme.com' })).name, 'Acme Co')
  assert.deepEqual(await s.orgsByDomain('acme.com'), [], 'requests are off')
  await s.updateOrg(org.id, { domainRequests: true })
  assert.deepEqual((await s.orgsByDomain('acme.com')).map((o) => o.id), [org.id])
  assert.equal((await s.updateOrg(org.id, { domain: null })).domain, null)
})

test('transferring an org: the new owner takes Owner and the old owner becomes Admin', async () => {
  const s = setup()
  const org = await newOrg(s)
  const roles = await s.listRoles(org.id)
  const role = (b) => roles.find((r) => r.builtin === b).id
  await s.addMember({ orgId: org.id, userId: 'u2', roleId: role('member') })
  await s.transferOrg(org.id, 'u2')
  assert.equal((await s.orgById(org.id)).ownerId, 'u2')
  assert.equal((await s.memberOf(org.id, 'u2')).roleId, role('owner'))
  assert.equal((await s.memberOf(org.id, 'u1')).roleId, role('admin'))
})

test('roles: create, update, delete, and in-use checks', async () => {
  const s = setup()
  const org = await newOrg(s)
  const lead = await s.createRole({ orgId: org.id, name: 'Lead', grants: { teams: { c: true } } })
  assert.equal(lead.builtin, null)
  await assert.rejects(s.createRole({ orgId: org.id, name: 'Lead', grants: {} }), (err) => err.code === '23505')
  assert.deepEqual((await s.updateRole(lead.id, { grants: { teams: { r: true } } })).grants, { teams: { r: true } })
  assert.equal((await s.updateRole(lead.id, { name: 'Leads' })).name, 'Leads')
  assert.equal((await s.roleById(org.id, lead.id)).name, 'Leads')
  const other = await newOrg(s, 'Other', 'other')
  assert.equal(await s.roleById(other.id, lead.id), null, 'roles are scoped to their org')
  assert.equal(await s.roleInUse(lead.id), false)
  const m = await s.addMember({ orgId: org.id, userId: 'u2', roleId: lead.id })
  assert.equal(await s.roleInUse(lead.id), true)
  await s.setMemberRole(m.id, (await s.listRoles(org.id)).find((r) => r.builtin === 'member').id)
  assert.equal(await s.roleInUse(lead.id), false)
  await s.deleteRole(lead.id)
  assert.equal(await s.roleById(org.id, lead.id), null)
})

test('members: add once, list with names, change role, remove', async () => {
  const s = setup()
  const org = await newOrg(s)
  const memberRole = (await s.listRoles(org.id)).find((r) => r.builtin === 'member').id
  const a = await s.addMember({ orgId: org.id, userId: 'u2', roleId: memberRole })
  const again = await s.addMember({ orgId: org.id, userId: 'u2', roleId: memberRole })
  assert.equal(again.id, a.id)
  assert.deepEqual((await s.listMembers(org.id)).map((m) => m.name).sort(), ['Dana', 'Eli'])
  assert.equal((await s.memberById(org.id, a.id)).userId, 'u2')
  const other = await newOrg(s, 'Other', 'other')
  assert.equal(await s.memberById(other.id, a.id), null)
  await s.removeMember(a.id)
  assert.equal(await s.memberOf(org.id, 'u2'), null)
})

test('deleting an org removes its roles and members; deleting a person removes their memberships', async () => {
  const s = setup()
  const org = await newOrg(s)
  const other = await newOrg(s, 'Other', 'other', 'u2')
  await s.addMember({ orgId: other.id, userId: 'u1', roleId: (await s.listRoles(other.id)).find((r) => r.builtin === 'member').id })
  await s.deleteOrg(org.id)
  assert.equal(await s.orgById(org.id), null)
  assert.deepEqual(await s.listRoles(org.id), [])
  assert.deepEqual(await s.listMembers(org.id), [])
  await s.deleteUser('u1')
  assert.equal(await s.memberOf(other.id, 'u1'), null)
  assert.equal(await s.userEmail('u1'), null)
})
```

- [ ] **Step 2: Write the failing Supabase-store tests**

Create `test/api-supabase-orgs.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStore } from '../src/api/supabase-store.js'
import { BUILTIN } from '../src/api/permissions.js'

const ISO = '2026-09-30T00:00:00.000Z'
// A stand-in supabase client: records every query (a table or an rpc, plus the
// chain of calls on it) and answers each with answer(query).
function fakeDb (answer = () => null) {
  const calls = []
  const chain = (q) => new Proxy({}, {
    get (_, op) {
      if (op === 'then') return (res, rej) => Promise.resolve({ data: answer(q), error: null }).then(res, rej)
      return (...args) => { q.ops.push([op, ...args]); return chain(q) }
    }
  })
  const users = {
    u1: { id: 'u1', email: 'dana@acme.com', email_confirmed_at: ISO },
    u2: { id: 'u2', email: 'eli@acme.com', email_confirmed_at: null }
  }
  const client = {
    from (table) { const q = { table, ops: [] }; calls.push(q); return chain(q) },
    rpc (fn, args) { const q = { rpc: fn, args, ops: [] }; calls.push(q); return chain(q) },
    auth: {
      admin: {
        getUserById: async (id) => users[id]
          ? { data: { user: users[id] }, error: null }
          : { data: { user: null }, error: { status: 404, message: 'User not found' } }
      }
    }
  }
  return { client, calls }
}
const has = (q, ...call) => q.ops.some((c) => JSON.stringify(c) === JSON.stringify(call))
const orgRow = (id, name) => ({ id, name, slug: name.toLowerCase(), owner_id: 'u1', domain: null, domain_requests: false, created_at: ISO })

test('supabase userEmail reads the auth user; unknown people are null', async () => {
  const s = createSupabaseStore({ client: fakeDb().client })
  assert.deepEqual(await s.userEmail('u1'), { email: 'dana@acme.com', confirmed: true })
  assert.deepEqual(await s.userEmail('u2'), { email: 'eli@acme.com', confirmed: false })
  assert.equal(await s.userEmail('u3'), null)
})

test('supabase createOrg and transferOrg go through the one-transaction functions', async () => {
  const { client, calls } = fakeDb((q) => (q.rpc === 'create_org' ? orgRow('o1', 'Acme') : null))
  const s = createSupabaseStore({ client })
  const org = await s.createOrg({ name: 'Acme', slug: 'acme', ownerId: 'u1', grants: BUILTIN })
  assert.deepEqual(calls[0].args, { p_name: 'Acme', p_slug: 'acme', p_owner: 'u1', p_owner_grants: BUILTIN.owner, p_admin_grants: BUILTIN.admin, p_member_grants: BUILTIN.member })
  assert.deepEqual([org.id, org.ownerId, org.domainRequests, org.createdAt], ['o1', 'u1', false, Date.parse(ISO)])
  await s.transferOrg('o1', 'u2')
  assert.deepEqual([calls[1].rpc, calls[1].args], ['transfer_org', { p_org: 'o1', p_to: 'u2' }])
})

test('supabase orgsForUser flattens the embedded org and sorts by name', async () => {
  const { client, calls } = fakeDb(() => [{ role_id: 'r2', orgs: orgRow('o2', 'Zeta') }, { role_id: 'r1', orgs: orgRow('o1', 'Acme') }])
  const s = createSupabaseStore({ client })
  const list = await s.orgsForUser('u1')
  assert.deepEqual(list.map((o) => [o.name, o.roleId]), [['Acme', 'r1'], ['Zeta', 'r2']])
  assert.ok(has(calls[0], 'eq', 'user_id', 'u1'))
})

test('supabase listMembers flattens the embedded profile name', async () => {
  const { client } = fakeDb(() => [{ id: 'm1', org_id: 'o1', user_id: 'u1', agent_id: null, role_id: 'r1', joined_at: ISO, profiles: { name: 'Dana' } }])
  const [m] = await createSupabaseStore({ client }).listMembers('o1')
  assert.deepEqual([m.id, m.userId, m.name, m.joinedAt, 'profiles' in m], ['m1', 'u1', 'Dana', Date.parse(ISO), false])
})

test('supabase addMember returns the existing row when the person is already in', async () => {
  const row = { id: 'm1', org_id: 'o1', user_id: 'u2', agent_id: null, role_id: 'r1', joined_at: ISO }
  const { client, calls } = fakeDb((q) => (q.ops.some(([op]) => op === 'upsert') ? null : row))
  const m = await createSupabaseStore({ client }).addMember({ orgId: 'o1', userId: 'u2', roleId: 'r1' })
  assert.equal(m.id, 'm1')
  const upsert = calls[0].ops.find(([op]) => op === 'upsert')
  assert.deepEqual(upsert[2], { onConflict: 'org_id,user_id', ignoreDuplicates: true })
})

test('supabase roleInUse counts members, then open invites only', async () => {
  const { client, calls } = fakeDb((q) => (q.table === 'org_invites' ? [{ id: 'i1' }] : []))
  assert.equal(await createSupabaseStore({ client }).roleInUse('r1'), true)
  const invites = calls.find((q) => q.table === 'org_invites')
  assert.ok(has(invites, 'is', 'accepted_at', null) && has(invites, 'is', 'cancelled_at', null))
})
```

- [ ] **Step 3: Run to see them fail**

Run: `node --test test/api-store-orgs.test.js test/api-supabase-orgs.test.js`
Expected: FAIL (`s.userEmail is not a function`, `s.createOrg is not a function`, …).

- [ ] **Step 4: Implement the memory store**

Replace `src/api/memory-store.js` with:

```js
// The accounts API's data, in memory. Used by tests and `quilt api --memory`;
// production uses supabase-store.js, which has the same methods.
import crypto from 'node:crypto'

const uuid = () => crypto.randomUUID()
const pick = (o, drop) => Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k)))
const copy = (o) => (o ? structuredClone(o) : null)
// Postgres's unique-violation code, which the API turns into a 409.
const duplicate = (what) => Object.assign(new Error(`${what} already exists`), { code: '23505' })

export function createMemoryStore ({ now = Date.now } = {}) {
  const links = new Map(); const devices = new Map(); const profiles = new Map(); const agents = new Map()
  const users = new Map(); const orgs = new Map(); const roles = new Map(); const members = new Map()
  const teams = new Map(); const teamMembers = new Map(); const invites = new Map(); const requests = new Map()
  const all = (m, keep) => [...m.values()].filter(keep)
  const nameOf = (userId) => profiles.get(userId)?.name || ''
  const findMember = (orgId, userId) => all(members, (m) => m.orgId === orgId && m.userId === userId)[0]
  // Leaving an org also leaves its teams, like the cascade in Postgres.
  const dropMember = (id) => {
    members.delete(id)
    for (const [k, tm] of teamMembers) if (tm.memberId === id) teamMembers.delete(k)
  }

  return {
    addUser (userId, { name = '', email = '', confirmed = true } = {}) {
      profiles.set(userId, { id: userId, name: name || email.split('@')[0] || 'You', color: null, tool: null })
      users.set(userId, { email, confirmed })
    },
    async createLink (l) {
      const row = { id: uuid(), status: 'pending', userId: null, deviceId: null, createdAt: now(), ...l }
      links.set(row.id, row); return { ...row }
    },
    async linkByDeviceCode (h) { const l = [...links.values()].find((x) => x.deviceCodeHash === h); return l ? { ...l } : null },
    async linkByUserCode (c) { const l = [...links.values()].find((x) => x.userCode === c); return l ? { ...l } : null },
    async updateLink (id, patch) { const l = links.get(id); Object.assign(l, patch); return { ...l } },
    // Check-and-set: only flips status if it's still fromStatus, so two concurrent
    // callers can't both win the same link (e.g. handing out a device token twice).
    async claimLink (id, fromStatus, toStatus) {
      const l = links.get(id)
      if (!l || l.status !== fromStatus) return false
      l.status = toStatus
      return true
    },
    // One row per (account, key): someone else approving a link for this key gets
    // their own row, never this one. A relink retires the old token.
    async upsertDevice ({ userId, name, platform, publicKey }) {
      let d = [...devices.values()].find((x) => x.userId === userId && x.publicKey === publicKey)
      if (d) Object.assign(d, { name, platform, tokenHash: null, revokedAt: null })
      else devices.set((d = { id: uuid(), userId, name, platform, publicKey, tokenHash: null, createdAt: now(), lastSeenAt: now(), revokedAt: null }).id, d)
      return { ...d }
    },
    async setDeviceToken (id, tokenHash) { devices.get(id).tokenHash = tokenHash },
    async deviceByToken (h) { const d = [...devices.values()].find((x) => x.tokenHash === h && !x.revokedAt); return d ? { ...d } : null },
    async touchDevice (id) { devices.get(id).lastSeenAt = now() },
    async revokeDevice (id) { Object.assign(devices.get(id), { revokedAt: now(), tokenHash: null }) },
    async profile (userId) { const p = profiles.get(userId); return p ? { ...p } : null },
    async updateProfile (userId, patch) {
      const p = profiles.get(userId)
      for (const k of ['name', 'color', 'tool']) if (patch[k] !== undefined) p[k] = patch[k]
      return { ...p }
    },
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

    // The address a person signs in with, and whether they've confirmed it.
    async userEmail (userId) { const u = users.get(userId); return u ? { ...u } : null },

    // Orgs. Creating one makes its three built-in roles and its owner together.
    async createOrg ({ name, slug, ownerId, grants }) {
      if (all(orgs, (o) => o.slug === slug).length) throw duplicate('org')
      const org = { id: uuid(), name, slug, ownerId, domain: null, domainRequests: false, createdAt: now() }
      orgs.set(org.id, org)
      let ownerRole
      for (const [builtin, roleName] of [['owner', 'Owner'], ['admin', 'Admin'], ['member', 'Member']]) {
        const r = { id: uuid(), orgId: org.id, name: roleName, builtin, grants: copy(grants[builtin]), createdAt: now() }
        roles.set(r.id, r)
        if (builtin === 'owner') ownerRole = r
      }
      const m = { id: uuid(), orgId: org.id, userId: ownerId, agentId: null, roleId: ownerRole.id, joinedAt: now() }
      members.set(m.id, m)
      return copy(org)
    },
    async orgBySlug (slug) { return copy(all(orgs, (o) => o.slug === slug)[0]) },
    async orgById (id) { return copy(orgs.get(id)) },
    async orgsForUser (userId) {
      return all(members, (m) => m.userId === userId)
        .map((m) => ({ ...copy(orgs.get(m.orgId)), roleId: m.roleId }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    async orgsByDomain (domain) { return all(orgs, (o) => o.domain === domain && o.domainRequests).map(copy) },
    async updateOrg (id, patch) {
      const o = orgs.get(id)
      for (const k of ['name', 'domain', 'domainRequests']) if (patch[k] !== undefined) o[k] = patch[k]
      return copy(o)
    },
    async deleteOrg (id) {
      orgs.delete(id)
      for (const [k, m] of members) if (m.orgId === id) dropMember(k)
      for (const [k, t] of teams) if (t.orgId === id) teams.delete(k)
      for (const [k, r] of roles) if (r.orgId === id) roles.delete(k)
      for (const [k, i] of invites) if (i.orgId === id) invites.delete(k)
      for (const [k, r] of requests) if (r.orgId === id) requests.delete(k)
    },
    // Ownership moves in one step: the old owner becomes an Admin.
    async transferOrg (orgId, toUserId) {
      const o = orgs.get(orgId)
      const to = findMember(orgId, toUserId)
      if (!to) throw new Error('not a member of this org')
      const builtin = (b) => all(roles, (r) => r.orgId === orgId && r.builtin === b)[0]
      findMember(orgId, o.ownerId).roleId = builtin('admin').id
      to.roleId = builtin('owner').id
      o.ownerId = toUserId
    },

    // Roles.
    async listRoles (orgId) { return all(roles, (r) => r.orgId === orgId).map(copy) },
    async roleById (orgId, id) { const r = roles.get(id); return r && r.orgId === orgId ? copy(r) : null },
    async createRole ({ orgId, name, grants }) {
      if (all(roles, (r) => r.orgId === orgId && r.name === name).length) throw duplicate('role')
      const r = { id: uuid(), orgId, name, builtin: null, grants: copy(grants), createdAt: now() }
      roles.set(r.id, r); return copy(r)
    },
    async updateRole (id, { name, grants }) {
      const r = roles.get(id)
      if (name !== undefined && all(roles, (x) => x.orgId === r.orgId && x.name === name && x.id !== id).length) throw duplicate('role')
      if (name !== undefined) r.name = name
      if (grants !== undefined) r.grants = copy(grants)
      return copy(r)
    },
    // A deleted role's invites go with it, like the cascade in Postgres.
    async deleteRole (id) {
      roles.delete(id)
      for (const [k, i] of invites) if (i.roleId === id) invites.delete(k)
    },
    // In use: someone holds it, or an open invite would hand it out.
    async roleInUse (id) {
      return all(members, (m) => m.roleId === id).length > 0 ||
        all(invites, (i) => i.roleId === id && !i.acceptedAt && !i.cancelledAt).length > 0
    },

    // Members.
    async memberOf (orgId, userId) { return copy(findMember(orgId, userId)) },
    async memberById (orgId, id) { const m = members.get(id); return m && m.orgId === orgId ? copy(m) : null },
    async listMembers (orgId) { return all(members, (m) => m.orgId === orgId).map((m) => ({ ...copy(m), name: nameOf(m.userId) })) },
    async addMember ({ orgId, userId, roleId }) {
      const existing = findMember(orgId, userId)
      if (existing) return copy(existing)
      const m = { id: uuid(), orgId, userId, agentId: null, roleId, joinedAt: now() }
      members.set(m.id, m); return copy(m)
    },
    async setMemberRole (id, roleId) { const m = members.get(id); m.roleId = roleId; return copy(m) },
    async removeMember (id) { dropMember(id) }
  }
}
```

- [ ] **Step 5: Implement the Supabase store**

In `src/api/supabase-store.js`, add below `const SAFE_AGENT = …`:

```js
// Named columns for the org tables, so a select never picks up a secret by accident.
const ORG = 'id, name, slug, owner_id, domain, domain_requests, created_at'
const ROLE = 'id, org_id, name, builtin, grants, created_at'
const MEMBER = 'id, org_id, user_id, agent_id, role_id, joined_at'
```

Inside `createSupabaseStore`, just before `return {`, add:

```js
  const memberOf = async (orgId, userId) => rowFrom(await one(db.from('org_members').select(MEMBER).eq('org_id', orgId).eq('user_id', userId).maybeSingle()))
```

and inside the returned object, after `deleteUser`, add (put a comma after `deleteUser`'s closing brace):

```js
    // The address a person signs in with, and whether they've confirmed it.
    async userEmail (userId) {
      const { data, error } = await db.auth.admin.getUserById(userId)
      if (error) { if (error.status === 404) return null; throw error }
      const u = data?.user
      return u ? { email: u.email || '', confirmed: !!u.email_confirmed_at } : null
    },

    // Orgs. create_org makes the org, its three built-in roles and its owner in one transaction.
    async createOrg ({ name, slug, ownerId, grants }) {
      return rowFrom(await one(db.rpc('create_org', {
        p_name: name, p_slug: slug, p_owner: ownerId, p_owner_grants: grants.owner, p_admin_grants: grants.admin, p_member_grants: grants.member
      })))
    },
    async orgBySlug (slug) { return rowFrom(await one(db.from('orgs').select(ORG).eq('slug', slug).maybeSingle())) },
    async orgById (id) { return rowFrom(await one(db.from('orgs').select(ORG).eq('id', id).maybeSingle())) },
    async orgsForUser (userId) {
      const rows = await one(db.from('org_members').select(`role_id, orgs (${ORG})`).eq('user_id', userId))
      return rows.map((r) => ({ ...rowFrom(r.orgs), roleId: r.role_id })).sort((a, b) => a.name.localeCompare(b.name))
    },
    async orgsByDomain (domain) { return (await one(db.from('orgs').select(ORG).eq('domain', domain).eq('domain_requests', true))).map(rowFrom) },
    async updateOrg (id, { name, domain, domainRequests }) {
      return rowFrom(await one(db.from('orgs').update(toSnake({ name, domain, domainRequests })).eq('id', id).select(ORG).single()))
    },
    // Cascades to roles, members, teams, invites and requests.
    async deleteOrg (id) { await one(db.from('orgs').delete().eq('id', id)) },
    async transferOrg (orgId, toUserId) { await one(db.rpc('transfer_org', { p_org: orgId, p_to: toUserId })) },

    // Roles.
    async listRoles (orgId) { return (await one(db.from('roles').select(ROLE).eq('org_id', orgId))).map(rowFrom) },
    async roleById (orgId, id) { return rowFrom(await one(db.from('roles').select(ROLE).eq('org_id', orgId).eq('id', id).maybeSingle())) },
    async createRole ({ orgId, name, grants }) {
      return rowFrom(await one(db.from('roles').insert({ org_id: orgId, name, grants }).select(ROLE).single()))
    },
    async updateRole (id, { name, grants }) {
      return rowFrom(await one(db.from('roles').update(toSnake({ name, grants })).eq('id', id).select(ROLE).single()))
    },
    async deleteRole (id) { await one(db.from('roles').delete().eq('id', id)) },
    // In use: someone holds it, or an open invite would hand it out.
    async roleInUse (id) {
      if ((await one(db.from('org_members').select('id').eq('role_id', id).limit(1))).length) return true
      return (await one(db.from('org_invites').select('id').eq('role_id', id).is('accepted_at', null).is('cancelled_at', null).limit(1))).length > 0
    },

    // Members.
    memberOf,
    async memberById (orgId, id) { return rowFrom(await one(db.from('org_members').select(MEMBER).eq('org_id', orgId).eq('id', id).maybeSingle())) },
    async listMembers (orgId) {
      const rows = await one(db.from('org_members').select(`${MEMBER}, profiles (name)`).eq('org_id', orgId).order('joined_at'))
      return rows.map(({ profiles, ...r }) => ({ ...rowFrom(r), name: profiles?.name || '' }))
    },
    // Already a member: the upsert does nothing and we return the existing row.
    async addMember ({ orgId, userId, roleId }) {
      const row = await one(db.from('org_members')
        .upsert({ org_id: orgId, user_id: userId, role_id: roleId }, { onConflict: 'org_id,user_id', ignoreDuplicates: true })
        .select(MEMBER).maybeSingle())
      return row ? rowFrom(row) : memberOf(orgId, userId)
    },
    async setMemberRole (id, roleId) { return rowFrom(await one(db.from('org_members').update({ role_id: roleId }).eq('id', id).select(MEMBER).single())) },
    // Cascades to the member's team memberships.
    async removeMember (id) { await one(db.from('org_members').delete().eq('id', id)) }
```

`deleteUser` is unchanged: deleting the auth user cascades through `profiles` to `org_members` and `join_requests`.

- [ ] **Step 6: Run to see them pass, then the whole suite**

Run: `node --test test/api-store-orgs.test.js test/api-supabase-orgs.test.js && npm test`
Expected: PASS, `# fail 0` (the existing store and API tests still pass).

- [ ] **Step 7: Commit**

```bash
git add src/api/memory-store.js src/api/supabase-store.js test/api-store-orgs.test.js test/api-supabase-orgs.test.js
git commit -m "Store orgs, roles and members in memory and in Supabase"
```

---

### Task 4: Store — teams, invites and join requests

**Files:**
- Modify: `src/api/memory-store.js`, `src/api/supabase-store.js`
- Test: `test/api-store-orgs.test.js`, `test/api-supabase-orgs.test.js`

**Interfaces:**
- Consumes: the Task 3 stores (the memory store's `teams`, `teamMembers`, `invites`, `requests` maps, `all`, `copy`, `duplicate`, `nameOf`, `uuid`, `now`; the Supabase store's `one`, `rowFrom`, `toSnake`, `ts`).
- Produces (both stores):
  - `listTeams(orgId) -> Team[]` by name, `Team = { id, orgId, name, createdAt }`; `teamById(orgId, id) -> Team | null`; `createTeam({ orgId, name }) -> Team` (23505 on a taken name); `renameTeam(id, name) -> Team` (23505); `deleteTeam(id)`
  - `listTeamMembers(teamId) -> { teamId, memberId, access, scopes, addedAt, name }[]`; `teamsOfMember(memberId) -> { teamId, access }[]`; `addTeamMember({ teamId, memberId, access }) -> TeamMember` (upsert); `setTeamAccess(teamId, memberId, access) -> TeamMember | null`; `removeTeamMember(teamId, memberId) -> boolean`
  - `createInvite({ orgId, email, roleId, tokenHash, invitedBy, expiresAt }) -> Invite`, `Invite = { id, orgId, email, roleId, tokenHash, invitedBy, expiresAt, acceptedAt, cancelledAt, createdAt }`; `inviteByToken(hash) -> Invite | null`; `inviteById(orgId, id) -> Invite | null`; `listInvites(orgId) -> Invite[]` (not accepted, not cancelled); `updateInvite(id, { tokenHash?, expiresAt?, cancelledAt? }) -> Invite`; `claimInvite(id) -> boolean` (sets `acceptedAt` once, never on a cancelled invite)
  - `createJoinRequest({ orgId, userId, email }) -> JoinRequest` (returns the pending one if it exists), `JoinRequest = { id, orgId, userId, email, status, decidedBy, decidedAt, createdAt }`; `joinRequestById(orgId, id)`; `listJoinRequests(orgId) -> (JoinRequest & { name })[]` (pending only); `joinRequestsForUser(userId) -> JoinRequest[]`; `decideJoinRequest(id, { status, decidedBy }) -> boolean` (only from pending)

- [ ] **Step 1: Write the failing tests**

Append to `test/api-store-orgs.test.js`:

```js
test('teams: unique names per org, membership with access, and cleanup', async () => {
  const s = setup()
  const org = await newOrg(s)
  const web = await s.createTeam({ orgId: org.id, name: 'Web' })
  const api = await s.createTeam({ orgId: org.id, name: 'API' })
  await assert.rejects(s.createTeam({ orgId: org.id, name: 'Web' }), (err) => err.code === '23505')
  await assert.rejects(s.renameTeam(api.id, 'Web'), (err) => err.code === '23505')
  assert.deepEqual((await s.listTeams(org.id)).map((t) => t.name), ['API', 'Web'])
  assert.equal((await s.renameTeam(api.id, 'Platform')).name, 'Platform')
  const other = await newOrg(s, 'Other', 'other')
  assert.equal(await s.teamById(other.id, web.id), null)
  const dana = await s.memberOf(org.id, 'u1')
  await s.addTeamMember({ teamId: web.id, memberId: dana.id, access: 'viewer' })
  await s.addTeamMember({ teamId: web.id, memberId: dana.id, access: 'editor' })
  assert.deepEqual((await s.listTeamMembers(web.id)).map((m) => [m.name, m.access, m.scopes]), [['Dana', 'editor', []]])
  assert.deepEqual(await s.teamsOfMember(dana.id), [{ teamId: web.id, access: 'editor' }])
  assert.equal((await s.setTeamAccess(web.id, dana.id, 'viewer')).access, 'viewer')
  assert.equal(await s.setTeamAccess(api.id, dana.id, 'viewer'), null)
  assert.equal(await s.removeTeamMember(web.id, dana.id), true)
  assert.equal(await s.removeTeamMember(web.id, dana.id), false)
  await s.addTeamMember({ teamId: web.id, memberId: dana.id, access: 'editor' })
  await s.removeMember(dana.id)
  assert.deepEqual(await s.listTeamMembers(web.id), [], 'leaving the org leaves its teams')
  await s.deleteTeam(web.id)
  assert.equal(await s.teamById(org.id, web.id), null)
})

test('invites: stored by hash, listed while open, claimed once, never after cancelling', async () => {
  const s = setup()
  const org = await newOrg(s)
  const memberRole = (await s.listRoles(org.id)).find((r) => r.builtin === 'member').id
  const i = await s.createInvite({ orgId: org.id, email: 'new@acme.com', roleId: memberRole, tokenHash: 'h1', invitedBy: 'u1', expiresAt: Date.now() + 1000 })
  assert.deepEqual([i.acceptedAt, i.cancelledAt], [null, null])
  assert.equal((await s.inviteByToken('h1')).id, i.id)
  assert.equal((await s.inviteById(org.id, i.id)).email, 'new@acme.com')
  assert.equal(await s.roleInUse(memberRole), true, 'an open invite holds its role')
  assert.equal((await s.updateInvite(i.id, { tokenHash: 'h2' })).tokenHash, 'h2')
  assert.equal(await s.inviteByToken('h1'), null)
  assert.equal(await s.claimInvite(i.id), true)
  assert.equal(await s.claimInvite(i.id), false)
  assert.deepEqual(await s.listInvites(org.id), [])
  const j = await s.createInvite({ orgId: org.id, email: 'x@acme.com', roleId: memberRole, tokenHash: 'h3', invitedBy: 'u1', expiresAt: Date.now() + 1000 })
  assert.deepEqual((await s.listInvites(org.id)).map((x) => x.id), [j.id])
  await s.updateInvite(j.id, { cancelledAt: Date.now() })
  assert.equal(await s.claimInvite(j.id), false)
})

test('join requests: one pending per person per org, decided once', async () => {
  const s = setup()
  const org = await newOrg(s)
  const r = await s.createJoinRequest({ orgId: org.id, userId: 'u2', email: 'eli@acme.com' })
  assert.equal(r.status, 'pending')
  assert.equal((await s.createJoinRequest({ orgId: org.id, userId: 'u2', email: 'eli@acme.com' })).id, r.id)
  assert.deepEqual((await s.listJoinRequests(org.id)).map((x) => [x.name, x.email]), [['Eli', 'eli@acme.com']])
  assert.equal((await s.joinRequestById(org.id, r.id)).userId, 'u2')
  assert.equal(await s.decideJoinRequest(r.id, { status: 'denied', decidedBy: 'u1' }), true)
  assert.equal(await s.decideJoinRequest(r.id, { status: 'approved', decidedBy: 'u1' }), false)
  assert.deepEqual(await s.listJoinRequests(org.id), [])
  assert.deepEqual((await s.joinRequestsForUser('u2')).map((x) => x.status), ['denied'])
  assert.notEqual((await s.createJoinRequest({ orgId: org.id, userId: 'u2', email: 'eli@acme.com' })).id, r.id, 'can ask again after a decision')
})
```

Append to `test/api-supabase-orgs.test.js`:

```js
test('supabase claimInvite only claims an open invite', async () => {
  const { client, calls } = fakeDb(() => [{ id: 'i1' }])
  assert.equal(await createSupabaseStore({ client }).claimInvite('i1'), true)
  assert.ok(has(calls[0], 'is', 'accepted_at', null) && has(calls[0], 'is', 'cancelled_at', null))
  const none = fakeDb(() => [])
  assert.equal(await createSupabaseStore({ client: none.client }).claimInvite('i1'), false)
})

test('supabase createInvite sends timestamps as ISO strings', async () => {
  const { client, calls } = fakeDb(() => ({ id: 'i1', expires_at: ISO }))
  const i = await createSupabaseStore({ client }).createInvite({ orgId: 'o1', email: 'a@acme.com', roleId: 'r1', tokenHash: 'h', invitedBy: 'u1', expiresAt: Date.parse(ISO) })
  const insert = calls[0].ops.find(([op]) => op === 'insert')[1]
  assert.deepEqual(insert, { org_id: 'o1', email: 'a@acme.com', role_id: 'r1', token_hash: 'h', invited_by: 'u1', expires_at: ISO })
  assert.equal(i.expiresAt, Date.parse(ISO))
})

test('supabase decideJoinRequest only decides a pending request', async () => {
  const { client, calls } = fakeDb(() => [{ id: 'j1' }])
  assert.equal(await createSupabaseStore({ client }).decideJoinRequest('j1', { status: 'approved', decidedBy: 'u1' }), true)
  assert.ok(has(calls[0], 'eq', 'status', 'pending'))
  const update = calls[0].ops.find(([op]) => op === 'update')[1]
  assert.deepEqual([update.status, update.decided_by], ['approved', 'u1'])
})

test('supabase listTeamMembers flattens the nested member name; addTeamMember upserts', async () => {
  const { client, calls } = fakeDb((q) => (q.ops.some(([op]) => op === 'upsert')
    ? { team_id: 't1', member_id: 'm1', access: 'editor', scopes: [], added_at: ISO }
    : [{ team_id: 't1', member_id: 'm1', access: 'viewer', scopes: [], added_at: ISO, org_members: { user_id: 'u1', profiles: { name: 'Dana' } } }]))
  const s = createSupabaseStore({ client })
  const [m] = await s.listTeamMembers('t1')
  assert.deepEqual([m.memberId, m.access, m.name, 'orgMembers' in m], ['m1', 'viewer', 'Dana', false])
  await s.addTeamMember({ teamId: 't1', memberId: 'm1', access: 'editor' })
  assert.deepEqual(calls[1].ops.find(([op]) => op === 'upsert')[2], { onConflict: 'team_id,member_id' })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test test/api-store-orgs.test.js test/api-supabase-orgs.test.js`
Expected: the new tests FAIL (`s.createTeam is not a function`, `s.claimInvite is not a function`, …).

- [ ] **Step 3: Implement the memory store**

In `src/api/memory-store.js`, add a comma after `async removeMember (id) { dropMember(id) }` and then add:

```js

    // Teams.
    async listTeams (orgId) { return all(teams, (t) => t.orgId === orgId).sort((a, b) => a.name.localeCompare(b.name)).map(copy) },
    async teamById (orgId, id) { const t = teams.get(id); return t && t.orgId === orgId ? copy(t) : null },
    async createTeam ({ orgId, name }) {
      if (all(teams, (t) => t.orgId === orgId && t.name === name).length) throw duplicate('team')
      const t = { id: uuid(), orgId, name, createdAt: now() }
      teams.set(t.id, t); return copy(t)
    },
    async renameTeam (id, name) {
      const t = teams.get(id)
      if (all(teams, (x) => x.orgId === t.orgId && x.name === name && x.id !== id).length) throw duplicate('team')
      t.name = name; return copy(t)
    },
    async deleteTeam (id) {
      teams.delete(id)
      for (const [k, tm] of teamMembers) if (tm.teamId === id) teamMembers.delete(k)
    },
    async listTeamMembers (teamId) {
      return all(teamMembers, (tm) => tm.teamId === teamId).map((tm) => ({ ...copy(tm), name: nameOf(members.get(tm.memberId)?.userId) }))
    },
    async teamsOfMember (memberId) {
      return all(teamMembers, (tm) => tm.memberId === memberId).map((tm) => ({ teamId: tm.teamId, access: tm.access }))
    },
    async addTeamMember ({ teamId, memberId, access }) {
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
    async removeTeamMember (teamId, memberId) { return teamMembers.delete(`${teamId}:${memberId}`) },

    // Invites: only the token's hash is kept.
    async createInvite (i) {
      const row = { id: uuid(), acceptedAt: null, cancelledAt: null, createdAt: now(), ...i }
      invites.set(row.id, row); return copy(row)
    },
    async inviteByToken (h) { return copy(all(invites, (i) => i.tokenHash === h)[0]) },
    async inviteById (orgId, id) { const i = invites.get(id); return i && i.orgId === orgId ? copy(i) : null },
    async listInvites (orgId) { return all(invites, (i) => i.orgId === orgId && !i.acceptedAt && !i.cancelledAt).map(copy) },
    async updateInvite (id, patch) { const i = invites.get(id); Object.assign(i, patch); return copy(i) },
    // Check-and-set, so one invite can't be accepted twice (or after it was cancelled).
    async claimInvite (id) {
      const i = invites.get(id)
      if (!i || i.acceptedAt || i.cancelledAt) return false
      i.acceptedAt = now(); return true
    },

    // Domain join requests: at most one pending per person per org.
    async createJoinRequest ({ orgId, userId, email }) {
      const pending = all(requests, (r) => r.orgId === orgId && r.userId === userId && r.status === 'pending')[0]
      if (pending) return copy(pending)
      const r = { id: uuid(), orgId, userId, email, status: 'pending', decidedBy: null, decidedAt: null, createdAt: now() }
      requests.set(r.id, r); return copy(r)
    },
    async joinRequestById (orgId, id) { const r = requests.get(id); return r && r.orgId === orgId ? copy(r) : null },
    async listJoinRequests (orgId) {
      return all(requests, (r) => r.orgId === orgId && r.status === 'pending').map((r) => ({ ...copy(r), name: nameOf(r.userId) }))
    },
    async joinRequestsForUser (userId) { return all(requests, (r) => r.userId === userId).map(copy) },
    // Check-and-set: a request is decided once.
    async decideJoinRequest (id, { status, decidedBy }) {
      const r = requests.get(id)
      if (!r || r.status !== 'pending') return false
      Object.assign(r, { status, decidedBy, decidedAt: now() }); return true
    }
```

- [ ] **Step 4: Implement the Supabase store**

In `src/api/supabase-store.js`, add below the `MEMBER` constant:

```js
const TEAM = 'id, org_id, name, created_at'
const TEAM_MEMBER = 'team_id, member_id, access, scopes, added_at'
const INVITE = 'id, org_id, email, role_id, token_hash, invited_by, expires_at, accepted_at, cancelled_at, created_at'
const REQUEST = 'id, org_id, user_id, email, status, decided_by, decided_at, created_at'
```

Inside the returned object, add a comma after `removeMember`'s closing brace and then:

```js

    // Teams.
    async listTeams (orgId) { return (await one(db.from('teams').select(TEAM).eq('org_id', orgId).order('name'))).map(rowFrom) },
    async teamById (orgId, id) { return rowFrom(await one(db.from('teams').select(TEAM).eq('org_id', orgId).eq('id', id).maybeSingle())) },
    async createTeam ({ orgId, name }) { return rowFrom(await one(db.from('teams').insert({ org_id: orgId, name }).select(TEAM).single())) },
    async renameTeam (id, name) { return rowFrom(await one(db.from('teams').update({ name }).eq('id', id).select(TEAM).single())) },
    async deleteTeam (id) { await one(db.from('teams').delete().eq('id', id)) },
    async listTeamMembers (teamId) {
      const rows = await one(db.from('team_members').select(`${TEAM_MEMBER}, org_members (user_id, profiles (name))`).eq('team_id', teamId).order('added_at'))
      return rows.map(({ org_members: m, ...r }) => ({ ...rowFrom(r), name: m?.profiles?.name || '' }))
    },
    async teamsOfMember (memberId) {
      return (await one(db.from('team_members').select('team_id, access').eq('member_id', memberId))).map((r) => ({ teamId: r.team_id, access: r.access }))
    },
    async addTeamMember ({ teamId, memberId, access }) {
      return rowFrom(await one(db.from('team_members').upsert({ team_id: teamId, member_id: memberId, access }, { onConflict: 'team_id,member_id' }).select(TEAM_MEMBER).single()))
    },
    async setTeamAccess (teamId, memberId, access) {
      return rowFrom(await one(db.from('team_members').update({ access }).eq('team_id', teamId).eq('member_id', memberId).select(TEAM_MEMBER).maybeSingle()))
    },
    async removeTeamMember (teamId, memberId) {
      return (await one(db.from('team_members').delete().eq('team_id', teamId).eq('member_id', memberId).select('team_id'))).length > 0
    },

    // Invites: only the token's hash is stored.
    async createInvite (i) {
      return rowFrom(await one(db.from('org_invites').insert(toSnake({ ...i, expiresAt: ts(i.expiresAt) })).select(INVITE).single()))
    },
    async inviteByToken (h) { return rowFrom(await one(db.from('org_invites').select(INVITE).eq('token_hash', h).maybeSingle())) },
    async inviteById (orgId, id) { return rowFrom(await one(db.from('org_invites').select(INVITE).eq('org_id', orgId).eq('id', id).maybeSingle())) },
    async listInvites (orgId) {
      return (await one(db.from('org_invites').select(INVITE).eq('org_id', orgId).is('accepted_at', null).is('cancelled_at', null).order('created_at'))).map(rowFrom)
    },
    async updateInvite (id, patch) {
      return rowFrom(await one(db.from('org_invites').update(toSnake({ ...patch, expiresAt: ts(patch.expiresAt), cancelledAt: ts(patch.cancelledAt) })).eq('id', id).select(INVITE).single()))
    },
    // Check-and-set, so one invite can't be accepted twice (or after it was cancelled).
    async claimInvite (id) {
      const rows = await one(db.from('org_invites').update({ accepted_at: new Date().toISOString() }).eq('id', id).is('accepted_at', null).is('cancelled_at', null).select('id'))
      return rows.length > 0
    },

    // Domain join requests: the partial unique index keeps one pending per person per org.
    async createJoinRequest ({ orgId, userId, email }) {
      const pending = await one(db.from('join_requests').select(REQUEST).eq('org_id', orgId).eq('user_id', userId).eq('status', 'pending').maybeSingle())
      if (pending) return rowFrom(pending)
      return rowFrom(await one(db.from('join_requests').insert({ org_id: orgId, user_id: userId, email }).select(REQUEST).single()))
    },
    async joinRequestById (orgId, id) { return rowFrom(await one(db.from('join_requests').select(REQUEST).eq('org_id', orgId).eq('id', id).maybeSingle())) },
    async listJoinRequests (orgId) {
      const rows = await one(db.from('join_requests').select(`${REQUEST}, profiles (name)`).eq('org_id', orgId).eq('status', 'pending').order('created_at'))
      return rows.map(({ profiles, ...r }) => ({ ...rowFrom(r), name: profiles?.name || '' }))
    },
    async joinRequestsForUser (userId) { return (await one(db.from('join_requests').select(REQUEST).eq('user_id', userId))).map(rowFrom) },
    // Check-and-set: a request is decided once.
    async decideJoinRequest (id, { status, decidedBy }) {
      const rows = await one(db.from('join_requests').update({ status, decided_by: decidedBy, decided_at: new Date().toISOString() }).eq('id', id).eq('status', 'pending').select('id'))
      return rows.length > 0
    }
```

- [ ] **Step 5: Run to see them pass, then the whole suite**

Run: `node --test test/api-store-orgs.test.js test/api-supabase-orgs.test.js && npm test`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/api/memory-store.js src/api/supabase-store.js test/api-store-orgs.test.js test/api-supabase-orgs.test.js
git commit -m "Store teams, invites and join requests"
```

---
### Task 5: API — orgs, settings, ownership and roles

**Files:**
- Create: `src/api/http.js`, `src/api/org-access.js`, `src/api/routes/orgs.js`, `test/api-helpers.js`
- Modify: `src/api/server.js`
- Test: `test/api-orgs.test.js`

**Interfaces:**
- Consumes: Task 1 (`BUILTIN`, `can`, `isSubset`, `normalizeGrants`, `emailDomain`, `isDomain`, `isPublicDomain`, `uniqueSlug`); Task 3 store methods.
- Produces:
  - `src/api/http.js`: `class HttpError(status, message)`, `UUID`, `needId(id, what) -> string` (404 unless a uuid), `cleanName(value, max, message) -> string` (trimmed, control characters removed, 400 if empty).
  - `src/api/org-access.js`: `orgAccess(store, userId, slug) -> Access` where `Access = { org, me, role, isOwner, grants, can(resource, op), covers(grants), need(resource, op), needOwner(), assignable(roleId?) -> Role }`; non-members get 404.
  - `startApi({ …, mailer, inviteLimit = 10 })`; route modules export `(ctx) => routes[]` with `ctx = { store, user, now, site, mailer, log, limit }` (`limit(req)` is the per-address limiter for invite/join routes). Any store error with `code: '23505'` becomes `409 { error: 'that name is already taken' }`.
  - Routes (all need a website user's JWT):
    - `GET /v1/orgs` → `{ orgs: [{ id, name, slug, domain, domainRequests, createdAt, isOwner, role }] }`
    - `POST /v1/orgs { name }` → `{ org }` (caller becomes Owner)
    - `GET /v1/orgs/:slug/me` → `{ org: { id, name, slug, domain, domainRequests, createdAt, ownerId }, role: { id, name, builtin } | null, grants, isOwner, memberId }`
    - `PUT /v1/orgs/:slug { name?, domain?, domainRequests? }` (Org settings: Update; domain rule) → `{ org }`
    - `DELETE /v1/orgs/:slug` (Owner) → `{ ok: true }`; `POST /v1/orgs/:slug/transfer { memberId }` (Owner) → `{ ok: true }`
    - `GET /v1/orgs/:slug/roles` (Roles: Read, or Members: Update, or User invites: Create) → `{ roles: [{ id, name, builtin, grants, createdAt }] }` ordered Owner, Admin, Member, then by name
    - `POST /v1/orgs/:slug/roles { name, grants }` (Roles: Create + subset) → `{ role }`; `PUT /v1/orgs/:slug/roles/:id { name?, grants? }` (Roles: Update + subset; never Owner; built-ins keep their names) → `{ role }`; `DELETE /v1/orgs/:slug/roles/:id` (Roles: Delete; not built-ins; 409 while in use) → `{ ok: true }`
    - `DELETE /v1/me/account` now answers 409 while the person owns an org.
  - `test/api-helpers.js`: `SITE`, `startTestApi(opts) -> { api, store, sent, call(method, path, body, userId, headers), close }` with users `owner` (olive@acme.com), `admin` (ada@acme.com), `mem` (mo@acme.com), `lim` (lin@acme.com), `out` (otto@else.com), `gm` (gee@gmail.com), `unconf` (una@acme.com, unconfirmed); `makeOrg(t, name) -> { slug, org, role(builtin), owner, admin, mem }`.

- [ ] **Step 1: Write the test helpers**

Create `test/api-helpers.js` (not a `*.test.js`, so `npm test` doesn't run it on its own):

```js
// Shared setup for the org API tests: an API over a fresh memory store, a fake
// mailer that keeps what it sends, and a cast of people.
import { startApi } from '../src/api/server.js'
import { createMemoryStore } from '../src/api/memory-store.js'

export const SITE = 'https://quilt.test'
// A bearer "user:<id>" stands in for a website user's JWT.
const verifyUser = async (t) => (t && t.startsWith('user:') ? { userId: t.slice(5), email: '' } : null)

const CAST = [
  ['owner', 'Olive', 'olive@acme.com'], ['admin', 'Ada', 'ada@acme.com'], ['mem', 'Mo', 'mo@acme.com'],
  ['lim', 'Lin', 'lin@acme.com'], ['out', 'Otto', 'otto@else.com'], ['gm', 'Gee', 'gee@gmail.com'],
  ['unconf', 'Una', 'una@acme.com', false]
]

export async function startTestApi (opts = {}) {
  const store = createMemoryStore()
  for (const [id, name, email, confirmed = true] of CAST) store.addUser(id, { name, email, confirmed })
  const sent = []
  const mailer = { send: async (m) => { sent.push(m) } }
  const api = await startApi({ store, verifyUser, siteUrl: SITE, agentKeySecret: 'test-secret', startLimit: 1000, inviteLimit: 1000, mailer, ...opts })
  const call = async (method, path, body, userId, headers = {}) => {
    const res = await fetch(api.url + path, {
      method,
      headers: { 'content-type': 'application/json', ...(userId ? { authorization: `Bearer user:${userId}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  return { api, store, sent, call, close: () => api.close() }
}

/** An org owned by "owner", with "admin" as Admin and "mem" as Member. */
export async function makeOrg (t, name = 'Acme') {
  const { body } = await t.call('POST', '/v1/orgs', { name }, 'owner')
  const org = await t.store.orgBySlug(body.org.slug)
  const roles = await t.store.listRoles(org.id)
  const role = (b) => roles.find((r) => r.builtin === b)
  const admin = await t.store.addMember({ orgId: org.id, userId: 'admin', roleId: role('admin').id })
  const mem = await t.store.addMember({ orgId: org.id, userId: 'mem', roleId: role('member').id })
  const owner = await t.store.memberOf(org.id, 'owner')
  return { slug: org.slug, org, role, owner, admin, mem }
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/api-orgs.test.js`:

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg } from './api-helpers.js'
import { BUILTIN } from '../src/api/permissions.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())

test('creating an org makes you its owner, with a slug from the name', async () => {
  const a = await t.call('POST', '/v1/orgs', { name: 'Acme Rockets' }, 'owner')
  assert.equal(a.status, 200)
  assert.equal(a.body.org.slug, 'acme-rockets')
  assert.equal((await t.call('POST', '/v1/orgs', { name: 'Acme Rockets' }, 'owner')).body.org.slug, 'acme-rockets-2')
  const list = await t.call('GET', '/v1/orgs', null, 'owner')
  const mine = list.body.orgs.find((o) => o.slug === 'acme-rockets')
  assert.deepEqual([mine.isOwner, mine.role], [true, 'Owner'])
  const me = await t.call('GET', '/v1/orgs/acme-rockets/me', null, 'owner')
  assert.deepEqual([me.body.isOwner, me.body.role.builtin, me.body.org.name], [true, 'owner', 'Acme Rockets'])
  assert.deepEqual(me.body.grants, BUILTIN.owner)
  assert.equal(typeof me.body.memberId, 'string')
  assert.equal((await t.call('GET', '/v1/orgs/ACME-ROCKETS/me', null, 'owner')).status, 200, 'slugs are case-insensitive')
  assert.equal((await t.call('POST', '/v1/orgs', { name: '   ' }, 'owner')).status, 400)
  assert.equal((await t.call('POST', '/v1/orgs', { name: 'X' })).status, 401)
})

test('people outside an org get a 404 for it, the same as a missing org', async () => {
  const o = await makeOrg(t)
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'out')).status, 404)
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}`, { name: 'Mine' }, 'out')).status, 404)
  assert.equal((await t.call('GET', '/v1/orgs/no-such-org/me', null, 'out')).status, 404)
})

test('a Member sees their grants and cannot change settings; an Admin can', async () => {
  const o = await makeOrg(t)
  const me = await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'mem')
  assert.deepEqual([me.body.isOwner, me.body.role.name, me.body.grants], [false, 'Member', { teams: { r: true } }])
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}`, { name: 'Nope' }, 'mem')).status, 403)
  const ok = await t.call('PUT', `/v1/orgs/${o.slug}`, { name: 'Acme Two' }, 'admin')
  assert.deepEqual([ok.status, ok.body.org.name, ok.body.org.slug], [200, 'Acme Two', o.slug], 'renaming keeps the address')
})

test('the org domain must be your own confirmed email domain, and never a public one', async () => {
  const o = await makeOrg(t)
  const put = (who, body, slug = o.slug) => t.call('PUT', `/v1/orgs/${slug}`, body, who)
  assert.equal((await put('owner', { domainRequests: true })).status, 400, 'no domain yet')
  const set = await put('owner', { domain: 'ACME.com' })
  assert.deepEqual([set.status, set.body.org.domain], [200, 'acme.com'])
  assert.equal((await put('owner', { domain: 'else.com' })).status, 403, 'not your email domain')
  assert.equal((await put('owner', { domain: 'not a domain' })).status, 400)
  assert.equal((await put('owner', { domainRequests: true })).body.org.domainRequests, true)
  // Someone else with Org settings: Update can save other changes without re-proving the domain.
  await t.store.addMember({ orgId: o.org.id, userId: 'out', roleId: o.role('admin').id })
  assert.equal((await put('out', { name: 'Acme Three', domain: 'acme.com' })).status, 200)
  const off = await put('owner', { domain: null })
  assert.deepEqual([off.body.org.domain, off.body.org.domainRequests], [null, false], 'no domain, no requests')
  const g = (await t.call('POST', '/v1/orgs', { name: 'Gee Co' }, 'gm')).body.org
  assert.equal((await put('gm', { domain: 'gmail.com' }, g.slug)).status, 400, 'public mail domain')
  const u = (await t.call('POST', '/v1/orgs', { name: 'Una Co' }, 'unconf')).body.org
  assert.equal((await put('unconf', { domain: 'acme.com' }, u.slug)).status, 403, 'unconfirmed email')
})

test('only the owner transfers or deletes the org, and there is always exactly one owner', async () => {
  const o = await makeOrg(t)
  const transfer = (who, memberId) => t.call('POST', `/v1/orgs/${o.slug}/transfer`, { memberId }, who)
  assert.equal((await transfer('admin', o.mem.id)).status, 403)
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}`, null, 'admin')).status, 403)
  assert.equal((await transfer('owner', o.owner.id)).status, 400, 'you already own it')
  assert.equal((await transfer('owner', 'not-a-uuid')).status, 404)
  assert.equal((await transfer('owner', o.admin.id)).status, 200)
  const now = await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'admin')
  assert.deepEqual([now.body.isOwner, now.body.role.builtin], [true, 'owner'])
  const before = await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'owner')
  assert.deepEqual([before.body.isOwner, before.body.role.builtin], [false, 'admin'])
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}`, null, 'owner')).status, 403)
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}`, null, 'admin')).status, 200)
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'admin')).status, 404)
})

test('roles: listing is ordered, and people who hand out roles can list them', async () => {
  const o = await makeOrg(t)
  await t.store.createRole({ orgId: o.org.id, name: 'Zed', grants: {} })
  await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: {} })
  const r = await t.call('GET', `/v1/orgs/${o.slug}/roles`, null, 'admin')
  assert.deepEqual(r.body.roles.map((x) => x.name), ['Owner', 'Admin', 'Member', 'Lead', 'Zed'])
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/roles`, null, 'mem')).status, 403)
  const inviter = await t.store.createRole({ orgId: o.org.id, name: 'Inviter', grants: { invites: { c: true } } })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: inviter.id })
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/roles`, null, 'lim')).status, 200)
})

test('roles: you can only create a role within your own permissions', async () => {
  const o = await makeOrg(t)
  const made = await t.call('POST', `/v1/orgs/${o.slug}/roles`, { name: 'Lead', grants: { teams: { c: true, r: 'on' }, org: { c: true }, bogus: { r: true } } }, 'admin')
  assert.equal(made.status, 200)
  assert.deepEqual([made.body.role.name, made.body.role.builtin, made.body.role.grants], ['Lead', null, { teams: { c: true, r: true } }])
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/roles`, { name: 'Lead', grants: {} }, 'admin')).status, 409)
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/roles`, { name: 'X', grants: {} }, 'mem')).status, 403)
  const maker = await t.store.createRole({ orgId: o.org.id, name: 'Maker', grants: { roles: { c: true, r: true }, teams: { r: true } } })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: maker.id })
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/roles`, { name: 'Remover', grants: { members: { d: true } } }, 'lim')).status, 403)
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/roles`, { name: 'Reader', grants: { teams: { r: true } } }, 'lim')).status, 200)
})

test('roles: Owner is fixed, built-ins keep their names, and assigned roles are not deleted', async () => {
  const o = await makeOrg(t)
  const put = (id, body, who = 'admin') => t.call('PUT', `/v1/orgs/${o.slug}/roles/${id}`, body, who)
  const del = (id, who = 'admin') => t.call('DELETE', `/v1/orgs/${o.slug}/roles/${id}`, null, who)
  assert.equal((await put(o.role('owner').id, { grants: {} })).status, 403)
  assert.equal((await put(o.role('admin').id, { name: 'Boss' })).status, 400)
  assert.equal((await put(o.role('admin').id, { name: 'Admin' })).status, 200, 'the same name is fine')
  const edited = await put(o.role('member').id, { grants: { teams: { r: true, c: true } } })
  assert.deepEqual(edited.body.role.grants, { teams: { r: true, c: true } })
  assert.equal((await del(o.role('member').id)).status, 400, 'built-ins stay')
  const used = await t.store.createRole({ orgId: o.org.id, name: 'Used', grants: {} })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: used.id })
  assert.equal((await del(used.id)).status, 409)
  const spare = await t.store.createRole({ orgId: o.org.id, name: 'Spare', grants: {} })
  assert.equal((await del(spare.id, 'mem')).status, 403)
  assert.equal((await del(spare.id)).status, 200)
  assert.equal((await del(spare.id)).status, 404)
  assert.equal((await put('not-a-uuid', { grants: {} })).status, 404)
})

test('roles: nobody edits a role with checkboxes they do not have', async () => {
  const o = await makeOrg(t)
  const editor = await t.store.createRole({ orgId: o.org.id, name: 'Editor', grants: { roles: { r: true, u: true } } })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: editor.id })
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/roles/${o.role('admin').id}`, { grants: {} }, 'lim')).status, 403)
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/roles/${editor.id}`, { grants: { roles: { r: true, u: true, d: true } } }, 'lim')).status, 403)
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/roles/${editor.id}`, { grants: { roles: { r: true } } }, 'lim')).status, 200, 'giving up checkboxes is fine')
})

test('an org owner must transfer or delete their orgs before deleting their account', async () => {
  const other = await startTestApi()
  try {
    await other.call('POST', '/v1/orgs', { name: 'Keep' }, 'owner')
    assert.equal((await other.call('DELETE', '/v1/me/account', null, 'owner')).status, 409)
    assert.equal((await other.call('DELETE', '/v1/me/account', null, 'out')).status, 200)
  } finally { await other.close() }
})
```

- [ ] **Step 3: Run to see them fail**

Run: `node --test test/api-orgs.test.js`
Expected: FAIL — the org routes are missing (`404 not found`), and `startApi` doesn't know `inviteLimit`/`mailer` yet.

- [ ] **Step 4: Add `src/api/http.js` and `src/api/org-access.js`**

Create `src/api/http.js`:

```js
// Small pieces every API route module shares.
export class HttpError extends Error { constructor (status, message) { super(message); this.status = status } }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ids are uuids; anything else can't exist (and Postgres would reject it), so it's a 404. */
export function needId (id, what = 'thing') {
  if (!UUID.test(String(id || ''))) throw new HttpError(404, `no such ${what}`)
  return String(id)
}

/** A trimmed name with no control characters (it may end up in an email subject). */
export function cleanName (value, max, message) {
  const s = Array.from(String(value ?? ''), (ch) => (ch < ' ' || ch === '\u007f' ? ' ' : ch)).join('').trim().slice(0, max).trim()
  if (!s) throw new HttpError(400, message)
  return s
}
```

Create `src/api/org-access.js`:

```js
// The caller's place in one org, and the checks every org route makes with it.
import { HttpError, needId } from './http.js'
import { BUILTIN, can, isSubset, normalizeGrants } from './permissions.js'

export async function orgAccess (store, userId, slug) {
  const org = await store.orgBySlug(String(slug || '').toLowerCase())
  const me = org && await store.memberOf(org.id, userId)
  // Non-members get the same answer as a missing org, so org addresses can't be probed.
  if (!me) throw new HttpError(404, 'no such org')
  const isOwner = org.ownerId === userId
  const role = me.roleId ? await store.roleById(org.id, me.roleId) : null
  const grants = isOwner ? BUILTIN.owner : normalizeGrants(role?.grants)
  const allowed = (resource, op) => isOwner || can(grants, resource, op)
  // No self-promotion: a role you make, edit or hand out holds nothing you don't.
  const covers = (g) => isOwner || isSubset(g, grants)
  return {
    org,
    me,
    role,
    isOwner,
    grants,
    can: allowed,
    covers,
    need (resource, op) { if (!allowed(resource, op)) throw new HttpError(403, "your role doesn't allow that") },
    needOwner () { if (!isOwner) throw new HttpError(403, 'only the owner can do that') },
    /** A role this caller may give someone: in this org, never Owner, within their own grid. Defaults to Member. */
    async assignable (roleId) {
      const r = roleId
        ? await store.roleById(org.id, needId(roleId, 'role'))
        : (await store.listRoles(org.id)).find((x) => x.builtin === 'member')
      if (!r) throw new HttpError(404, 'no such role')
      if (r.builtin === 'owner') throw new HttpError(403, 'ownership only moves by transfer')
      if (!covers(r.grants)) throw new HttpError(403, 'you can only give roles within your own permissions')
      return r
    }
  }
}
```

- [ ] **Step 5: Add the org routes**

Create `src/api/routes/orgs.js`:

```js
// Orgs: creating one, its settings and domain rule, ownership, and its roles.
import { HttpError, needId, cleanName } from '../http.js'
import { orgAccess } from '../org-access.js'
import { BUILTIN, normalizeGrants } from '../permissions.js'
import { emailDomain, isDomain, isPublicDomain } from '../domains.js'
import { uniqueSlug } from '../slugs.js'

const ROLE_ORDER = { owner: 0, admin: 1, member: 2 }
const sortRoles = (roles) => [...roles].sort((a, b) => (ROLE_ORDER[a.builtin] ?? 3) - (ROLE_ORDER[b.builtin] ?? 3) || a.name.localeCompare(b.name))
const orgView = (o) => ({ id: o.id, name: o.name, slug: o.slug, domain: o.domain, domainRequests: o.domainRequests, createdAt: o.createdAt })
const roleView = (r) => ({ id: r.id, name: r.name, builtin: r.builtin, grants: normalizeGrants(r.grants), createdAt: r.createdAt })

export function orgRoutes ({ store, user }) {
  const orgFor = async (req, slug) => { const u = await user(req); return { u, ...(await orgAccess(store, u.userId, slug)) } }

  // Two orgs made at once can pick the same slug; the unique index decides and we try the next.
  async function createOrg (name, ownerId) {
    for (let attempt = 0; ; attempt++) {
      const slug = await uniqueSlug(name, async (s) => !!await store.orgBySlug(s))
      try {
        return await store.createOrg({ name, slug, ownerId, grants: BUILTIN })
      } catch (err) {
        if (err?.code !== '23505' || attempt >= 2) throw err
      }
    }
  }

  // Only a domain the caller has proved they get mail at, and never a public provider's.
  async function ownDomain (userId, domain) {
    if (!isDomain(domain)) throw new HttpError(400, "that isn't a domain")
    if (isPublicDomain(domain)) throw new HttpError(400, "public email domains can't be used")
    const mine = await store.userEmail(userId)
    if (!mine?.confirmed || emailDomain(mine.email) !== domain) throw new HttpError(403, 'you can only use the domain of your own confirmed email')
    return domain
  }

  async function roleIn (a, id) {
    const role = await store.roleById(a.org.id, needId(id, 'role'))
    if (!role) throw new HttpError(404, 'no such role')
    return role
  }

  return [
    ['GET', /^\/v1\/orgs$/, async (req) => {
      const u = await user(req)
      const orgs = await store.orgsForUser(u.userId)
      return {
        orgs: await Promise.all(orgs.map(async (o) => ({
          ...orgView(o), isOwner: o.ownerId === u.userId, role: (await store.roleById(o.id, o.roleId))?.name || null
        })))
      }
    }],

    ['POST', /^\/v1\/orgs$/, async (req, body) => {
      const u = await user(req)
      return { org: orgView(await createOrg(cleanName(body.name, 80, 'give the org a name'), u.userId)) }
    }],

    ['GET', /^\/v1\/orgs\/([^/]+)\/me$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      return {
        org: { ...orgView(a.org), ownerId: a.org.ownerId },
        role: a.role && { id: a.role.id, name: a.role.name, builtin: a.role.builtin },
        grants: a.grants,
        isOwner: a.isOwner,
        memberId: a.me.id
      }
    }],

    ['PUT', /^\/v1\/orgs\/([^/]+)$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('org', 'u')
      const patch = {}
      if (body.name !== undefined) patch.name = cleanName(body.name, 80, 'give the org a name')
      if (body.domain !== undefined) {
        const d = body.domain == null ? '' : String(body.domain).trim().toLowerCase().replace(/\.$/, '')
        // Re-saving the current domain (say, alongside a rename) doesn't need re-proving.
        patch.domain = !d ? null : d === a.org.domain ? d : await ownDomain(a.u.userId, d)
      }
      if (body.domainRequests !== undefined) patch.domainRequests = body.domainRequests === true
      if (!Object.keys(patch).length) return { org: orgView(a.org) }
      const domain = 'domain' in patch ? patch.domain : a.org.domain
      if (patch.domainRequests && !domain) throw new HttpError(400, 'set a domain first')
      if (!domain) patch.domainRequests = false
      return { org: orgView(await store.updateOrg(a.org.id, patch)) }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.needOwner()
      await store.deleteOrg(a.org.id)
      return { ok: true }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/transfer$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.needOwner()
      const to = await store.memberById(a.org.id, needId(body.memberId, 'member'))
      if (!to?.userId) throw new HttpError(404, 'no such member')
      if (to.userId === a.u.userId) throw new HttpError(400, 'you already own this org')
      await store.transferOrg(a.org.id, to.userId)
      return { ok: true }
    }],

    ['GET', /^\/v1\/orgs\/([^/]+)\/roles$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      // People who hand out roles (changing members, inviting) need the list to pick from.
      if (!a.can('members', 'u') && !a.can('invites', 'c')) a.need('roles', 'r')
      return { roles: sortRoles(await store.listRoles(a.org.id)).map(roleView) }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/roles$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('roles', 'c')
      const grants = normalizeGrants(body.grants)
      if (!a.covers(grants)) throw new HttpError(403, 'a role can only have permissions you have')
      return { role: roleView(await store.createRole({ orgId: a.org.id, name: cleanName(body.name, 40, 'give the role a name'), grants })) }
    }],

    ['PUT', /^\/v1\/orgs\/([^/]+)\/roles\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('roles', 'u')
      const role = await roleIn(a, id)
      if (role.builtin === 'owner') throw new HttpError(403, "the Owner role can't be edited")
      if (!a.covers(role.grants)) throw new HttpError(403, "this role has permissions you don't have")
      const patch = {}
      if (body.name !== undefined) {
        const name = cleanName(body.name, 40, 'give the role a name')
        if (role.builtin && name !== role.name) throw new HttpError(400, 'built-in roles keep their names')
        patch.name = name
      }
      if (body.grants !== undefined) {
        patch.grants = normalizeGrants(body.grants)
        if (!a.covers(patch.grants)) throw new HttpError(403, 'a role can only have permissions you have')
      }
      if (!Object.keys(patch).length) return { role: roleView(role) }
      return { role: roleView(await store.updateRole(role.id, patch)) }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)\/roles\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('roles', 'd')
      const role = await roleIn(a, id)
      if (role.builtin) throw new HttpError(400, "built-in roles can't be deleted")
      if (!a.covers(role.grants)) throw new HttpError(403, "this role has permissions you don't have")
      if (await store.roleInUse(role.id)) throw new HttpError(409, 'this role is still assigned; move its people to another role first')
      await store.deleteRole(role.id)
      return { ok: true }
    }]
  ]
}
```

- [ ] **Step 6: Wire it into the server**

In `src/api/server.js`:

1. Replace the line `class HttpError extends Error { constructor (status, message) { super(message); this.status = status } }` and the line `const UUID = /^[0-9a-f]{8}-…$/i` (delete both), and add to the imports:

```js
import { HttpError, UUID } from './http.js'
import { orgRoutes } from './routes/orgs.js'
```

2. Change the `startApi` signature to:

```js
export function startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, siteUrl, agentKeySecret, mailer = { send: async () => { throw new Error('no mailer configured') } }, now = Date.now, log = () => {}, startLimit = 10, inviteLimit = 10, trustProxy = false, maxStartKeys = 10_000 }) {
```

3. Replace the whole block from `// A few link requests per minute per address is plenty for a person.` through the closing `}` of `function limitStarts (req) { … }` with:

```js
  // A few tries per minute per address is plenty for a person. Behind Fly,
  // Fly-Client-IP is the real peer; X-Forwarded-For isn't used because Fly appends
  // to whatever the client sent, so its first entry is client-controlled.
  function makeLimiter (limit, message) {
    const hits = new Map()
    const check = (req) => {
      const ip = (trustProxy && String(req.headers['fly-client-ip'] || '').trim()) || req.socket.remoteAddress
      const recent = (hits.get(ip) || []).filter((t) => now() - t < 60_000)
      if (recent.length >= limit) throw new HttpError(429, message)
      hits.set(ip, [...recent, now()])
      // Keep the map bounded: forget addresses with nothing in the last minute.
      if (hits.size > maxStartKeys) for (const [k, ts] of hits) if (ts.every((t) => now() - t >= 60_000)) hits.delete(k)
    }
    check.size = () => hits.size
    return check
  }
  const limitStarts = makeLimiter(startLimit, 'too many sign-in attempts; try again in a minute')
  const limitInvites = makeLimiter(inviteLimit, 'too many tries; wait a minute and try again')
```

4. In the `DELETE /v1/me/account` route, before `await store.deleteUser(u.userId)`, add:

```js
      // Every org keeps exactly one owner, so an owner hands it on (or deletes it) first.
      if ((await store.orgsForUser(u.userId)).some((o) => o.ownerId === u.userId)) throw new HttpError(409, 'you own an org; transfer it or delete it first')
```

5. Directly after the closing `]` of `const routes = [ … ]`, add:

```js

  // Org routes live in their own modules and share the caller check and the limiter.
  const ctx = { store, user, now, site, mailer, log, limit: limitInvites }
  routes.push(...orgRoutes(ctx))
```

6. In the request handler's `catch (err) {`, add as the first line:

```js
      // A unique index said no (a taken team or role name): the caller can fix that.
      if (err?.code === '23505') return send(409, { error: 'that name is already taken' })
```

7. In the object passed to `resolve(…)` at the bottom, change `startKeys: () => starts.size` to `startKeys: () => limitStarts.size()`.

- [ ] **Step 7: Run to see them pass, then the whole suite**

Run: `node --test test/api-orgs.test.js && npm test`
Expected: PASS, `# fail 0` (including the existing limiter tests in `test/api.test.js`).

- [ ] **Step 8: Commit**

```bash
git add src/api/http.js src/api/org-access.js src/api/routes/orgs.js src/api/server.js test/api-helpers.js test/api-orgs.test.js
git commit -m "Add org, settings, ownership and role routes to the accounts API"
```

---

### Task 6: API — members and teams

**Files:**
- Create: `src/api/routes/members.js`, `src/api/routes/teams.js`
- Modify: `src/api/server.js`
- Test: `test/api-teams.test.js`

**Interfaces:**
- Consumes: `orgAccess` / `Access` (Task 5), `HttpError`, `needId`, `cleanName` (Task 5), Task 3–4 store methods, `test/api-helpers.js`.
- Produces:
  - `GET /v1/orgs/:slug/members` (Members: Read) → `{ members: [{ id, userId, name, email, roleId, role, isOwner, isYou, joinedAt, teams: [{ id, name, access }] }] }` (`teams` filled only for callers with Team membership: Read)
  - `PUT /v1/orgs/:slug/members/:id { roleId }` (Members: Update + Roles: Update; not yourself; not the owner; the member's current role and the new role must be within your grid; never Owner) → `{ member: { id, roleId } }`
  - `DELETE /v1/orgs/:slug/members/:id` (Members: Delete for others; anyone may remove themselves; never the owner) → `{ ok: true }`
  - `GET /v1/orgs/:slug/teams` → `{ teams: [{ id, name, createdAt, access: 'editor'|'viewer'|null, members: [{ memberId, name, access }] | null }], people: [{ memberId, name }] | null }` — all teams with Teams: Read, else only your own; `members` for your own teams or with Team membership: Read; `people` (to add from) with Team membership: Create
  - `POST /v1/orgs/:slug/teams { name }` (Teams: Create) → `{ team }`; `PUT /v1/orgs/:slug/teams/:id { name }` (Teams: Update) → `{ team }`; `DELETE /v1/orgs/:slug/teams/:id` (Teams: Delete) → `{ ok: true }`
  - `POST /v1/orgs/:slug/teams/:id/members { memberId, access }` (Team membership: Create; `access` defaults to `viewer`) → `{ member: { memberId, access } }`; `PUT …/members/:memberId { access }` (Update) → `{ member }`; `DELETE …/members/:memberId` (Delete) → `{ ok: true }`

- [ ] **Step 1: Write the failing tests**

Create `test/api-teams.test.js`:

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg } from './api-helpers.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())

test('the member list shows names, emails, roles and teams to people with Members: Read', async () => {
  const o = await makeOrg(t, 'List Co')
  const core = await t.store.createTeam({ orgId: o.org.id, name: 'Core' })
  await t.store.addTeamMember({ teamId: core.id, memberId: o.mem.id, access: 'editor' })
  const r = await t.call('GET', `/v1/orgs/${o.slug}/members`, null, 'admin')
  assert.equal(r.status, 200)
  const mo = r.body.members.find((m) => m.userId === 'mem')
  assert.deepEqual([mo.name, mo.email, mo.role, mo.isOwner, mo.isYou], ['Mo', 'mo@acme.com', 'Member', false, false])
  assert.deepEqual(mo.teams, [{ id: core.id, name: 'Core', access: 'editor' }])
  assert.equal(r.body.members.find((m) => m.userId === 'owner').isOwner, true)
  assert.equal(r.body.members.find((m) => m.userId === 'admin').isYou, true)
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/members`, null, 'mem')).status, 403)
})

test('changing roles: Members and Roles Update, never your own, never the owner, only within your grid', async () => {
  const o = await makeOrg(t, 'Roles Co')
  const lead = await t.store.createRole({ orgId: o.org.id, name: 'Lead', grants: { members: { r: true, u: true }, roles: { r: true, u: true }, teams: { r: true } } })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: lead.id })
  const put = (who, id, roleId) => t.call('PUT', `/v1/orgs/${o.slug}/members/${id}`, { roleId }, who)
  const ok = await put('admin', o.mem.id, lead.id)
  assert.deepEqual([ok.status, ok.body.member.roleId], [200, lead.id])
  assert.equal((await put('admin', o.mem.id, o.role('member').id)).status, 200)
  assert.equal((await put('admin', o.admin.id, o.role('member').id)).status, 403, 'not your own role')
  assert.equal((await put('admin', o.owner.id, o.role('member').id)).status, 403, 'not the owner')
  assert.equal((await put('admin', o.mem.id, o.role('owner').id)).status, 403, 'nobody is given Owner')
  assert.equal((await put('lim', o.mem.id, o.role('admin').id)).status, 403, 'Admin holds more than Lead')
  assert.equal((await put('lim', o.admin.id, o.role('member').id)).status, 403, 'the admin outranks Lead')
  assert.equal((await put('lim', o.mem.id, lead.id)).status, 200, 'Lead can hand out Lead')
  assert.equal((await put('admin', 'not-a-uuid', o.role('member').id)).status, 404)
  assert.equal((await put('admin', o.mem.id, 'not-a-uuid')).status, 404)
})

test('removing people needs Members: Delete; anyone but the owner may leave', async () => {
  const o = await makeOrg(t, 'Leave Co')
  const del = (who, id) => t.call('DELETE', `/v1/orgs/${o.slug}/members/${id}`, null, who)
  assert.equal((await del('mem', o.admin.id)).status, 403)
  assert.equal((await del('admin', o.owner.id)).status, 403)
  assert.equal((await del('owner', o.owner.id)).status, 403, 'the owner transfers first')
  assert.equal((await del('mem', o.mem.id)).status, 200, 'leaving')
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'mem')).status, 404)
  assert.equal((await del('owner', o.admin.id)).status, 200)
  assert.equal((await del('owner', o.admin.id)).status, 404)
})

test('teams: create, rename and delete need the Teams checkboxes; names are unique in an org', async () => {
  const o = await makeOrg(t, 'Team Co')
  const made = await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Core' }, 'admin')
  assert.deepEqual([made.status, made.body.team.name], [200, 'Core'])
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Core' }, 'admin')).status, 409)
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: '' }, 'admin')).status, 400)
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Mine' }, 'mem')).status, 403)
  const id = made.body.team.id
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/teams/${id}`, { name: 'Platform' }, 'mem')).status, 403)
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}/teams/${id}`, { name: 'Platform' }, 'admin')).body.team.name, 'Platform')
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/teams/${id}`, null, 'mem')).status, 403)
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/teams/${id}`, null, 'admin')).status, 200)
  assert.equal((await t.call('DELETE', `/v1/orgs/${o.slug}/teams/${id}`, null, 'admin')).status, 404)
})

test('team membership: add, change access and remove; people always see their own teams', async () => {
  const o = await makeOrg(t, 'Web Co')
  const web = (await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Web' }, 'admin')).body.team
  const ops = (await t.call('POST', `/v1/orgs/${o.slug}/teams`, { name: 'Ops' }, 'admin')).body.team
  const base = `/v1/orgs/${o.slug}/teams/${web.id}/members`
  assert.equal((await t.call('POST', base, { memberId: o.mem.id, access: 'owner' }, 'admin')).status, 400)
  assert.equal((await t.call('POST', base, { memberId: o.mem.id, access: 'viewer' }, 'mem')).status, 403)
  assert.equal((await t.call('POST', base, { memberId: o.mem.id }, 'admin')).body.member.access, 'viewer', 'viewer by default')
  const other = await makeOrg(t, 'Other Co')
  assert.equal((await t.call('POST', base, { memberId: other.mem.id, access: 'viewer' }, 'admin')).status, 404, 'only members of this org')

  const seen = await t.call('GET', `/v1/orgs/${o.slug}/teams`, null, 'mem')
  const w = seen.body.teams.find((x) => x.id === web.id)
  assert.equal(w.access, 'viewer')
  assert.deepEqual(w.members, [{ memberId: o.mem.id, name: 'Mo', access: 'viewer' }])
  assert.equal(seen.body.teams.find((x) => x.id === ops.id).members, null, "Members see other teams' names, not who's in them")
  assert.equal(seen.body.people, null)
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/teams`, null, 'admin')).body.people.length, 3)

  // Without Teams: Read, you see only the teams you're in.
  await t.store.updateRole(o.role('member').id, { grants: {} })
  assert.deepEqual((await t.call('GET', `/v1/orgs/${o.slug}/teams`, null, 'mem')).body.teams.map((x) => x.name), ['Web'])

  assert.equal((await t.call('PUT', `${base}/${o.mem.id}`, { access: 'editor' }, 'admin')).body.member.access, 'editor')
  assert.equal((await t.call('PUT', `${base}/${o.admin.id}`, { access: 'editor' }, 'admin')).status, 404, 'not in the team')
  assert.equal((await t.call('DELETE', `${base}/${o.mem.id}`, null, 'admin')).status, 200)
  assert.equal((await t.call('DELETE', `${base}/${o.mem.id}`, null, 'admin')).status, 404)
  assert.equal((await t.call('POST', `/v1/orgs/${other.slug}/teams/${web.id}/members`, { memberId: other.mem.id, access: 'viewer' }, 'owner')).status, 404, "another org's team")
})
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test test/api-teams.test.js`
Expected: FAIL — `404 not found` for the member and team routes.

- [ ] **Step 3: Implement the member routes**

Create `src/api/routes/members.js`:

```js
// An org's people: the member list, changing someone's role, removing or leaving.
import { HttpError, needId } from '../http.js'
import { orgAccess } from '../org-access.js'

export function memberRoutes ({ store, user }) {
  const orgFor = async (req, slug) => { const u = await user(req); return { u, ...(await orgAccess(store, u.userId, slug)) } }

  async function target (a, id) {
    const m = await store.memberById(a.org.id, needId(id, 'member'))
    if (!m) throw new HttpError(404, 'no such member')
    if (m.userId === a.org.ownerId) throw new HttpError(403, 'the owner only changes through a transfer')
    return m
  }

  // You can't act on someone whose role holds checkboxes you don't.
  async function outranks (a, m) {
    const r = m.roleId && await store.roleById(a.org.id, m.roleId)
    if (!a.covers(r?.grants)) throw new HttpError(403, "this person has permissions you don't have")
  }

  return [
    ['GET', /^\/v1\/orgs\/([^/]+)\/members$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('members', 'r')
      const [members, roles] = await Promise.all([store.listMembers(a.org.id), store.listRoles(a.org.id)])
      const roleName = new Map(roles.map((r) => [r.id, r.name]))
      // Team names only for people allowed to see who's in each team.
      const teamsOf = new Map()
      if (a.can('team_members', 'r')) {
        for (const team of await store.listTeams(a.org.id)) {
          for (const tm of await store.listTeamMembers(team.id)) {
            teamsOf.set(tm.memberId, [...(teamsOf.get(tm.memberId) || []), { id: team.id, name: team.name, access: tm.access }])
          }
        }
      }
      const emails = await Promise.all(members.map((m) => (m.userId ? store.userEmail(m.userId) : null)))
      return {
        members: members.map((m, i) => ({
          id: m.id,
          userId: m.userId,
          name: m.name,
          email: emails[i]?.email || '',
          roleId: m.roleId,
          role: roleName.get(m.roleId) || null,
          isOwner: m.userId === a.org.ownerId,
          isYou: m.userId === a.u.userId,
          joinedAt: m.joinedAt,
          teams: teamsOf.get(m.id) || []
        }))
      }
    }],

    ['PUT', /^\/v1\/orgs\/([^/]+)\/members\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      // Assigning a role is Members: Update together with Roles: Update.
      a.need('members', 'u')
      a.need('roles', 'u')
      const m = await target(a, id)
      if (m.userId === a.u.userId) throw new HttpError(403, "you can't change your own role")
      await outranks(a, m)
      const role = await a.assignable(body.roleId || 'missing')
      const saved = await store.setMemberRole(m.id, role.id)
      return { member: { id: saved.id, roleId: saved.roleId } }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)\/members\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      const m = await target(a, id)
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

(`a.assignable('missing')` answers 404 through `needId`, so a missing `roleId` never silently means "Member" here.)

- [ ] **Step 4: Implement the team routes**

Create `src/api/routes/teams.js`:

```js
// Flat teams inside an org, and who's in each with editor or viewer access.
import { HttpError, needId, cleanName } from '../http.js'
import { orgAccess } from '../org-access.js'

const ACCESS = ['editor', 'viewer']
const accessOf = (v) => {
  if (!ACCESS.includes(v)) throw new HttpError(400, 'access must be editor or viewer')
  return v
}

export function teamRoutes ({ store, user }) {
  const orgFor = async (req, slug) => { const u = await user(req); return { u, ...(await orgAccess(store, u.userId, slug)) } }

  async function teamIn (a, id) {
    const team = await store.teamById(a.org.id, needId(id, 'team'))
    if (!team) throw new HttpError(404, 'no such team')
    return team
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
            ? (await store.listTeamMembers(t.id)).map((m) => ({ memberId: m.memberId, name: m.name, access: m.access }))
            : null
        }))),
        // The people you could add, for those who add people to teams.
        people: a.can('team_members', 'c')
          ? (await store.listMembers(a.org.id)).map((m) => ({ memberId: m.id, name: m.name }))
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
      const tm = await store.addTeamMember({ teamId: team.id, memberId: m.id, access })
      return { member: { memberId: tm.memberId, access: tm.access } }
    }],

    ['PUT', /^\/v1\/orgs\/([^/]+)\/teams\/([^/]+)\/members\/([^/]+)$/, async (req, body, [slug, id, memberId]) => {
      const a = await orgFor(req, slug)
      a.need('team_members', 'u')
      const team = await teamIn(a, id)
      const tm = await store.setTeamAccess(team.id, needId(memberId, 'member'), accessOf(body.access))
      if (!tm) throw new HttpError(404, "that person isn't in this team")
      return { member: { memberId: tm.memberId, access: tm.access } }
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

- [ ] **Step 5: Wire them into the server**

In `src/api/server.js`, add to the imports:

```js
import { memberRoutes } from './routes/members.js'
import { teamRoutes } from './routes/teams.js'
```

and change `routes.push(...orgRoutes(ctx))` to:

```js
  routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx))
```

- [ ] **Step 6: Run to see them pass, then the whole suite**

Run: `node --test test/api-teams.test.js && npm test`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/api/routes/members.js src/api/routes/teams.js src/api/server.js test/api-teams.test.js
git commit -m "Add member and team routes to the accounts API"
```

---
### Task 7: API — email invites and domain join requests

**Files:**
- Create: `src/api/invite-email.js`, `src/api/routes/invites.js`
- Modify: `src/api/server.js`
- Test: `test/api-invites.test.js`

**Interfaces:**
- Consumes: `orgAccess` (`need`, `assignable`), `HttpError`, `needId` (Task 5); `newToken`, `hashToken` (`src/api/tokens.js`); `emailDomain`, `isPublicDomain` (Task 1); store invites/join-request methods (Task 4); `ctx.mailer.send({ to, subject, text })`, `ctx.limit(req)`, `ctx.site`, `ctx.now`, `ctx.log` (Task 5).
- Produces:
  - `inviteEmail({ orgName, inviterName, roleName, link }) -> { subject, text }`
  - `GET /v1/orgs/:slug/invites` (User invites: Read) → `{ invites: [{ id, email, roleId, role, expiresAt, createdAt, expired }], requests: [{ id, userId, name, email, createdAt }] }`
  - `POST /v1/orgs/:slug/invites { email, roleId? }` (User invites: Create; role defaults to Member, subset rule, never Owner; replaces an open invite to the same address; emails `${site}/invite/qi_…`) → `{ invite }`; `502` if the email fails (the invite is kept)
  - `POST /v1/orgs/:slug/invites/:id/resend` (User invites: Update; new token, new 7-day expiry) → `{ invite }`
  - `DELETE /v1/orgs/:slug/invites/:id` (User invites: Delete) → `{ ok: true }`
  - `GET /v1/invites/:token` (signed in; rate-limited) → `{ org: { name, slug }, email, role, status: 'pending'|'accepted'|'cancelled'|'expired' }`
  - `POST /v1/invites/accept { token }` (signed in; rate-limited; that email, confirmed) → `{ org: { name, slug } }`
  - `GET /v1/orgs/discover` (signed in) → `{ domain: string|null, orgs: [{ name, slug, requested }] }`
  - `POST /v1/orgs/:slug/requests` (signed in; rate-limited; confirmed email on the org's domain; requests on) → `{ request: { id, status } }`
  - `POST /v1/orgs/:slug/requests/:id { approve, roleId? }` (approve: User invites: Create + subset; deny: User invites: Delete) → `{ status: 'approved'|'denied' }`

- [ ] **Step 1: Write the failing tests**

Create `test/api-invites.test.js`:

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeOrg, SITE } from './api-helpers.js'
import { hashToken } from '../src/api/tokens.js'
import { inviteEmail } from '../src/api/invite-email.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())

const tokenIn = (mail) => mail.text.match(/\/invite\/(qi_[A-Za-z0-9_-]+)/)[1]
const invite = (o, email, who = 'admin', roleId) => t.call('POST', `/v1/orgs/${o.slug}/invites`, { email, ...(roleId ? { roleId } : {}) }, who)

test('the invite email names the org, the inviter and the role, and carries the link', () => {
  const m = inviteEmail({ orgName: 'Acme', inviterName: 'Ada', roleName: 'Member', link: 'https://quilt.test/invite/qi_x' })
  assert.equal(m.subject, 'Ada invited you to Acme on Quilt')
  assert.match(m.text, /join Acme on Quilt as Member/)
  assert.match(m.text, /https:\/\/quilt\.test\/invite\/qi_x/)
  assert.match(m.text, /7 days/)
  assert.equal(inviteEmail({ orgName: 'Acme', roleName: 'Member', link: 'l' }).subject, 'Someone invited you to Acme on Quilt')
})

test('inviting emails a qi_ link; only its hash is stored', async () => {
  const o = await makeOrg(t, 'Invite Co')
  const r = await invite(o, ' New@Acme.com ')
  assert.equal(r.status, 200)
  assert.deepEqual([r.body.invite.email, r.body.invite.role, r.body.invite.expired], ['new@acme.com', 'Member', false])
  const mail = t.sent.at(-1)
  assert.equal(mail.to, 'new@acme.com')
  assert.equal(mail.subject, 'Ada invited you to Invite Co on Quilt')
  assert.ok(mail.text.includes(`${SITE}/invite/qi_`))
  const token = tokenIn(mail)
  const stored = await t.store.inviteByToken(hashToken(token))
  assert.equal(stored.id, r.body.invite.id)
  assert.notEqual(stored.tokenHash, token)
  assert.equal(JSON.stringify(r.body).includes(token), false, 'the token only travels by email')
  assert.ok(stored.expiresAt - Date.now() > 6.9 * 24 * 3600e3, 'about 7 days')
  assert.equal((await invite(o, 'x@acme.com', 'mem')).status, 403)
  assert.equal((await invite(o, 'not an email')).status, 400)
  assert.equal((await invite(o, 'x@acme.com', 'admin', o.role('owner').id)).status, 403)
})

test('accepting needs the invited address, confirmed', async () => {
  const o = await makeOrg(t, 'Accept Co')
  await invite(o, 'newbie@acme.com')
  const token = tokenIn(t.sent.at(-1))
  t.store.addUser('newbie', { name: 'Newbie', email: 'Newbie@Acme.com' })
  t.store.addUser('newbie-unconfirmed', { name: 'Newbie', email: 'newbie@acme.com', confirmed: false })
  const accept = (who) => t.call('POST', '/v1/invites/accept', { token }, who)
  assert.equal((await accept()).status, 401)
  const wrong = await accept('out')
  assert.equal(wrong.status, 403)
  assert.match(wrong.body.error, /newbie@acme\.com/)
  assert.equal((await accept('newbie-unconfirmed')).status, 403)
  const ok = await accept('newbie')
  assert.deepEqual([ok.status, ok.body.org.slug], [200, o.slug])
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'newbie')).body.role.builtin, 'member')
  assert.equal((await accept('newbie')).status, 410, 'used once')
  assert.equal((await t.call('POST', '/v1/invites/accept', { token: 'qi_nope' }, 'newbie')).status, 404)
})

test('looking up an invite shows the org, role and status; cancelling needs User invites: Delete', async () => {
  const o = await makeOrg(t, 'Look Co')
  const made = await invite(o, 'look@acme.com')
  const token = tokenIn(t.sent.at(-1))
  const seen = await t.call('GET', `/v1/invites/${token}`, null, 'out')
  assert.deepEqual(seen.body, { org: { name: 'Look Co', slug: o.slug }, email: 'look@acme.com', role: 'Member', status: 'pending' })
  assert.equal((await t.call('GET', `/v1/invites/${token}`)).status, 401)
  const cancel = (who) => t.call('DELETE', `/v1/orgs/${o.slug}/invites/${made.body.invite.id}`, null, who)
  assert.equal((await cancel('mem')).status, 403)
  assert.equal((await cancel('admin')).status, 200)
  assert.equal((await t.call('GET', `/v1/invites/${token}`, null, 'out')).body.status, 'cancelled')
  assert.equal((await cancel('admin')).status, 404)
})

test('invites expire after 7 days; resending sends a fresh link and retires the old one', async () => {
  let clock = Date.parse('2026-10-01T00:00:00Z')
  const c = await startTestApi({ now: () => clock })
  try {
    const o = await makeOrg(c, 'Clock Co')
    c.store.addUser('late', { name: 'Late', email: 'late@acme.com' })
    const made = await c.call('POST', `/v1/orgs/${o.slug}/invites`, { email: 'late@acme.com' }, 'admin')
    const first = tokenIn(c.sent.at(-1))
    clock += 7 * 24 * 3600e3 + 1
    assert.equal((await c.call('GET', `/v1/invites/${first}`, null, 'late')).body.status, 'expired')
    assert.equal((await c.call('POST', '/v1/invites/accept', { token: first }, 'late')).status, 410)
    assert.equal((await c.call('GET', `/v1/orgs/${o.slug}/invites`, null, 'admin')).body.invites[0].expired, true)
    const resend = (who) => c.call('POST', `/v1/orgs/${o.slug}/invites/${made.body.invite.id}/resend`, {}, who)
    assert.equal((await resend('mem')).status, 403)
    const again = await resend('admin')
    assert.deepEqual([again.status, again.body.invite.expired], [200, false])
    const second = tokenIn(c.sent.at(-1))
    assert.notEqual(second, first)
    assert.equal((await c.call('POST', '/v1/invites/accept', { token: first }, 'late')).status, 404, 'the old link is gone')
    assert.equal((await c.call('POST', '/v1/invites/accept', { token: second }, 'late')).status, 200)
  } finally { await c.close() }
})

test('a new invite to the same address replaces the open one', async () => {
  const o = await makeOrg(t, 'Twice Co')
  await invite(o, 'twice@acme.com')
  const first = tokenIn(t.sent.at(-1))
  await invite(o, 'twice@acme.com')
  const list = await t.call('GET', `/v1/orgs/${o.slug}/invites`, null, 'admin')
  assert.equal(list.body.invites.filter((i) => i.email === 'twice@acme.com').length, 1)
  t.store.addUser('twice', { name: 'Twice', email: 'twice@acme.com' })
  assert.equal((await t.call('POST', '/v1/invites/accept', { token: first }, 'twice')).status, 410)
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/invites`, null, 'mem')).status, 403)
})

test('when the email fails to send, the invite is kept and the caller is told', async () => {
  const lines = []
  const c = await startTestApi({ mailer: { send: async () => { throw new Error('smtp down') } }, log: (l) => lines.push(l) })
  try {
    const o = await makeOrg(c, 'Mail Co')
    const r = await c.call('POST', `/v1/orgs/${o.slug}/invites`, { email: 'm@acme.com' }, 'admin')
    assert.equal(r.status, 502)
    assert.match(r.body.error, /Resend/)
    assert.equal((await c.call('GET', `/v1/orgs/${o.slug}/invites`, null, 'admin')).body.invites.length, 1)
    assert.match(lines.join('\n'), /smtp down/)
  } finally { await c.close() }
})

test('domain requests: people on the org domain find it, ask once, and an approver lets them in', async () => {
  const o = await makeOrg(t, 'Domain Co')
  assert.equal((await t.call('PUT', `/v1/orgs/${o.slug}`, { domain: 'acme.com', domainRequests: true }, 'owner')).status, 200)
  t.store.addUser('jo', { name: 'Jo', email: 'Jo@Acme.com' })
  const found = await t.call('GET', '/v1/orgs/discover', null, 'jo')
  assert.equal(found.body.domain, 'acme.com')
  assert.deepEqual(found.body.orgs.find((x) => x.slug === o.slug), { name: 'Domain Co', slug: o.slug, requested: false })
  const asked = await t.call('POST', `/v1/orgs/${o.slug}/requests`, {}, 'jo')
  assert.deepEqual([asked.status, asked.body.request.status], [200, 'pending'])
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/requests`, {}, 'jo')).body.request.id, asked.body.request.id, 'asking twice is one request')
  assert.equal((await t.call('GET', '/v1/orgs/discover', null, 'jo')).body.orgs.find((x) => x.slug === o.slug).requested, true)
  const list = await t.call('GET', `/v1/orgs/${o.slug}/invites`, null, 'admin')
  assert.deepEqual(list.body.requests.map((r) => [r.name, r.email]), [['Jo', 'jo@acme.com']])
  const decide = (who, body) => t.call('POST', `/v1/orgs/${o.slug}/requests/${asked.body.request.id}`, body, who)
  assert.equal((await decide('mem', { approve: true })).status, 403)
  assert.equal((await decide('admin', { approve: true, roleId: o.role('owner').id })).status, 403, 'never Owner')
  assert.equal((await decide('admin', { approve: true })).body.status, 'approved')
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'jo')).body.role.builtin, 'member')
  assert.equal((await decide('admin', { approve: true })).status, 404, 'decided once')
  assert.equal((await t.call('GET', '/v1/orgs/discover', null, 'jo')).body.orgs.some((x) => x.slug === o.slug), false, 'joined orgs drop out')
})

test('public, unconfirmed or other-domain people never see or ask to join', async () => {
  const o = await makeOrg(t, 'Closed Co')
  await t.call('PUT', `/v1/orgs/${o.slug}`, { domain: 'acme.com', domainRequests: true }, 'owner')
  assert.deepEqual((await t.call('GET', '/v1/orgs/discover', null, 'gm')).body, { domain: null, orgs: [] })
  assert.deepEqual((await t.call('GET', '/v1/orgs/discover', null, 'unconf')).body, { domain: null, orgs: [] })
  assert.deepEqual((await t.call('GET', '/v1/orgs/discover', null, 'out')).body.orgs, [])
  for (const who of ['gm', 'unconf', 'out']) assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/requests`, {}, who)).status, 404, who)
  assert.equal((await t.call('POST', `/v1/orgs/${o.slug}/requests`, {}, 'mem')).status, 409, 'already in')
  const quiet = await makeOrg(t, 'Quiet Co')
  await t.call('PUT', `/v1/orgs/${quiet.slug}`, { domain: 'acme.com' }, 'owner')
  t.store.addUser('q', { name: 'Q', email: 'q@acme.com' })
  assert.equal((await t.call('POST', `/v1/orgs/${quiet.slug}/requests`, {}, 'q')).status, 404, 'requests are off')
})

test('denying a request needs User invites: Delete, and adds no one', async () => {
  const o = await makeOrg(t, 'Deny Co')
  await t.call('PUT', `/v1/orgs/${o.slug}`, { domain: 'acme.com', domainRequests: true }, 'owner')
  t.store.addUser('nope', { name: 'Nope', email: 'nope@acme.com' })
  const asked = await t.call('POST', `/v1/orgs/${o.slug}/requests`, {}, 'nope')
  const decide = (who, approve) => t.call('POST', `/v1/orgs/${o.slug}/requests/${asked.body.request.id}`, { approve }, who)
  const inviter = await t.store.createRole({ orgId: o.org.id, name: 'Inviter', grants: { invites: { c: true, r: true } } })
  await t.store.addMember({ orgId: o.org.id, userId: 'lim', roleId: inviter.id })
  assert.equal((await decide('lim', false)).status, 403, 'denying is Delete')
  assert.equal((await decide('admin', false)).body.status, 'denied')
  assert.equal((await t.call('GET', `/v1/orgs/${o.slug}/me`, null, 'nope')).status, 404)
  assert.equal((await decide('admin', true)).status, 404, 'already decided')
})

test('invite lookups and acceptances are rate-limited per address', async () => {
  const c = await startTestApi({ inviteLimit: 2, trustProxy: true })
  try {
    const go = (ip) => c.call('POST', '/v1/invites/accept', { token: 'qi_nope' }, 'out', { 'fly-client-ip': ip })
    assert.equal((await go('203.0.113.9')).status, 404)
    assert.equal((await go('203.0.113.9')).status, 404)
    assert.equal((await go('203.0.113.9')).status, 429)
    assert.equal((await go('203.0.113.10')).status, 404, 'another address has its own limit')
  } finally { await c.close() }
})
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test test/api-invites.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/api/invite-email.js`.

- [ ] **Step 3: Write the invite email**

Create `src/api/invite-email.js`:

```js
// The one email the accounts API sends itself: an org invite.
export function inviteEmail ({ orgName, inviterName, roleName, link }) {
  const who = inviterName || 'Someone'
  return {
    subject: `${who} invited you to ${orgName} on Quilt`,
    text: [
      `${who} invited you to join ${orgName} on Quilt as ${roleName}.`,
      '',
      `Accept the invite: ${link}`,
      '',
      'Sign in, or create your account, with this email address. The link works for 7 days.',
      "If you weren't expecting this, you can ignore this email."
    ].join('\n')
  }
}
```

- [ ] **Step 4: Write the invite and join-request routes**

Create `src/api/routes/invites.js`:

```js
// Joining an org: email invites (the API sends them) and domain join requests.
import { HttpError, needId } from '../http.js'
import { orgAccess } from '../org-access.js'
import { newToken, hashToken } from '../tokens.js'
import { emailDomain, isPublicDomain } from '../domains.js'
import { inviteEmail } from '../invite-email.js'

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const GONE = {
  accepted: 'this invite was already used',
  cancelled: 'this invite was cancelled',
  expired: 'this invite has expired; ask for a new one'
}

export function inviteRoutes ({ store, user, now, site, mailer, log, limit }) {
  const orgFor = async (req, slug) => { const u = await user(req); return { u, ...(await orgAccess(store, u.userId, slug)) } }
  const statusOf = (i) => (i.acceptedAt ? 'accepted' : i.cancelledAt ? 'cancelled' : i.expiresAt < now() ? 'expired' : 'pending')
  const inviteView = (i, role) => ({ id: i.id, email: i.email, roleId: i.roleId, role, expiresAt: i.expiresAt, createdAt: i.createdAt, expired: i.expiresAt < now() })

  // The domain of the caller's confirmed email, unless it belongs to a public mail provider.
  async function confirmedDomain (userId) {
    const mine = await store.userEmail(userId)
    const d = mine?.confirmed ? emailDomain(mine.email) : ''
    return d && !isPublicDomain(d) ? d : null
  }

  // The link only ever travels by email; only its hash is stored.
  async function mail (a, invite, role, token) {
    const inviter = await store.profile(a.u.userId)
    const msg = inviteEmail({ orgName: a.org.name, inviterName: inviter?.name, roleName: role.name, link: `${site}/invite/${token}` })
    try {
      await mailer.send({ to: invite.email, ...msg })
    } catch (err) {
      log(`invite email failed: ${err?.stack || err?.message || err}`)
      throw new HttpError(502, "the invite was saved but the email didn't send; try Resend")
    }
  }

  async function openInvite (a, id) {
    const i = await store.inviteById(a.org.id, needId(id, 'invite'))
    if (!i || i.acceptedAt || i.cancelledAt) throw new HttpError(404, 'no such invite')
    return i
  }

  return [
    ['GET', /^\/v1\/orgs\/([^/]+)\/invites$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('invites', 'r')
      const roles = new Map((await store.listRoles(a.org.id)).map((r) => [r.id, r.name]))
      const [invites, requests] = await Promise.all([store.listInvites(a.org.id), store.listJoinRequests(a.org.id)])
      return {
        invites: invites.map((i) => inviteView(i, roles.get(i.roleId) || null)),
        requests: requests.map((r) => ({ id: r.id, userId: r.userId, name: r.name, email: r.email, createdAt: r.createdAt }))
      }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/invites$/, async (req, body, [slug]) => {
      const a = await orgFor(req, slug)
      a.need('invites', 'c')
      const email = String(body.email || '').trim().toLowerCase()
      if (!emailDomain(email) || /\s/.test(email)) throw new HttpError(400, "that email doesn't look right")
      const role = await a.assignable(body.roleId)
      // One open invite per address: a new one replaces the old.
      for (const old of await store.listInvites(a.org.id)) if (old.email === email) await store.updateInvite(old.id, { cancelledAt: now() })
      const token = newToken('qi_')
      const invite = await store.createInvite({ orgId: a.org.id, email, roleId: role.id, tokenHash: hashToken(token), invitedBy: a.u.userId, expiresAt: now() + INVITE_TTL_MS })
      await mail(a, invite, role, token)
      return { invite: inviteView(invite, role.name) }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/invites\/([^/]+)\/resend$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('invites', 'u')
      const invite = await openInvite(a, id)
      const role = await store.roleById(a.org.id, invite.roleId)
      const token = newToken('qi_')
      const fresh = await store.updateInvite(invite.id, { tokenHash: hashToken(token), expiresAt: now() + INVITE_TTL_MS })
      await mail(a, fresh, role, token)
      return { invite: inviteView(fresh, role.name) }
    }],

    ['DELETE', /^\/v1\/orgs\/([^/]+)\/invites\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      a.need('invites', 'd')
      await store.updateInvite((await openInvite(a, id)).id, { cancelledAt: now() })
      return { ok: true }
    }],

    ['GET', /^\/v1\/invites\/([^/]+)$/, async (req, body, [token]) => {
      await user(req)
      limit(req)
      const invite = await store.inviteByToken(hashToken(token))
      if (!invite) throw new HttpError(404, 'no such invite')
      const org = await store.orgById(invite.orgId)
      const role = await store.roleById(invite.orgId, invite.roleId)
      return { org: { name: org.name, slug: org.slug }, email: invite.email, role: role?.name || null, status: statusOf(invite) }
    }],

    ['POST', /^\/v1\/invites\/accept$/, async (req, body) => {
      const u = await user(req)
      limit(req)
      const invite = await store.inviteByToken(hashToken(body.token))
      if (!invite) throw new HttpError(404, 'no such invite')
      const status = statusOf(invite)
      if (status !== 'pending') throw new HttpError(410, GONE[status])
      // Only the person it was sent to, once they've proved they own the address.
      const mine = await store.userEmail(u.userId)
      if (String(mine?.email || '').toLowerCase() !== invite.email) throw new HttpError(403, `this invite is for ${invite.email}; sign in with that address`)
      if (!mine.confirmed) throw new HttpError(403, 'confirm your email address first, then open the invite again')
      if (!await store.claimInvite(invite.id)) throw new HttpError(410, GONE.accepted)
      const org = await store.orgById(invite.orgId)
      await store.addMember({ orgId: org.id, userId: u.userId, roleId: invite.roleId })
      return { org: { name: org.name, slug: org.slug } }
    }],

    ['GET', /^\/v1\/orgs\/discover$/, async (req) => {
      const u = await user(req)
      const domain = await confirmedDomain(u.userId)
      if (!domain) return { domain: null, orgs: [] }
      const [orgs, mine, asked] = await Promise.all([store.orgsByDomain(domain), store.orgsForUser(u.userId), store.joinRequestsForUser(u.userId)])
      const joined = new Set(mine.map((o) => o.id))
      const pending = new Set(asked.filter((r) => r.status === 'pending').map((r) => r.orgId))
      return { domain, orgs: orgs.filter((o) => !joined.has(o.id)).map((o) => ({ name: o.name, slug: o.slug, requested: pending.has(o.id) })) }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/requests$/, async (req, body, [slug]) => {
      const u = await user(req)
      limit(req)
      const org = await store.orgBySlug(String(slug).toLowerCase())
      const domain = await confirmedDomain(u.userId)
      // One answer for a missing org and one you can't ask to join, so addresses can't be probed.
      if (!org || !org.domainRequests || !domain || org.domain !== domain) throw new HttpError(404, 'no such org')
      if (await store.memberOf(org.id, u.userId)) throw new HttpError(409, "you're already in this org")
      const mine = await store.userEmail(u.userId)
      const r = await store.createJoinRequest({ orgId: org.id, userId: u.userId, email: mine.email.toLowerCase() })
      return { request: { id: r.id, status: r.status } }
    }],

    ['POST', /^\/v1\/orgs\/([^/]+)\/requests\/([^/]+)$/, async (req, body, [slug, id]) => {
      const a = await orgFor(req, slug)
      const approve = body.approve === true
      // Approving is User invites: Create; denying is User invites: Delete.
      a.need('invites', approve ? 'c' : 'd')
      const r = await store.joinRequestById(a.org.id, needId(id, 'request'))
      if (!r || r.status !== 'pending') throw new HttpError(404, 'no such request')
      const role = approve ? await a.assignable(body.roleId) : null
      if (!await store.decideJoinRequest(r.id, { status: approve ? 'approved' : 'denied', decidedBy: a.u.userId })) throw new HttpError(404, 'no such request')
      if (approve) await store.addMember({ orgId: a.org.id, userId: r.userId, roleId: role.id })
      return { status: approve ? 'approved' : 'denied' }
    }]
  ]
}
```

- [ ] **Step 5: Wire it into the server**

In `src/api/server.js`, add `import { inviteRoutes } from './routes/invites.js'` to the imports and change the push line to:

```js
  routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx))
```

- [ ] **Step 6: Run to see them pass, then the whole suite**

Run: `node --test test/api-invites.test.js && npm test`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/api/invite-email.js src/api/routes/invites.js src/api/server.js test/api-invites.test.js
git commit -m "Add email invites and domain join requests to the accounts API"
```

---

### Task 8: SMTP mailer and `quilt api` settings

**Files:**
- Create: `src/api/mailer.js`
- Modify: `bin/quilt.js` (`apiCmd`), `fly.api.toml` (comment), `package.json`, `package-lock.json`
- Test: `test/api-mailer.test.js`, `test/api-cli.test.js`

**Interfaces:**
- Consumes: `startApi({ mailer })` (Task 5).
- Produces: `createSmtpMailer({ url, from, transport? }) -> { send({ to, subject, text }) }` (nodemailer); `createConsoleMailer(log) -> { send }`. `quilt api` requires `SMTP_URL` and `SMTP_FROM` (besides the existing variables); `quilt api --memory` prints emails.

- [ ] **Step 1: Add nodemailer**

Run: `npm install nodemailer`
Expected: `package.json` gains `"nodemailer": "^<version>"` under `dependencies`, and `package-lock.json` is updated. (The API's Docker image runs `npm ci --omit=dev`, so it must be a regular dependency.)

- [ ] **Step 2: Write the failing tests**

Create `test/api-mailer.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSmtpMailer, createConsoleMailer } from '../src/api/mailer.js'

test('the SMTP mailer sends from SMTP_FROM with the message it is given', async () => {
  const sent = []
  const m = createSmtpMailer({ from: 'Quilt <invites@heyquilt.com>', transport: { sendMail: async (x) => { sent.push(x) } } })
  await m.send({ to: 'a@acme.com', subject: 'Hi', text: 'Body' })
  assert.deepEqual(sent, [{ from: 'Quilt <invites@heyquilt.com>', to: 'a@acme.com', subject: 'Hi', text: 'Body' }])
})

test('the SMTP mailer builds its transport from SMTP_URL without connecting', () => {
  const m = createSmtpMailer({ url: 'smtp://user:pass@127.0.0.1:2525', from: 'x@quilt.test' })
  assert.equal(typeof m.send, 'function')
})

test('the console mailer prints the email, link included', async () => {
  const lines = []
  await createConsoleMailer((l) => lines.push(l)).send({ to: 'a@acme.com', subject: 'Hi', text: 'Open http://localhost:3000/invite/qi_x' })
  assert.match(lines.join('\n'), /a@acme\.com[\s\S]*qi_x/)
})
```

In `test/api-cli.test.js`:

1. In `run`, change the env filter regex to also drop SMTP settings:

```js
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SUPABASE_|AGENT_KEY_SECRET|QUILT_|SMTP_)/.test(k)))
```

2. Replace `const prodEnv = …` with:

```js
const prodEnv = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', QUILT_SITE_URL: 'https://quilt.test', SMTP_URL: 'smtp://u:p@127.0.0.1:2525', SMTP_FROM: 'Quilt <invites@quilt.test>' }
```

3. Append:

```js
test('quilt api refuses to start without SMTP settings, since invites need email', async () => {
  for (const k of ['SMTP_URL', 'SMTP_FROM']) {
    const env = { ...prodEnv, AGENT_KEY_SECRET: Buffer.alloc(32, 7).toString('base64') }
    delete env[k]
    const { out, code } = await run(['--port', '0'], env)
    assert.equal(code, 1, k)
    assert.match(out, new RegExp(`${k} is not set`))
  }
})
```

- [ ] **Step 3: Run to see them fail**

Run: `node --test test/api-mailer.test.js test/api-cli.test.js`
Expected: `api-mailer` FAILS with `ERR_MODULE_NOT_FOUND`; the new CLI test FAILS (the API starts and prints `listening` instead of exiting).

- [ ] **Step 4: Implement the mailer**

Create `src/api/mailer.js`:

```js
// How the accounts API sends email (org invites). Production uses SMTP, e.g.
// SMTP_URL=smtp://resend:<key>@smtp.resend.com:587 and SMTP_FROM="Quilt <invites@heyquilt.com>".
import nodemailer from 'nodemailer'

export function createSmtpMailer ({ url, from, transport }) {
  const t = transport || nodemailer.createTransport(url)
  return { send: ({ to, subject, text }) => t.sendMail({ from, to, subject, text }) }
}

// `quilt api --memory` prints emails instead, so invite links can be copied from the terminal.
export function createConsoleMailer (log = console.log) {
  return { send: async ({ to, subject, text }) => { log(`--- email to ${to}: ${subject}\n${text}\n---`) } }
}
```

- [ ] **Step 5: Wire it into `quilt api`**

In `bin/quilt.js`, in `apiCmd`:

1. Change `let store, verifyUser` to `let store, verifyUser, mailer`.
2. In the `if (values.memory) {` branch, after the `console.log('in-memory mode: …')` line, add:

```js
    const { createConsoleMailer } = await import('../src/api/mailer.js')
    mailer = createConsoleMailer(console.log)
```

3. In the `else` branch, change the required-variables loop to:

```js
    for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'AGENT_KEY_SECRET', 'QUILT_SITE_URL', 'SMTP_URL', 'SMTP_FROM']) if (!env[k]) fail(`${k} is not set`)
```

and after `verifyUser = createUserVerifier({ supabaseUrl: env.SUPABASE_URL })` add:

```js
    const { createSmtpMailer } = await import('../src/api/mailer.js')
    mailer = createSmtpMailer({ url: env.SMTP_URL, from: env.SMTP_FROM })
```

4. In the `startApi({ … })` call, add `mailer,` after `store, verifyUser,`:

```js
  const api = await startApi({
    port: Number(values.port || env.PORT || 8787), host, store, verifyUser, mailer,
    siteUrl: env.QUILT_SITE_URL || 'http://localhost:3000', agentKeySecret: env.AGENT_KEY_SECRET || 'dev-only-secret',
    trustProxy: /^(1|true|yes)$/i.test(env.QUILT_TRUST_PROXY || ''), log: console.log
  })
```

In `fly.api.toml`, change the `fly secrets set` comment line to:

```toml
#   fly secrets set --app quilt-api SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… AGENT_KEY_SECRET="$(openssl rand -base64 32)" QUILT_SITE_URL=… SMTP_URL=smtp://… SMTP_FROM="Quilt <invites@…>"
```

- [ ] **Step 6: Run to see them pass, then the whole suite**

Run: `node --test test/api-mailer.test.js test/api-cli.test.js && npm test`
Expected: PASS, `# fail 0`.

- [ ] **Step 7: Check the memory API by hand**

Run: `node bin/quilt.js api --memory --port 8799 &` then
`curl -s -X POST localhost:8799/v1/orgs -H 'authorization: Bearer local' -H 'content-type: application/json' -d '{"name":"Local Co"}'`
Expected: `{"org":{"id":"…","name":"Local Co","slug":"local-co","domain":null,"domainRequests":false,"createdAt":…}}`. Then `kill %1`.

- [ ] **Step 8: Commit**

```bash
git add src/api/mailer.js bin/quilt.js fly.api.toml package.json package-lock.json test/api-mailer.test.js test/api-cli.test.js
git commit -m "Send invite emails over SMTP; quilt api needs SMTP_URL and SMTP_FROM"
```

---
### Task 9: Website — space switcher, creating an org, and the Org area shell

**Files:**
- Create: `web/lib/permissions.js` (copy), `web/lib/space.js`, `web/lib/space-cookie.js`, `web/lib/org.js`, `web/lib/org-view.js`, `web/components/SpaceSwitcher.js`, `web/components/Notice.js`, `web/app/spaces/actions.js`, `web/app/orgs/new/page.js`, `web/app/orgs/new/NewOrgForm.js`, `web/app/org/[slug]/layout.js`, `web/app/org/[slug]/page.js`, `web/app/org/[slug]/actions.js`, `test/permissions-sync.test.js`, `web/test/space.test.js`, `web/test/org-view.test.js`
- Modify: `web/lib/validate.js`, `web/app/dashboard/page.js` (whole file below), `web/proxy.js`, `web/app/globals.css`, `web/test/validate.test.js`, `web/test/routes.test.js`

**Interfaces:**
- Consumes: API `GET /v1/orgs`, `POST /v1/orgs`, `GET /v1/orgs/:slug/me`, `DELETE /v1/orgs/:slug/members/:id` (Tasks 5–6); `apiCall(user, method, path, body)`, `requireUser(next)` (existing).
- Produces:
  - `web/lib/space.js`: `SPACE_COOKIE = 'quilt_space'`, `PERSONAL = 'personal'`, `isSlug(s) -> boolean`, `spaceHome(value, orgs) -> '/dashboard' | '/org/<slug>'`
  - `web/lib/space-cookie.js` (server-only): `rememberSpace(value) -> Promise<void>`
  - `web/lib/org.js` (server-only, per-request cached): `myOrgs(accessToken) -> Org[]`, `orgMe(accessToken, slug) -> { org, role, grants, isOwner, memberId }` (calls `notFound()` for non-members)
  - `web/lib/org-view.js` (pure): `allowed(me, resource, op) -> boolean`, `orgTabs(slug, me) -> { href, label }[]`, `safeMessage(s) -> string | null`, `when(t) -> string` (replaces the dashboard's own `when`, whose `dateStyle` + `timeZoneName` options throw `TypeError: Invalid option` in Node 22 as soon as a computer or agent has a date)
  - `web/lib/validate.js`: `isValidOrgName(name) -> boolean` (1–80 characters after trimming)
  - `web/components/Notice.js`: `<Notice q={searchParams} />` shows "Saved." for `?saved=1` or a safe `?error=` message
  - Server actions: `switchSpace(formData)` (`space` = `personal` | slug | `+new`), `createOrg(prev, formData) -> { error } | redirect`, `leaveOrg(formData)` (`slug`)
  - Pages: `/orgs/new`, `/org/[slug]` (Overview) inside a layout with the org name, the switcher and tabs. `/dashboard` redirects to the remembered org space.

- [ ] **Step 1: Write the failing tests**

Create `test/permissions-sync.test.js` (root suite):

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test("the website's copy of the permission grid matches the API's", () => {
  assert.equal(fs.readFileSync('web/lib/permissions.js', 'utf8'), fs.readFileSync('src/api/permissions.js', 'utf8'),
    'web/lib/permissions.js is out of date: cp src/api/permissions.js web/lib/permissions.js')
})
```

Create `web/test/space.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SPACE_COOKIE, PERSONAL, isSlug, spaceHome } from '../lib/space.js'

test('the space cookie and personal space names', () => {
  assert.equal(SPACE_COOKIE, 'quilt_space')
  assert.equal(PERSONAL, 'personal')
})

test('isSlug matches the API slug format', () => {
  assert.equal(isSlug('acme'), true)
  assert.equal(isSlug('acme-rockets-2'), true)
  assert.equal(isSlug('Acme'), false)
  assert.equal(isSlug('-acme'), false)
  assert.equal(isSlug('acme--x'), false)
  assert.equal(isSlug('../x'), false)
  assert.equal(isSlug('a'.repeat(49)), false)
  assert.equal(isSlug(undefined), false)
})

test('spaceHome goes to a remembered org only while you are still in it', () => {
  const orgs = [{ slug: 'acme' }, { slug: 'zeta' }]
  assert.equal(spaceHome('acme', orgs), '/org/acme')
  assert.equal(spaceHome('gone', orgs), '/dashboard')
  assert.equal(spaceHome('personal', orgs), '/dashboard')
  assert.equal(spaceHome(undefined, orgs), '/dashboard')
  assert.equal(spaceHome('acme', undefined), '/dashboard')
})
```

Create `web/test/org-view.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowed, orgTabs, safeMessage, when } from '../lib/org-view.js'

const owner = { isOwner: true, grants: {} }
const member = { isOwner: false, grants: { teams: { r: true } } }

test('allowed: the owner may do everything, others what their grid says', () => {
  assert.equal(allowed(owner, 'roles', 'd'), true)
  assert.equal(allowed(member, 'teams', 'r'), true)
  assert.equal(allowed(member, 'teams', 'c'), false)
  assert.equal(allowed(null, 'teams', 'r'), false)
})

test('orgTabs shows only what the viewer can read', () => {
  assert.deepEqual(orgTabs('acme', member).map((t) => t.label), ['Overview', 'Teams'])
  assert.deepEqual(orgTabs('acme', owner).map((t) => t.label), ['Overview', 'People', 'Teams', 'Roles', 'Invites', 'Settings'])
  assert.deepEqual(orgTabs('acme', owner).map((t) => t.href), ['/org/acme', '/org/acme/people', '/org/acme/teams', '/org/acme/roles', '/org/acme/invites', '/org/acme/settings'])
})

test('safeMessage shows our own messages and nothing odd', () => {
  assert.equal(safeMessage(undefined), null)
  assert.equal(safeMessage("your role doesn't allow that"), "your role doesn't allow that")
  assert.equal(safeMessage('this invite is for a@acme.com; sign in with that address'), 'this invite is for a@acme.com; sign in with that address')
  assert.equal(safeMessage('<script>x</script>'), 'Something went wrong. Try again.')
  assert.equal(safeMessage('x'.repeat(201)), 'Something went wrong. Try again.')
  assert.equal(safeMessage(['a']), 'Something went wrong. Try again.')
})

test('when shows a labelled UTC time for epoch ms or ISO strings, without throwing', () => {
  const ms = Date.parse('2026-10-01T12:00:00Z')
  assert.equal(when(ms), 'Oct 1, 2026, 12:00 PM UTC')
  assert.equal(when('2026-10-01T12:00:00Z'), when(ms))
  assert.equal(when(null), 'never')
})
```

Append to `web/test/validate.test.js` (and add `isValidOrgName` to its import from `'../lib/validate.js'`):

```js
test('isValidOrgName needs 1 to 80 characters', () => {
  assert.equal(isValidOrgName('Acme'), true)
  assert.equal(isValidOrgName('  Acme  '), true)
  assert.equal(isValidOrgName('   '), false)
  assert.equal(isValidOrgName('a'.repeat(80)), true)
  assert.equal(isValidOrgName('a'.repeat(81)), false)
  assert.equal(isValidOrgName(null), false)
})
```

In `web/test/routes.test.js`, change the private-pages loop line to:

```js
  for (const path of ['/dashboard', '/settings', '/link?code=AAAA-BBBB', '/reset', '/org/acme', '/orgs/new', '/invite/qi_test']) {
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test test/permissions-sync.test.js` then `cd web && npm test`
Expected: the sync test FAILS (`ENOENT … web/lib/permissions.js`); the web suite FAILS on the missing `lib/space.js`, `lib/org-view.js`, `isValidOrgName`, and the new private paths answer 404 instead of 307.

- [ ] **Step 3: Copy the grid and add the pure helpers**

Run: `cp src/api/permissions.js web/lib/permissions.js`

Append to `web/lib/validate.js`:

```js

export function isValidOrgName (name) {
  if (typeof name !== 'string') return false
  const n = name.trim()
  return n.length >= 1 && n.length <= 80
}
```

Create `web/lib/space.js`:

```js
// Pure — no Next imports — so it can be unit-tested directly.
// The space switcher: "personal" or one of your orgs, remembered in a cookie.
export const SPACE_COOKIE = 'quilt_space'
export const PERSONAL = 'personal'

// The API's slug format (src/api/slugs.js): lowercase letters, digits, single hyphens.
export function isSlug (s) {
  return typeof s === 'string' && s.length <= 48 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)
}

/** Where a remembered space leads: an org you're still in, otherwise your personal dashboard. */
export function spaceHome (value, orgs) {
  const org = isSlug(value) && value !== PERSONAL ? (orgs || []).find((o) => o.slug === value) : null
  return org ? `/org/${org.slug}` : '/dashboard'
}
```

Create `web/lib/org-view.js`:

```js
// Pure helpers for the Org area — no Next imports, so they're unit-tested directly.
import { can } from './permissions.js'

/** Whether the viewer may do `op` on `resource` in this org (the owner may do everything). */
export function allowed (me, resource, op) {
  return !!me && (me.isOwner || can(me.grants, resource, op))
}

/** The Org area's tabs, per the viewer's Read permissions. Everyone sees their own teams. */
export function orgTabs (slug, me) {
  const base = `/org/${slug}`
  return [
    { href: base, label: 'Overview' },
    allowed(me, 'members', 'r') && { href: `${base}/people`, label: 'People' },
    { href: `${base}/teams`, label: 'Teams' },
    allowed(me, 'roles', 'r') && { href: `${base}/roles`, label: 'Roles' },
    allowed(me, 'invites', 'r') && { href: `${base}/invites`, label: 'Invites' },
    allowed(me, 'org', 'r') && { href: `${base}/settings`, label: 'Settings' }
  ].filter(Boolean)
}

// Messages come back through the query string; show them only if they look like ours.
const SAFE = /^[\p{L}\p{N}\s.,;:'’()@?!_–—-]{1,200}$/u
export function safeMessage (s) {
  if (!s) return null
  return typeof s === 'string' && SAFE.test(s) ? s : 'Something went wrong. Try again.'
}

// Pages render on the server (UTC on Netlify), so the zone is pinned and labelled.
// dateStyle/timeStyle can't be combined with timeZoneName (it throws), hence the fields.
const WHEN = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }
/** A date for server-rendered pages: epoch ms (API) or an ISO string (Supabase). */
export function when (t) {
  return t ? new Date(t).toLocaleString('en', WHEN) : 'never'
}
```

- [ ] **Step 4: Add the server helpers and components**

Create `web/lib/space-cookie.js`:

```js
import 'server-only'
import { cookies } from 'next/headers'
import { SPACE_COOKIE } from './space.js'

// Only server actions and route handlers may set cookies, so only they call this.
export async function rememberSpace (value) {
  const store = await cookies()
  store.set(SPACE_COOKIE, value, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax', httpOnly: true, secure: process.env.NODE_ENV === 'production' })
}
```

Create `web/lib/org.js`:

```js
import 'server-only'
import { cache } from 'react'
import { notFound } from 'next/navigation'
import { apiCall } from './api.js'
import { isSlug } from './space.js'

// Cached per request and keyed on the access token, so a layout and its page share one call.
export const myOrgs = cache(async (accessToken) => {
  const r = await apiCall({ accessToken }, 'GET', '/v1/orgs')
  return r.ok ? r.data.orgs : []
})

/** The viewer's place in an org: { org, role, grants, isOwner, memberId }. Not a member: 404. */
export const orgMe = cache(async (accessToken, slug) => {
  if (!isSlug(slug)) notFound()
  const r = await apiCall({ accessToken }, 'GET', `/v1/orgs/${slug}/me`)
  if (r.status === 404) notFound()
  if (!r.ok) throw new Error(`couldn't load org ${slug} (${r.status})`)
  return r.data
})
```

Create `web/components/Notice.js`:

```js
import { safeMessage } from '@/lib/org-view.js'

// "Saved." after a form went through, or the reason it didn't.
export default function Notice ({ q }) {
  if (q?.saved) return <p className='notice'>Saved.</p>
  const e = safeMessage(q?.error)
  return e ? <p className='notice bad'>{e}</p> : null
}
```

Create `web/components/SpaceSwitcher.js`:

```js
'use client'
import { useRef } from 'react'
import { switchSpace } from '@/app/spaces/actions.js'

// Personal, each org you're in, and "Create an org". Changing it switches right away.
export default function SpaceSwitcher ({ orgs, current }) {
  const form = useRef(null)
  return (
    <form ref={form} action={switchSpace} className='space-switcher'>
      <label className='sr-only' htmlFor='space'>Space</label>
      <select className='input' id='space' name='space' defaultValue={current} onChange={() => form.current.requestSubmit()}>
        <option value='personal'>Personal</option>
        {orgs.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
        <option value='+new'>+ Create an org…</option>
      </select>
      <noscript><button className='btn'>Go</button></noscript>
    </form>
  )
}
```

- [ ] **Step 5: Add the actions and pages**

Create `web/app/spaces/actions.js`:

```js
'use server'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { rememberSpace } from '@/lib/space-cookie.js'
import { PERSONAL, isSlug } from '@/lib/space.js'
import { isValidOrgName } from '@/lib/validate.js'

export async function switchSpace (formData) {
  await requireUser('/dashboard')
  const space = String(formData.get('space') || '')
  if (space === '+new') redirect('/orgs/new')
  if (space !== PERSONAL && isSlug(space)) {
    await rememberSpace(space)
    redirect(`/org/${space}`)
  }
  await rememberSpace(PERSONAL)
  redirect('/dashboard')
}

// Used with useActionState: returns an error to show, or redirects into the new org.
export async function createOrg (prev, formData) {
  const user = await requireUser('/orgs/new')
  const name = String(formData.get('name') || '').trim()
  if (!isValidOrgName(name)) return { error: 'Give the org a name (up to 80 characters).' }
  const r = await apiCall(user, 'POST', '/v1/orgs', { name })
  if (!r.ok) return { error: r.data?.error || 'Couldn’t create the org. Try again.' }
  await rememberSpace(r.data.org.slug)
  redirect(`/org/${r.data.org.slug}`)
}
```

Create `web/app/orgs/new/NewOrgForm.js`:

```js
'use client'
import { useActionState } from 'react'
import { createOrg } from '@/app/spaces/actions.js'

export default function NewOrgForm () {
  const [state, action, pending] = useActionState(createOrg, null)
  return (
    <form action={action} className='stack'>
      <div className='field'>
        <label htmlFor='name'>Org name</label>
        <input className='input' id='name' name='name' maxLength={80} required placeholder='e.g. Acme' />
      </div>
      <button className='btn primary' disabled={pending}>{pending ? 'Creating…' : 'Create org'}</button>
      {state?.error && <p className='notice bad'>{state.error}</p>}
    </form>
  )
}
```

Create `web/app/orgs/new/page.js`:

```js
import Header from '@/components/Header.js'
import NewOrgForm from './NewOrgForm.js'
import { requireUser } from '@/lib/session.js'

export const metadata = { title: 'Create an org' }

export default async function NewOrg () {
  await requireUser('/orgs/new')
  return (
    <>
      <Header signedIn />
      <main className='wrap page' style={{ maxWidth: 420 }}>
        <div className='card stack'>
          <h2>Create an org</h2>
          <p className='muted'>A shared space for your team. You’ll be its owner and can invite people once it’s made.</p>
          <NewOrgForm />
        </div>
      </main>
    </>
  )
}
```

Create `web/app/org/[slug]/actions.js`:

```js
'use server'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { rememberSpace } from '@/lib/space-cookie.js'
import { PERSONAL, isSlug } from '@/lib/space.js'

// Anyone but the owner may leave; afterwards the org is gone from the switcher.
export async function leaveOrg (formData) {
  const slug = String(formData.get('slug') || '')
  if (!isSlug(slug)) redirect('/dashboard')
  const user = await requireUser(`/org/${slug}`)
  const me = await apiCall(user, 'GET', `/v1/orgs/${slug}/me`)
  if (!me.ok) redirect('/dashboard')
  const r = await apiCall(user, 'DELETE', `/v1/orgs/${slug}/members/${me.data.memberId}`)
  if (!r.ok) redirect(`/org/${slug}?error=${encodeURIComponent(r.data?.error || 'Couldn’t leave. Try again.')}`)
  await rememberSpace(PERSONAL)
  redirect('/dashboard?left=1')
}
```

Create `web/app/org/[slug]/layout.js`:

```js
import Header from '@/components/Header.js'
import SpaceSwitcher from '@/components/SpaceSwitcher.js'
import { requireUser } from '@/lib/session.js'
import { myOrgs, orgMe } from '@/lib/org.js'
import { orgTabs } from '@/lib/org-view.js'

export default async function OrgLayout ({ children, params }) {
  const { slug } = await params
  const user = await requireUser(`/org/${slug}`)
  const [me, orgs] = await Promise.all([orgMe(user.accessToken, slug), myOrgs(user.accessToken)])
  return (
    <>
      <Header signedIn />
      <main className='wrap page stack'>
        <div className='row' style={{ justifyContent: 'space-between' }}>
          <h1 style={{ fontSize: 32 }}>{me.org.name}</h1>
          <SpaceSwitcher orgs={orgs} current={slug} />
        </div>
        <nav className='tabs' aria-label={`${me.org.name} sections`}>
          {orgTabs(slug, me).map((t) => <a key={t.href} href={t.href}>{t.label}</a>)}
        </nav>
        {children}
      </main>
    </>
  )
}
```

Create `web/app/org/[slug]/page.js`:

```js
import Notice from '@/components/Notice.js'
import { requireUser } from '@/lib/session.js'
import { orgMe } from '@/lib/org.js'
import { leaveOrg } from './actions.js'

export const metadata = { title: 'Org' }

export default async function OrgHome ({ params, searchParams }) {
  const { slug } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}`)
  const me = await orgMe(user.accessToken, slug)
  return (
    <section className='card stack'>
      <Notice q={q} />
      <p>{me.isOwner ? 'You own this org.' : `Your role here: ${me.role?.name || 'none'}.`}</p>
      <p className='muted'>Use the tabs above to see its teams{me.isOwner ? ', people, roles and settings' : ''}.</p>
      {!me.isOwner && (
        <form action={leaveOrg}>
          <input type='hidden' name='slug' value={slug} />
          <button className='btn ghost danger'>Leave {me.org.name}</button>
        </form>)}
    </section>
  )
}
```

Replace `web/app/dashboard/page.js` with:

```js
import { headers, cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Header from '@/components/Header.js'
import NewAgent from '@/components/NewAgent.js'
import SpaceSwitcher from '@/components/SpaceSwitcher.js'
import { requireUser } from '@/lib/session.js'
import { createClient } from '@/lib/supabase/server.js'
import { apiCall } from '@/lib/api.js'
import { myOrgs } from '@/lib/org.js'
import { SPACE_COOKIE, spaceHome } from '@/lib/space.js'
import { when } from '@/lib/org-view.js'
import { downloadFor, DOWNLOADS } from '@/lib/platform.js'
import { unlinkComputer, revokeAgent } from './actions.js'

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
  const { data: computers } = await supabase.from('devices').select('id, name, platform, last_seen_at, revoked_at').is('revoked_at', null).order('last_seen_at', { ascending: false })
  const agentsRes = await apiCall(user, 'GET', '/v1/agents')
  const agents = (agentsRes.data?.agents || []).filter((a) => !a.revokedAt)
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
          <p className='muted'>Coming soon: agents will be able to join sessions as their own members, with an agent badge.</p>
          {!agentsRes.ok && <p className='notice bad'>Couldn’t load your agents right now.</p>}
          {agents.map((a) => (
            <div key={a.id} className='row' style={{ justifyContent: 'space-between' }}>
              <span><b>{a.name}</b> <span className='muted mono'>{a.keyPrefix}…</span> <span className='muted'>· last used {when(a.lastUsedAt)}</span></span>
              <form action={revokeAgent}><input type='hidden' name='id' value={a.id} /><button className='btn ghost danger'>Revoke</button></form>
            </div>))}
          <NewAgent />
        </section>
      </main>
    </>
  )
}
```

In `web/proxy.js`, change the `PRIVATE` line to:

```js
const PRIVATE = ['/dashboard', '/settings', '/link', '/reset', '/org', '/orgs', '/invite']
```

Append to `web/app/globals.css`:

```css
/* Org area */
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.space-switcher .input { height: 38px; min-width: 180px; }
.tabs { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid var(--border); }
.tabs a { padding: 8px 12px; color: var(--muted); text-decoration: none; font-weight: 500; }
.tabs a:hover { color: var(--text); }
.list-row { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; padding: 10px 0; border-top: 1px solid var(--border); }
.list-row:first-of-type { border-top: 0; }
```

- [ ] **Step 6: Run to see them pass**

Run: `node --test test/permissions-sync.test.js && cd web && npm test`
Expected: PASS, `# fail 0` (the route test builds the site, so compile errors in the new pages show up here).

- [ ] **Step 7: Check it in the browser**

Run the memory API (`node bin/quilt.js api --memory --port 8787`) and the site (`cd web && QUILT_API_URL=http://127.0.0.1:8787 npm run dev`) only if you have a local Supabase sign-in; otherwise this check happens after deploy (Task 14). Expected: the dashboard shows the switcher; "+ Create an org…" opens `/orgs/new`; creating one lands on `/org/<slug>` with Overview and the tabs for your role.

- [ ] **Step 8: Commit**

```bash
git add test/permissions-sync.test.js web/lib/permissions.js web/lib/space.js web/lib/space-cookie.js web/lib/org.js web/lib/org-view.js web/lib/validate.js web/components/SpaceSwitcher.js web/components/Notice.js web/app/spaces web/app/orgs web/app/org web/app/dashboard/page.js web/proxy.js web/app/globals.css web/test
git commit -m "Add the space switcher, org creation and the Org area shell"
```

---

### Task 10: Website — "Just me / A team" sign-up and the first org

**Files:**
- Create: `web/lib/signup.js`, `web/components/FirstOrg.js`, `web/test/signup.test.js`
- Modify: `web/app/signup/SignUpForm.js` (whole file below), `web/lib/session.js`, `web/app/dashboard/actions.js`, `web/app/dashboard/page.js`, `web/app/globals.css`, `web/test/routes.test.js`

**Interfaces:**
- Consumes: `isValidOrgName` (Task 9), `rememberSpace` (Task 9), `myOrgs` (Task 9), API `GET/POST /v1/orgs`.
- Produces: `signUpData({ name, kind: 'me'|'team', orgName }) -> { name } | { name, org_name } | null` (null when a team sign-up has no valid org name); `currentUser()` now also returns `orgName` (from `user_metadata.org_name`); server actions `createFirstOrg() -> { slug } | { error }`, `dismissFirstOrg()`; `<FirstOrg name />` which creates the org once on mount and then opens it.

- [ ] **Step 1: Write the failing tests**

Create `web/test/signup.test.js`:

```js
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
```

In `web/test/routes.test.js`, replace the sign-up test with:

```js
test('the sign-up page renders with a password field and the just-me / team choice', async () => {
  const html = await (await get('/signup')).text()
  assert.match(html, /type="password"/)
  assert.match(html, /Just me/)
  assert.match(html, /A team/)
})
```

- [ ] **Step 2: Run to see them fail**

Run: `cd web && npm test`
Expected: FAIL — `lib/signup.js` is missing and the sign-up page has no "Just me".

- [ ] **Step 3: Implement the sign-up choice**

Create `web/lib/signup.js`:

```js
// Pure — no Next imports — so it can be unit-tested directly.
import { isValidOrgName } from './validate.js'

/** The metadata a new account starts with. A team sign-up carries its org's name until the org is made. */
export function signUpData ({ name, kind, orgName }) {
  const data = { name: String(name || '').trim().slice(0, 60) }
  if (kind !== 'team') return data
  const org = String(orgName || '').trim()
  return isValidOrgName(org) ? { ...data, org_name: org } : null
}
```

Replace `web/app/signup/SignUpForm.js` with:

```js
'use client'
// Client-side (not a server action) so Supabase's per-IP sign-up rate limit
// sees each visitor's own IP rather than Netlify's shared one.
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client.js'
import { isValidEmail, isValidPassword } from '@/lib/validate.js'
import { safeNext } from '@/lib/safe-next.js'
import { signUpData } from '@/lib/signup.js'

const ERRORS = {
  name: 'Enter your name.',
  org: 'Enter your org’s name (up to 80 characters).',
  email: 'That email doesn’t look right.',
  password: 'Password must be 8–72 characters.',
  weak_password: 'Choose a stronger password — longer, or mix in numbers and symbols.',
  taken: 'That email already has an account. Sign in instead.',
  generic: 'Something went wrong. Try again.'
}

export default function SignUpForm ({ next }) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [kind, setKind] = useState('me')

  async function onSubmit (e) {
    e.preventDefault()
    const form = e.currentTarget
    const name = form.name.value.trim().slice(0, 60)
    const email = form.email.value.trim()
    const password = form.password.value
    if (!name) { setError('name'); return }
    const data = signUpData({ name, kind, orgName: kind === 'team' ? form.org.value : '' })
    if (!data) { setError('org'); return }
    if (!isValidEmail(email)) { setError('email'); return }
    if (!isValidPassword(password)) { setError('password'); return }
    setError(null)
    setBusy(true)
    const { data: res, error: err } = await createClient().auth.signUp({
      email,
      password,
      options: { data, emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(safeNext(next))}` }
    })
    setBusy(false)
    if (err) { setError(err.code === 'user_already_exists' ? 'taken' : err.code === 'weak_password' ? 'weak_password' : 'generic'); return }
    // Supabase doesn't return a clean "already registered" error — a repeat signup
    // comes back as a user with no identities instead.
    if (res.user && (res.user.identities || []).length === 0) { setError('taken'); return }
    if (res.session) { window.location.assign(safeNext(next)); return }
    setSent(true)
  }

  if (sent) {
    return (
      <p className='notice'>
        Check your email to confirm your account.{kind === 'team' ? ' Your org is set up the first time you open your dashboard.' : ''}
      </p>
    )
  }

  return (
    <form onSubmit={onSubmit} className='stack'>
      <fieldset className='choice'>
        <legend>Who’s it for?</legend>
        <label><input type='radio' name='kind' value='me' checked={kind === 'me'} onChange={() => setKind('me')} /> Just me</label>
        <label><input type='radio' name='kind' value='team' checked={kind === 'team'} onChange={() => setKind('team')} /> A team</label>
      </fieldset>
      {kind === 'team' && (
        <div className='field'>
          <label htmlFor='org'>Org name</label>
          <input className='input' id='org' name='org' maxLength={80} required placeholder='e.g. Acme' />
        </div>)}
      <div className='field'>
        <label htmlFor='name'>Your name</label>
        <input className='input' id='name' name='name' autoComplete='name' maxLength={60} required />
      </div>
      <div className='field'>
        <label htmlFor='email'>Email</label>
        <input className='input' id='email' name='email' type='email' autoComplete='email' required />
      </div>
      <div className='field'>
        <label htmlFor='password'>Password</label>
        <input className='input' id='password' name='password' type='password' autoComplete='new-password' minLength={8} maxLength={72} required />
      </div>
      <button className='btn primary' disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      {error && <p className='notice bad'>{ERRORS[error] || ERRORS.generic}</p>}
    </form>
  )
}
```

Append to `web/app/globals.css`:

```css
.choice { border: 0; padding: 0; margin: 0; display: flex; gap: 8px; flex-wrap: wrap; }
.choice legend { font-size: 13px; font-weight: 500; color: var(--muted); margin-bottom: 6px; padding: 0; }
.choice label { flex: 1 1 140px; display: flex; gap: 8px; align-items: center; padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: 8px; cursor: pointer; font-weight: 500; }
.choice label:has(input:checked) { border-color: var(--accent); background: var(--panel-2); }
```

- [ ] **Step 4: Create the first org on the first dashboard visit**

In `web/lib/session.js`, change the `return` line of `currentUser` to:

```js
  return { id: user.id, email: user.email, identities: user.identities || [], orgName: user.user_metadata?.org_name || null, accessToken: session?.access_token }
```

In `web/app/dashboard/actions.js`, add to the imports:

```js
import { rememberSpace } from '@/lib/space-cookie.js'
```

and append:

```js
// "A team" sign-ups carry their org's name in the account until the org exists.
// Only for people in no org yet (not, say, someone who accepted an invite first).
export async function createFirstOrg () {
  const user = await requireUser('/dashboard')
  if (!user.orgName) return { error: 'There’s no org waiting to be created.' }
  const mine = await apiCall(user, 'GET', '/v1/orgs')
  if (!mine.ok) return { error: 'Couldn’t reach Quilt. Try again.' }
  let slug = mine.data.orgs[0]?.slug
  if (!slug) {
    const made = await apiCall(user, 'POST', '/v1/orgs', { name: user.orgName })
    if (!made.ok) return { error: made.data?.error || 'Couldn’t create your org. Try again.' }
    slug = made.data.org.slug
  }
  await clearOrgName()
  await rememberSpace(slug)
  return { slug }
}

export async function dismissFirstOrg () {
  await requireUser('/dashboard')
  await clearOrgName()
  revalidatePath('/dashboard')
}

async function clearOrgName () {
  const supabase = await createClient()
  await supabase.auth.updateUser({ data: { org_name: null } })
}
```

Create `web/components/FirstOrg.js`:

```js
'use client'
import { useEffect, useRef, useState } from 'react'
import { createFirstOrg, dismissFirstOrg } from '@/app/dashboard/actions.js'

// Makes the org a "A team" sign-up asked for, once, then opens it.
export default function FirstOrg ({ name }) {
  const started = useRef(false)
  const [error, setError] = useState(null)

  async function run () {
    setError(null)
    const r = await createFirstOrg()
    if (r?.slug) window.location.assign(`/org/${r.slug}`)
    else setError(r?.error || 'Couldn’t create your org. Try again.')
  }

  // React may run effects twice in development; the ref keeps it to one org.
  useEffect(() => {
    if (started.current) return
    started.current = true
    run()
  }, [])

  return (
    <section className='card stack'>
      {error
        ? (
          <>
            <p className='notice bad'>{error}</p>
            <div className='row'>
              <button className='btn primary' onClick={run}>Try again</button>
              <form action={dismissFirstOrg}><button className='btn ghost'>Not now</button></form>
            </div>
          </>)
        : <p className='muted'>Setting up {name}…</p>}
    </section>
  )
}
```

In `web/app/dashboard/page.js`, add the import:

```js
import FirstOrg from '@/components/FirstOrg.js'
```

and directly after the line `{q.orgDeleted && <p className='notice'>The org was deleted.</p>}` add:

```js
        {!orgs.length && user.orgName && <FirstOrg name={user.orgName} />}
```

- [ ] **Step 5: Run to see them pass**

Run: `cd web && npm test`
Expected: PASS, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add web/lib/signup.js web/lib/session.js web/components/FirstOrg.js web/app/signup/SignUpForm.js web/app/dashboard web/app/globals.css web/test/signup.test.js web/test/routes.test.js
git commit -m "Offer Just me or A team at sign-up and create the team's org on first visit"
```

---
### Task 11: Website — People and Roles (the grid editor)

**Files:**
- Create: `web/lib/org-actions.js`, `web/lib/role-form.js`, `web/components/RoleGrid.js`, `web/app/org/[slug]/people/page.js`, `web/app/org/[slug]/people/actions.js`, `web/app/org/[slug]/roles/page.js`, `web/app/org/[slug]/roles/actions.js`, `web/test/role-form.test.js`
- Modify: `web/lib/org-view.js`, `web/app/globals.css`, `web/test/org-view.test.js`, `web/test/routes.test.js`

**Interfaces:**
- Consumes: `orgMe`, `allowed`, `Notice`, `isSlug` (Task 9); `RESOURCES`, `ALLOWED`, `OPS`, `LABELS`, `can`, `isSubset`, `normalizeGrants` (`web/lib/permissions.js`); API `GET /v1/orgs/:slug/members`, `PUT/DELETE /v1/orgs/:slug/members/:id`, `GET/POST /v1/orgs/:slug/roles`, `PUT/DELETE /v1/orgs/:slug/roles/:id`.
- Produces:
  - `web/lib/org-actions.js` (server-only): `enc(v) -> string`; `orgAction(formData, page, method, path, body)` — reads `slug` from the form, calls `/v1/orgs/<slug><path>`, revalidates and redirects to `/org/<slug>/<page>?saved=1` or `?error=<message>`.
  - `web/lib/role-form.js`: `grantsFromForm(formData) -> grants` (checkboxes named `g.<resource>.<op>`).
  - `web/lib/org-view.js`: `assignableRoles(roles, me) -> Role[]` (never Owner; only within the viewer's grid).
  - `<RoleGrid grants mine isOwner readOnly />`: one row per resource, C/R/U/D columns, blank cells where the spec has "—", checkboxes you don't hold disabled.
  - Pages `/org/[slug]/people` (Members: Read) and `/org/[slug]/roles` (Roles: Read).

- [ ] **Step 1: Write the failing tests**

Create `web/test/role-form.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { grantsFromForm } from '../lib/role-form.js'

test('grantsFromForm reads the checked boxes and ignores everything else', () => {
  const f = new FormData()
  f.append('slug', 'acme')
  f.append('name', 'Lead')
  f.append('g.teams.c', 'on')
  f.append('g.teams.r', 'on')
  f.append('g.org.c', 'on')
  f.append('g.members.d', 'off')
  f.append('g.__proto__.r', 'on')
  f.append('g.billing.r', 'on')
  assert.deepEqual(grantsFromForm(f), { teams: { c: true, r: true } })
  assert.equal({}.r, undefined, 'nothing leaks onto Object.prototype')
})
```

Append to `web/test/org-view.test.js` (and add `assignableRoles` to its import):

```js
test('assignableRoles: never Owner, and only roles within your own grid', () => {
  const roles = [
    { id: 'o', builtin: 'owner', grants: {} },
    { id: 'a', builtin: 'admin', grants: { roles: { r: true, u: true }, members: { d: true } } },
    { id: 'm', builtin: 'member', grants: { teams: { r: true } } },
    { id: 'l', builtin: null, grants: { teams: { r: true, c: true } } }
  ]
  assert.deepEqual(assignableRoles(roles, owner).map((r) => r.id), ['a', 'm', 'l'])
  const lead = { isOwner: false, grants: { teams: { r: true, c: true }, roles: { r: true, u: true } } }
  assert.deepEqual(assignableRoles(roles, lead).map((r) => r.id), ['m', 'l'])
  assert.deepEqual(assignableRoles(undefined, lead), [])
})
```

In `web/test/routes.test.js`, add `'/org/acme/people', '/org/acme/roles'` to the private-pages list.

- [ ] **Step 2: Run to see them fail**

Run: `cd web && npm test`
Expected: FAIL — `lib/role-form.js` is missing and `assignableRoles` is not exported.

- [ ] **Step 3: Implement the helpers**

In `web/lib/org-view.js`, change the import to `import { can, isSubset } from './permissions.js'` and append:

```js

/** Roles the viewer may hand out: never Owner, and only within their own grid. */
export function assignableRoles (roles, me) {
  return (roles || []).filter((r) => r.builtin !== 'owner' && (me.isOwner || isSubset(r.grants, me.grants)))
}
```

Create `web/lib/role-form.js`:

```js
// Pure: reads the role grid's checkboxes (named g.<resource>.<op>) from a submitted form.
import { RESOURCES, normalizeGrants } from './permissions.js'

export function grantsFromForm (formData) {
  const raw = {}
  for (const [key, value] of formData.entries()) {
    const m = /^g\.([a-z_]+)\.([crud])$/.exec(key)
    // Only known rows, so a crafted field name can't touch Object.prototype.
    if (m && value === 'on' && RESOURCES.includes(m[1])) (raw[m[1]] ||= {})[m[2]] = true
  }
  return normalizeGrants(raw)
}
```

Create `web/lib/org-actions.js`:

```js
import 'server-only'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from './session.js'
import { apiCall } from './api.js'
import { isSlug } from './space.js'

export const enc = (v) => encodeURIComponent(String(v ?? ''))

/** One org API call from a form, then back to the page with "Saved." or the API's reason. */
export async function orgAction (formData, page, method, path, body) {
  const slug = String(formData.get('slug') || '')
  if (!isSlug(slug)) redirect('/dashboard')
  const back = page ? `/org/${slug}/${page}` : `/org/${slug}`
  const user = await requireUser(back)
  const r = await apiCall(user, method, `/v1/orgs/${slug}${path}`, body)
  revalidatePath(back)
  redirect(`${back}?${r.ok ? 'saved=1' : `error=${encodeURIComponent(r.data?.error || 'Something went wrong. Try again.')}`}`)
}
```

- [ ] **Step 4: The grid component**

Create `web/components/RoleGrid.js`:

```js
import { RESOURCES, ALLOWED, OPS, LABELS, can } from '@/lib/permissions.js'

const OP_LABELS = { c: 'Create', r: 'Read', u: 'Update', d: 'Delete' }

// One row per resource, one checkbox per op the spec allows (other cells stay blank).
// You can't tick what you don't hold yourself — the API refuses it anyway.
export default function RoleGrid ({ grants, mine, isOwner = false, readOnly = false }) {
  return (
    <table className='grid-table'>
      <thead>
        <tr><th scope='col'>Permission</th>{OPS.map((op) => <th key={op} scope='col'>{OP_LABELS[op]}</th>)}</tr>
      </thead>
      <tbody>
        {RESOURCES.map((res) => (
          <tr key={res}>
            <th scope='row'>{LABELS[res]}{!ALLOWED[res].length && <span className='muted'> · coming with per-seat plans</span>}</th>
            {OPS.map((op) => (
              <td key={op}>
                {ALLOWED[res].includes(op) && (
                  <input
                    type='checkbox'
                    name={`g.${res}.${op}`}
                    aria-label={`${LABELS[res]}: ${OP_LABELS[op]}`}
                    defaultChecked={can(grants, res, op)}
                    disabled={readOnly || !(isOwner || can(mine, res, op))}
                  />)}
              </td>))}
          </tr>))}
      </tbody>
    </table>
  )
}
```

Append to `web/app/globals.css`:

```css
.table-scroll { overflow-x: auto; }
.grid-table { border-collapse: collapse; width: 100%; min-width: 420px; }
.grid-table th, .grid-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: center; }
.grid-table th[scope='row'], .grid-table thead th:first-child { text-align: left; font-weight: 500; }
.grid-table input { width: 18px; height: 18px; accent-color: var(--accent); }
```

- [ ] **Step 5: The People page**

Create `web/app/org/[slug]/people/actions.js`:

```js
'use server'
import { orgAction, enc } from '@/lib/org-actions.js'

export async function setRole (formData) {
  await orgAction(formData, 'people', 'PUT', `/members/${enc(formData.get('id'))}`, { roleId: String(formData.get('roleId') || '') })
}

export async function removeMember (formData) {
  await orgAction(formData, 'people', 'DELETE', `/members/${enc(formData.get('id'))}`)
}
```

Create `web/app/org/[slug]/people/page.js`:

```js
import { notFound } from 'next/navigation'
import Notice from '@/components/Notice.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgMe } from '@/lib/org.js'
import { allowed, assignableRoles } from '@/lib/org-view.js'
import { setRole, removeMember } from './actions.js'
import { leaveOrg } from '../actions.js'

export const metadata = { title: 'People' }

export default async function People ({ params, searchParams }) {
  const { slug } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}/people`)
  const me = await orgMe(user.accessToken, slug)
  if (!allowed(me, 'members', 'r')) notFound()
  // Changing someone's role is Members: Update together with Roles: Update.
  const canAssign = allowed(me, 'members', 'u') && allowed(me, 'roles', 'u')
  const canRemove = allowed(me, 'members', 'd')
  const [membersRes, rolesRes] = await Promise.all([
    apiCall(user, 'GET', `/v1/orgs/${slug}/members`),
    canAssign ? apiCall(user, 'GET', `/v1/orgs/${slug}/roles`) : null
  ])
  const members = membersRes.data?.members || []
  const roles = assignableRoles(rolesRes?.data?.roles, me)
  return (
    <section className='card stack'>
      <h2>People</h2>
      <Notice q={q} />
      {!membersRes.ok && <p className='notice bad'>Couldn’t load the member list right now.</p>}
      <div>
        {members.map((m) => (
          <div key={m.id} className='list-row'>
            <span>
              <b>{m.name || m.email}</b> {m.isYou && <span className='pill'>You</span>} {m.isOwner && <span className='pill'>Owner</span>}
              <br />
              <span className='muted'>{m.email}{m.teams.length ? ` · ${m.teams.map((t) => t.name).join(', ')}` : ''}</span>
            </span>
            <span className='row'>
              {canAssign && !m.isOwner && !m.isYou && roles.some((r) => r.id === m.roleId)
                ? (
                  <form action={setRole} className='row'>
                    <input type='hidden' name='slug' value={slug} />
                    <input type='hidden' name='id' value={m.id} />
                    <select className='input' name='roleId' defaultValue={m.roleId} aria-label={`Role for ${m.name || m.email}`}>
                      {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                    <button className='btn ghost'>Save</button>
                  </form>)
                : <span className='pill'>{m.role || 'No role'}</span>}
              {m.isYou && !m.isOwner && (
                <form action={leaveOrg}><input type='hidden' name='slug' value={slug} /><button className='btn ghost danger'>Leave</button></form>)}
              {canRemove && !m.isYou && !m.isOwner && (
                <form action={removeMember}>
                  <input type='hidden' name='slug' value={slug} />
                  <input type='hidden' name='id' value={m.id} />
                  <button className='btn ghost danger'>Remove</button>
                </form>)}
            </span>
          </div>))}
      </div>
    </section>
  )
}
```

- [ ] **Step 6: The Roles page**

Create `web/app/org/[slug]/roles/actions.js`:

```js
'use server'
import { orgAction, enc } from '@/lib/org-actions.js'
import { grantsFromForm } from '@/lib/role-form.js'

export async function createRole (formData) {
  await orgAction(formData, 'roles', 'POST', '/roles', { name: String(formData.get('name') || ''), grants: grantsFromForm(formData) })
}

export async function saveRole (formData) {
  const body = { grants: grantsFromForm(formData) }
  // Built-in roles have no name field; the API keeps their names.
  if (formData.has('name')) body.name = String(formData.get('name'))
  await orgAction(formData, 'roles', 'PUT', `/roles/${enc(formData.get('id'))}`, body)
}

export async function deleteRole (formData) {
  await orgAction(formData, 'roles', 'DELETE', `/roles/${enc(formData.get('id'))}`)
}
```

Create `web/app/org/[slug]/roles/page.js`:

```js
import { notFound } from 'next/navigation'
import Notice from '@/components/Notice.js'
import RoleGrid from '@/components/RoleGrid.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgMe } from '@/lib/org.js'
import { allowed } from '@/lib/org-view.js'
import { isSubset } from '@/lib/permissions.js'
import { createRole, saveRole, deleteRole } from './actions.js'

export const metadata = { title: 'Roles' }

export default async function Roles ({ params, searchParams }) {
  const { slug } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}/roles`)
  const me = await orgMe(user.accessToken, slug)
  if (!allowed(me, 'roles', 'r')) notFound()
  const r = await apiCall(user, 'GET', `/v1/orgs/${slug}/roles`)
  const roles = r.data?.roles || []
  // You can only edit roles whose checkboxes you hold yourself.
  const editable = (role) => allowed(me, 'roles', 'u') && (me.isOwner || isSubset(role.grants, me.grants))
  return (
    <div className='stack'>
      <Notice q={q} />
      {!r.ok && <p className='notice bad'>Couldn’t load roles right now.</p>}
      {roles.map((role) => role.builtin === 'owner'
        ? (
          <section key={role.id} className='card stack'>
            <h3>Owner</h3>
            <p className='muted'>Every permission, plus transferring and deleting the org. There’s exactly one owner, and this role can’t be edited.</p>
          </section>)
        : (
          <form key={role.id} action={saveRole} className='card stack'>
            <input type='hidden' name='slug' value={slug} />
            <input type='hidden' name='id' value={role.id} />
            <div className='row' style={{ justifyContent: 'space-between' }}>
              {role.builtin || !editable(role)
                ? <h3>{role.name}</h3>
                : <input className='input' name='name' defaultValue={role.name} maxLength={40} aria-label='Role name' />}
              {role.builtin && <span className='pill'>Built in</span>}
            </div>
            <div className='table-scroll'><RoleGrid grants={role.grants} mine={me.grants} isOwner={me.isOwner} readOnly={!editable(role)} /></div>
            {editable(role) && (
              <div className='row'>
                <button className='btn primary'>Save</button>
                {allowed(me, 'roles', 'd') && !role.builtin && <button className='btn ghost danger' formAction={deleteRole}>Delete role</button>}
              </div>)}
          </form>))}
      {allowed(me, 'roles', 'c') && (
        <form action={createRole} className='card stack'>
          <h3>New role</h3>
          <input type='hidden' name='slug' value={slug} />
          <div className='field'>
            <label htmlFor='new-role'>Name</label>
            <input className='input' id='new-role' name='name' maxLength={40} required />
          </div>
          <div className='table-scroll'><RoleGrid grants={{}} mine={me.grants} isOwner={me.isOwner} /></div>
          <div><button className='btn primary'>Create role</button></div>
        </form>)}
    </div>
  )
}
```

- [ ] **Step 7: Run to see them pass**

Run: `cd web && npm test`
Expected: PASS, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add web/lib/org-actions.js web/lib/role-form.js web/lib/org-view.js web/components/RoleGrid.js web/app/org web/app/globals.css web/test
git commit -m "Add the People page and the role grid editor"
```

---

### Task 12: Website — Teams

**Files:**
- Create: `web/app/org/[slug]/teams/page.js`, `web/app/org/[slug]/teams/actions.js`
- Modify: `web/lib/org-view.js`, `web/test/org-view.test.js`, `web/test/routes.test.js`

**Interfaces:**
- Consumes: `orgMe`, `allowed`, `Notice` (Task 9); `orgAction`, `enc` (Task 11); API `GET/POST /v1/orgs/:slug/teams`, `PUT/DELETE /v1/orgs/:slug/teams/:id`, `POST /v1/orgs/:slug/teams/:id/members`, `PUT/DELETE /v1/orgs/:slug/teams/:id/members/:memberId` (Task 6).
- Produces: `peopleNotIn(people, members) -> people[]` in `web/lib/org-view.js`; server actions `createTeam`, `renameTeam`, `deleteTeam`, `addToTeam`, `setTeamAccess`, `removeFromTeam`; page `/org/[slug]/teams`.

- [ ] **Step 1: Write the failing test**

Append to `web/test/org-view.test.js` (and add `peopleNotIn` to its import):

```js
test('peopleNotIn leaves out people already in the team', () => {
  const people = [{ memberId: 'a', name: 'Ada' }, { memberId: 'b', name: 'Bo' }]
  assert.deepEqual(peopleNotIn(people, [{ memberId: 'a', access: 'editor' }]), [{ memberId: 'b', name: 'Bo' }])
  assert.deepEqual(peopleNotIn(people, null), people)
  assert.deepEqual(peopleNotIn(null, []), [])
})
```

In `web/test/routes.test.js`, add `'/org/acme/teams'` to the private-pages list.

- [ ] **Step 2: Run to see it fail**

Run: `cd web && npm test`
Expected: FAIL — `peopleNotIn` is not exported.

- [ ] **Step 3: Implement**

Append to `web/lib/org-view.js`:

```js

/** The org's people who aren't in this team yet, for the "add" picker. */
export function peopleNotIn (people, members) {
  const inTeam = new Set((members || []).map((m) => m.memberId))
  return (people || []).filter((p) => !inTeam.has(p.memberId))
}
```

Create `web/app/org/[slug]/teams/actions.js`:

```js
'use server'
import { orgAction, enc } from '@/lib/org-actions.js'

const team = (formData) => `/teams/${enc(formData.get('id'))}`

export async function createTeam (formData) {
  await orgAction(formData, 'teams', 'POST', '/teams', { name: String(formData.get('name') || '') })
}

export async function renameTeam (formData) {
  await orgAction(formData, 'teams', 'PUT', team(formData), { name: String(formData.get('name') || '') })
}

export async function deleteTeam (formData) {
  await orgAction(formData, 'teams', 'DELETE', team(formData))
}

export async function addToTeam (formData) {
  await orgAction(formData, 'teams', 'POST', `${team(formData)}/members`, { memberId: String(formData.get('memberId') || ''), access: String(formData.get('access') || 'viewer') })
}

export async function setTeamAccess (formData) {
  await orgAction(formData, 'teams', 'PUT', `${team(formData)}/members/${enc(formData.get('memberId'))}`, { access: String(formData.get('access') || '') })
}

export async function removeFromTeam (formData) {
  await orgAction(formData, 'teams', 'DELETE', `${team(formData)}/members/${enc(formData.get('memberId'))}`)
}
```

Create `web/app/org/[slug]/teams/page.js`:

```js
import Notice from '@/components/Notice.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgMe } from '@/lib/org.js'
import { allowed, peopleNotIn } from '@/lib/org-view.js'
import { createTeam, renameTeam, deleteTeam, addToTeam, setTeamAccess, removeFromTeam } from './actions.js'

export const metadata = { title: 'Teams' }

function Hidden ({ slug, id, memberId }) {
  return (
    <>
      <input type='hidden' name='slug' value={slug} />
      {id && <input type='hidden' name='id' value={id} />}
      {memberId && <input type='hidden' name='memberId' value={memberId} />}
    </>
  )
}

function AccessSelect ({ value }) {
  return (
    <select className='input' name='access' defaultValue={value} aria-label='Access'>
      <option value='editor'>Editor</option>
      <option value='viewer'>Viewer</option>
    </select>
  )
}

export default async function Teams ({ params, searchParams }) {
  const { slug } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}/teams`)
  const me = await orgMe(user.accessToken, slug)
  const r = await apiCall(user, 'GET', `/v1/orgs/${slug}/teams`)
  const teams = r.data?.teams || []
  const people = r.data?.people || null
  const c = (resource, op) => allowed(me, resource, op)
  return (
    <div className='stack'>
      <Notice q={q} />
      {!r.ok && <p className='notice bad'>Couldn’t load teams right now.</p>}
      {r.ok && !teams.length && <p className='muted'>{c('teams', 'c') ? 'No teams yet. Make one below.' : 'You’re not in any teams yet.'}</p>}
      {teams.map((t) => {
        const addable = people ? peopleNotIn(people, t.members) : []
        return (
          <section key={t.id} className='card stack'>
            <div className='row' style={{ justifyContent: 'space-between' }}>
              {c('teams', 'u')
                ? (
                  <form action={renameTeam} className='row'>
                    <Hidden slug={slug} id={t.id} />
                    <input className='input' name='name' defaultValue={t.name} maxLength={60} aria-label='Team name' />
                    <button className='btn ghost'>Rename</button>
                  </form>)
                : <h3>{t.name}</h3>}
              <span className='row'>
                {t.access && <span className='pill'>You: {t.access}</span>}
                {c('teams', 'd') && <form action={deleteTeam}><Hidden slug={slug} id={t.id} /><button className='btn ghost danger'>Delete team</button></form>}
              </span>
            </div>
            {t.members === null
              ? <p className='muted'>You can’t see who’s in this team.</p>
              : t.members.length
                ? (
                  <div>
                    {t.members.map((m) => (
                      <div key={m.memberId} className='list-row'>
                        <b>{m.name}</b>
                        <span className='row'>
                          {c('team_members', 'u')
                            ? (
                              <form action={setTeamAccess} className='row'>
                                <Hidden slug={slug} id={t.id} memberId={m.memberId} />
                                <AccessSelect value={m.access} />
                                <button className='btn ghost'>Save</button>
                              </form>)
                            : <span className='pill'>{m.access}</span>}
                          {c('team_members', 'd') && (
                            <form action={removeFromTeam}><Hidden slug={slug} id={t.id} memberId={m.memberId} /><button className='btn ghost danger'>Remove</button></form>)}
                        </span>
                      </div>))}
                  </div>)
                : <p className='muted'>No one in this team yet.</p>}
            {addable.length > 0 && (
              <form action={addToTeam} className='row'>
                <Hidden slug={slug} id={t.id} />
                <select className='input' name='memberId' aria-label='Person to add'>
                  {addable.map((p) => <option key={p.memberId} value={p.memberId}>{p.name}</option>)}
                </select>
                <AccessSelect value='viewer' />
                <button className='btn'>Add to team</button>
              </form>)}
          </section>
        )
      })}
      {c('teams', 'c') && (
        <form action={createTeam} className='card row'>
          <Hidden slug={slug} />
          <input className='input' name='name' maxLength={60} placeholder='New team name' aria-label='New team name' required style={{ flex: '1 1 220px' }} />
          <button className='btn primary'>Create team</button>
        </form>)}
    </div>
  )
}
```

- [ ] **Step 4: Run to see them pass**

Run: `cd web && npm test`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add web/lib/org-view.js web/app/org web/test
git commit -m "Add the Teams page: teams and who's in them"
```

---

### Task 13: Website — Invites and requests, Settings, accepting an invite, asking to join

**Files:**
- Create: `web/app/org/[slug]/invites/page.js`, `web/app/org/[slug]/invites/actions.js`, `web/app/org/[slug]/settings/page.js`, `web/app/org/[slug]/settings/actions.js`, `web/app/invite/[token]/page.js`, `web/app/invite/[token]/actions.js`
- Modify: `web/lib/org-view.js`, `web/app/dashboard/page.js`, `web/app/dashboard/actions.js`, `web/test/org-view.test.js`, `web/test/routes.test.js`

**Interfaces:**
- Consumes: `orgMe`, `allowed`, `when`, `assignableRoles`, `Notice`, `orgAction`, `enc`, `rememberSpace`, `PERSONAL`, `isSlug` (Tasks 9, 11); API routes from Tasks 5 and 7.
- Produces: `inviteGone(status) -> string | null` in `web/lib/org-view.js`; server actions `sendInvite`, `resendInvite`, `cancelInvite`, `approveRequest`, `denyRequest`, `saveSettings`, `transferOwnership`, `deleteOrg`, `acceptInvite`, `askToJoin`; pages `/org/[slug]/invites` (User invites: Read), `/org/[slug]/settings` (Org settings: Read), `/invite/[token]`; a dashboard section "Orgs at <domain>" with "Ask to join".

- [ ] **Step 1: Write the failing test**

Append to `web/test/org-view.test.js` (and add `inviteGone` to its import):

```js
test('inviteGone explains an invite that can no longer be used', () => {
  assert.equal(inviteGone('pending'), null)
  assert.equal(inviteGone('accepted'), 'This invite was already used.')
  assert.equal(inviteGone('cancelled'), 'This invite was cancelled.')
  assert.equal(inviteGone('expired'), 'This invite has expired. Ask for a new one.')
  assert.equal(inviteGone('toString'), null)
})
```

In `web/test/routes.test.js`, add `'/org/acme/invites', '/org/acme/settings'` to the private-pages list.

- [ ] **Step 2: Run to see it fail**

Run: `cd web && npm test`
Expected: FAIL — `inviteGone` is not exported from `lib/org-view.js`.

- [ ] **Step 3: Add `inviteGone`**

Append to `web/lib/org-view.js`:

```js

const GONE = { accepted: 'This invite was already used.', cancelled: 'This invite was cancelled.', expired: 'This invite has expired. Ask for a new one.' }
/** Why an invite can't be used any more (null while it's pending). */
export function inviteGone (status) {
  return Object.hasOwn(GONE, status) ? GONE[status] : null
}
```

- [ ] **Step 4: Invites and requests**

Create `web/app/org/[slug]/invites/actions.js`:

```js
'use server'
import { orgAction, enc } from '@/lib/org-actions.js'

// An empty role means "Member" to the API.
const roleOf = (formData) => String(formData.get('roleId') || '') || undefined

export async function sendInvite (formData) {
  await orgAction(formData, 'invites', 'POST', '/invites', { email: String(formData.get('email') || ''), roleId: roleOf(formData) })
}

export async function resendInvite (formData) {
  await orgAction(formData, 'invites', 'POST', `/invites/${enc(formData.get('id'))}/resend`, {})
}

export async function cancelInvite (formData) {
  await orgAction(formData, 'invites', 'DELETE', `/invites/${enc(formData.get('id'))}`)
}

export async function approveRequest (formData) {
  await orgAction(formData, 'invites', 'POST', `/requests/${enc(formData.get('id'))}`, { approve: true, roleId: roleOf(formData) })
}

export async function denyRequest (formData) {
  await orgAction(formData, 'invites', 'POST', `/requests/${enc(formData.get('id'))}`, { approve: false })
}
```

Create `web/app/org/[slug]/invites/page.js`:

```js
import { notFound } from 'next/navigation'
import Notice from '@/components/Notice.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgMe } from '@/lib/org.js'
import { allowed, assignableRoles, when } from '@/lib/org-view.js'
import { sendInvite, resendInvite, cancelInvite, approveRequest, denyRequest } from './actions.js'

export const metadata = { title: 'Invites' }

export default async function Invites ({ params, searchParams }) {
  const { slug } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}/invites`)
  const me = await orgMe(user.accessToken, slug)
  if (!allowed(me, 'invites', 'r')) notFound()
  const canInvite = allowed(me, 'invites', 'c')
  const [r, rolesRes] = await Promise.all([
    apiCall(user, 'GET', `/v1/orgs/${slug}/invites`),
    canInvite ? apiCall(user, 'GET', `/v1/orgs/${slug}/roles`) : null
  ])
  const invites = r.data?.invites || []
  const requests = r.data?.requests || []
  const roles = assignableRoles(rolesRes?.data?.roles, me)
  const memberRole = roles.find((x) => x.builtin === 'member')?.id
  const roleSelect = () => (
    <select className='input' name='roleId' defaultValue={memberRole} aria-label='Role'>
      {roles.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
    </select>
  )
  const hidden = (id) => <><input type='hidden' name='slug' value={slug} /><input type='hidden' name='id' value={id} /></>
  return (
    <div className='stack'>
      <Notice q={q} />
      {!r.ok && <p className='notice bad'>Couldn’t load invites right now.</p>}
      {canInvite && (
        <form action={sendInvite} className='card stack'>
          <h3>Invite someone</h3>
          <input type='hidden' name='slug' value={slug} />
          <div className='row'>
            <input className='input' name='email' type='email' placeholder='name@company.com' aria-label='Email' required style={{ flex: '1 1 240px' }} />
            {roleSelect()}
            <button className='btn primary'>Send invite</button>
          </div>
          <p className='muted'>They get an email with a link that works for 7 days, and join by signing in with that address.</p>
        </form>)}
      <section className='card stack'>
        <h3>Pending invites</h3>
        {invites.length
          ? (
            <div>
              {invites.map((i) => (
                <div key={i.id} className='list-row'>
                  <span><b>{i.email}</b> <span className='pill'>{i.role}</span> <span className='muted'>· {i.expired ? 'expired' : `expires ${when(i.expiresAt)}`}</span></span>
                  <span className='row'>
                    {allowed(me, 'invites', 'u') && <form action={resendInvite}>{hidden(i.id)}<button className='btn ghost'>Resend</button></form>}
                    {allowed(me, 'invites', 'd') && <form action={cancelInvite}>{hidden(i.id)}<button className='btn ghost danger'>Cancel</button></form>}
                  </span>
                </div>))}
            </div>)
          : <p className='muted'>No pending invites.</p>}
      </section>
      <section className='card stack'>
        <h3>Requests to join</h3>
        {requests.length
          ? (
            <div>
              {requests.map((x) => (
                <form key={x.id} action={approveRequest} className='list-row'>
                  {hidden(x.id)}
                  <span><b>{x.name || x.email}</b> <span className='muted'>{x.email}</span></span>
                  <span className='row'>
                    {canInvite && <>{roleSelect()}<button className='btn'>Approve</button></>}
                    {allowed(me, 'invites', 'd') && <button className='btn ghost danger' formAction={denyRequest}>Deny</button>}
                  </span>
                </form>))}
            </div>)
          : <p className='muted'>{me.org.domainRequests ? 'No one is waiting.' : 'People on your email domain can ask to join once it’s turned on in Settings.'}</p>}
      </section>
    </div>
  )
}
```

- [ ] **Step 5: Settings**

Create `web/app/org/[slug]/settings/actions.js`:

```js
'use server'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgAction } from '@/lib/org-actions.js'
import { rememberSpace } from '@/lib/space-cookie.js'
import { PERSONAL, isSlug } from '@/lib/space.js'

export async function saveSettings (formData) {
  await orgAction(formData, 'settings', 'PUT', '', {
    name: String(formData.get('name') || ''),
    domain: String(formData.get('domain') || '').trim() || null,
    domainRequests: formData.get('domainRequests') === 'on'
  })
}

export async function transferOwnership (formData) {
  await orgAction(formData, 'settings', 'POST', '/transfer', { memberId: String(formData.get('memberId') || '') })
}

// Typing the org's address guards against deleting the wrong one.
export async function deleteOrg (formData) {
  const slug = String(formData.get('slug') || '')
  if (!isSlug(slug)) redirect('/dashboard')
  const back = `/org/${slug}/settings`
  const user = await requireUser(back)
  if (String(formData.get('confirm') || '').trim() !== slug) redirect(`${back}?error=${encodeURIComponent(`Type ${slug} to confirm.`)}`)
  const r = await apiCall(user, 'DELETE', `/v1/orgs/${slug}`)
  if (!r.ok) redirect(`${back}?error=${encodeURIComponent(r.data?.error || 'Couldn’t delete the org. Try again.')}`)
  await rememberSpace(PERSONAL)
  redirect('/dashboard?orgDeleted=1')
}
```

Create `web/app/org/[slug]/settings/page.js`:

```js
import { notFound } from 'next/navigation'
import Notice from '@/components/Notice.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgMe } from '@/lib/org.js'
import { allowed } from '@/lib/org-view.js'
import { saveSettings, transferOwnership, deleteOrg } from './actions.js'

export const metadata = { title: 'Org settings' }

export default async function Settings ({ params, searchParams }) {
  const { slug } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}/settings`)
  const me = await orgMe(user.accessToken, slug)
  if (!allowed(me, 'org', 'r')) notFound()
  const canEdit = allowed(me, 'org', 'u')
  const others = me.isOwner
    ? ((await apiCall(user, 'GET', `/v1/orgs/${slug}/members`)).data?.members || []).filter((m) => !m.isYou)
    : []
  const myDomain = String(user.email || '').split('@')[1] || 'yourcompany.com'
  return (
    <div className='stack'>
      <Notice q={q} />
      <form action={saveSettings} className='card stack'>
        <h3>Org settings</h3>
        <input type='hidden' name='slug' value={slug} />
        <fieldset disabled={!canEdit} className='stack' style={{ border: 0, padding: 0, margin: 0 }}>
          <div className='field'>
            <label htmlFor='org-name'>Name</label>
            <input className='input' id='org-name' name='name' defaultValue={me.org.name} maxLength={80} required />
          </div>
          <div className='field'>
            <label htmlFor='org-domain'>Email domain</label>
            <input className='input' id='org-domain' name='domain' defaultValue={me.org.domain || ''} placeholder={myDomain} />
          </div>
          <label className='row'><input type='checkbox' name='domainRequests' defaultChecked={me.org.domainRequests} /> Let people with a confirmed email at this domain ask to join</label>
          <p className='muted'>The domain can only be your own confirmed email’s domain, never a public one like gmail.com. Someone who can send invites approves each request.</p>
          {canEdit && <div><button className='btn primary'>Save</button></div>}
        </fieldset>
      </form>
      {me.isOwner && (
        <>
          <form action={transferOwnership} className='card stack'>
            <h3>Transfer ownership</h3>
            <input type='hidden' name='slug' value={slug} />
            <p className='muted'>The new owner gets every permission and you become an Admin. There’s only ever one owner.</p>
            {others.length
              ? (
                <div className='row'>
                  <select className='input' name='memberId' aria-label='New owner'>
                    {others.map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
                  </select>
                  <button className='btn'>Transfer</button>
                </div>)
              : <p className='muted'>Invite someone first.</p>}
          </form>
          <form action={deleteOrg} className='card stack'>
            <h3>Delete this org</h3>
            <input type='hidden' name='slug' value={slug} />
            <p className='muted'>This removes its roles, teams, members and invites. People keep their own accounts.</p>
            <div className='row'>
              <input className='input' name='confirm' placeholder={`Type ${slug}`} aria-label={`Type ${slug} to confirm`} />
              <button className='btn danger'>Delete org</button>
            </div>
          </form>
        </>)}
    </div>
  )
}
```

- [ ] **Step 6: Accepting an invite**

Create `web/app/invite/[token]/actions.js`:

```js
'use server'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { rememberSpace } from '@/lib/space-cookie.js'

export async function acceptInvite (formData) {
  const token = String(formData.get('token') || '')
  const back = `/invite/${encodeURIComponent(token)}`
  const user = await requireUser(back)
  const r = await apiCall(user, 'POST', '/v1/invites/accept', { token })
  if (!r.ok) redirect(`${back}?error=${encodeURIComponent(r.data?.error || 'Couldn’t join. Try again.')}`)
  await rememberSpace(r.data.org.slug)
  redirect(`/org/${r.data.org.slug}`)
}
```

Create `web/app/invite/[token]/page.js`:

```js
import Header from '@/components/Header.js'
import Notice from '@/components/Notice.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { inviteGone } from '@/lib/org-view.js'
import { acceptInvite } from './actions.js'

export const metadata = { title: 'Join an org' }

export default async function Invite ({ params, searchParams }) {
  const { token } = await params
  const q = await searchParams
  const user = await requireUser(`/invite/${encodeURIComponent(token)}`)
  const r = await apiCall(user, 'GET', `/v1/invites/${encodeURIComponent(token)}`)
  const inv = r.ok ? r.data : null
  const forMe = inv && String(user.email || '').toLowerCase() === inv.email
  let body
  if (!inv) {
    body = <><h2>That invite link doesn’t work</h2><p className='muted'>{r.status === 429 ? 'Too many tries. Wait a minute and reload.' : 'Check the link in your email, or ask for a new invite.'}</p></>
  } else if (inv.status !== 'pending') {
    body = <><h2>{inv.org.name}</h2><p className='muted'>{inviteGone(inv.status)}</p></>
  } else if (!forMe) {
    body = (
      <>
        <h2>Join {inv.org.name}</h2>
        <p>This invite is for <b>{inv.email}</b>, but you’re signed in as <b>{user.email}</b>.</p>
        <p className='muted'>Sign out, then open the link from your email again and sign in with {inv.email}.</p>
        <form action='/auth/signout' method='post'><button className='btn'>Sign out</button></form>
      </>
    )
  } else {
    body = (
      <>
        <h2>Join {inv.org.name}</h2>
        <p className='muted'>You’ll join as <b>{inv.role}</b>.</p>
        <Notice q={q} />
        <form action={acceptInvite}>
          <input type='hidden' name='token' value={token} />
          <button className='btn primary'>Join {inv.org.name}</button>
        </form>
      </>
    )
  }
  return (
    <>
      <Header signedIn />
      <main className='wrap page' style={{ maxWidth: 520 }}><div className='card stack'>{body}</div></main>
    </>
  )
}
```

- [ ] **Step 7: Asking to join from the dashboard**

In `web/app/dashboard/actions.js`, add to the imports:

```js
import { redirect } from 'next/navigation'
import { isSlug } from '@/lib/space.js'
```

and append:

```js
// Domain join requests: the API checks the person's confirmed email matches the org's domain.
export async function askToJoin (formData) {
  const user = await requireUser('/dashboard')
  const slug = String(formData.get('slug') || '')
  if (!isSlug(slug)) redirect('/dashboard')
  const r = await apiCall(user, 'POST', `/v1/orgs/${slug}/requests`, {})
  redirect(r.ok ? '/dashboard?asked=1' : '/dashboard?askFailed=1')
}
```

In `web/app/dashboard/page.js`:

1. Change `import { unlinkComputer, revokeAgent } from './actions.js'` to `import { unlinkComputer, revokeAgent, askToJoin } from './actions.js'`.
2. After the line `const agents = (agentsRes.data?.agents || []).filter((a) => !a.revokedAt)`, add:

```js
  // Orgs on the person's own (confirmed, non-public) email domain that take join requests.
  const discover = await apiCall(user, 'GET', '/v1/orgs/discover')
  const joinable = discover.data?.orgs || []
```

3. Directly after `{!orgs.length && user.orgName && <FirstOrg name={user.orgName} />}`, add:

```js
        {q.asked && <p className='notice'>Asked. Someone at the org will let you in.</p>}
        {q.askFailed && <p className='notice bad'>Couldn’t send your request. Try again.</p>}
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
```

- [ ] **Step 8: Run to see them pass**

Run: `cd web && npm test`
Expected: PASS, `# fail 0`.

- [ ] **Step 9: Commit**

```bash
git add web/lib/org-view.js web/app/org web/app/invite web/app/dashboard web/test
git commit -m "Add invites, join requests, org settings and the invite page"
```

---

### Task 14: Deploy and check end to end

**Files:**
- Modify: `scripts/api-smoke.mjs`

**Interfaces:**
- Consumes: everything above; the Supabase MCP (`apply_migration`, `list_tables`, `get_advisors`); the Fly and Netlify CLIs.
- Produces: the migration applied to project `pwebomewzuezaxoowykk`, `quilt-api` redeployed with SMTP settings, the website redeployed to `https://heyquilt.netlify.app`.

- [ ] **Step 1: Extend the smoke test**

In `scripts/api-smoke.mjs`, before the line `console.log('all good')`, add:

```js
const org = await call('POST', '/v1/orgs', { name: 'Smoke test org' }, JWT); ok(org.b?.org?.slug, 'org created')
ok((await call('GET', `/v1/orgs/${org.b.org.slug}/me`, null, JWT)).b?.isOwner === true, 'org owner')
ok((await call('POST', `/v1/orgs/${org.b.org.slug}/teams`, { name: 'Smoke team' }, JWT)).s === 200, 'team created')
ok((await call('DELETE', `/v1/orgs/${org.b.org.slug}`, null, JWT)).s === 200, 'org deleted')
```

Run: `npm test && (cd web && npm test)`
Expected: both suites PASS, `# fail 0`.

```bash
git add scripts/api-smoke.mjs
git commit -m "Check orgs in the API smoke test"
```

- [ ] **Step 2: Email first (person)**

Orgs need confirmed emails and invite delivery. The person:
1. In Resend (or Postmark), verifies a sending domain and creates SMTP credentials.
2. In Supabase → Authentication → Emails → SMTP Settings, enters those credentials (sender e.g. `Quilt <no-reply@<domain>>`), and in Authentication → Sign In / Providers → Email turns **Confirm email** on.
3. Sets the API's SMTP secrets without restarting it yet (they contain a password, so the person types them):
   `fly secrets set --stage --app quilt-api SMTP_URL='smtp://resend:<API key>@smtp.resend.com:587' SMTP_FROM='Quilt <invites@<domain>>'`

- [ ] **Step 3: Apply the migration (controller)**

With the Supabase MCP: `apply_migration` on project `pwebomewzuezaxoowykk`, name `orgs`, query = the contents of `supabase/migrations/20260930000000_orgs.sql`. Then `list_tables` (schema `public`) — expected: `orgs`, `roles`, `org_members`, `teams`, `team_members`, `org_invites`, `join_requests` present, each with RLS enabled — and `get_advisors` type `security` — expected: no new errors for these tables or functions.

- [ ] **Step 4: Merge, push and deploy the API (controller)**

```bash
git -C /Users/danielcarmichael/elegy merge claude/loving-boyd-2dd130
git -C /Users/danielcarmichael/elegy push
cd /Users/danielcarmichael/elegy && fly deploy --config fly.api.toml --app quilt-api --remote-only --ha=false
curl -s https://quilt-api.fly.dev/healthz
curl -s https://quilt-api.fly.dev/v1/orgs
QUILT_API=https://quilt-api.fly.dev node scripts/api-smoke.mjs
```

Expected: `{"ok":true}`; `{"error":"sign in first"}` (the org routes are live); the smoke script prints `ok` lines and `set QUILT_TEST_JWT to check approve, profile and agents` (the person may run it with their own `QUILT_TEST_JWT` to include the org checks). If the machine fails to start, `fly logs --app quilt-api` shows which variable is missing (`SMTP_URL is not set` means Step 2.3 wasn't done).

- [ ] **Step 5: Deploy the website (controller)**

From the main checkout (the Netlify CLI resolves the base from the main repo):

```bash
cd /Users/danielcarmichael/elegy/web && npm ci && cd .. && NETLIFY_SITE_ID=b9131760-8605-44f7-b9e1-3b347fc212b0 netlify deploy --build --prod
```

Expected: `Deploy is live!` with `https://heyquilt.netlify.app`.

- [ ] **Step 6: Check it end to end (controller + person)**

The person, on `https://heyquilt.netlify.app`:
1. Signs up with **A team** and an org name; confirms the email; lands on the dashboard, sees "Setting up …", then the org's Overview.
2. On Roles, creates a role with a few checkboxes; checks that Billing has no checkboxes and Org settings has only Read/Update.
3. On Teams, creates a team.
4. On Invites, invites a second address they own; the email arrives with a `/invite/qi_…` link; opening it signed in as that (confirmed) address and choosing Join lands in the org as Member; the switcher lists the org.
5. In Settings, sets the domain to their own email's domain and turns on requests; a third account on that domain sees "Orgs at <domain>" on its dashboard and asks to join; the first account approves it on Invites.
6. Transfers ownership to the second account, then (as the second) deletes the org; both land on their personal dashboards.

Fix anything that fails with a new commit, redeploy the part that changed (Step 4 or 5), and repeat the failing check.

---

## Self-review notes

- **Spec coverage (build-order item 1):** permission grid, built-ins and the four API rules — Tasks 1, 5, 6 (unit-tested in `api-permissions`, enforced and tested in `api-orgs`/`api-teams`); data model and RLS for `orgs`, `roles`, `org_members`, `teams`, `team_members`, `org_invites`, `join_requests` — Task 2; stores — Tasks 3–4; email invites (hashed `qi_` token, 7 days, confirmed matching email, rate-limited) — Tasks 7–8; domain requests with the public-mail blocklist and confirmed-email rule — Tasks 1, 5, 7; `/signup` Just me / A team — Task 10; space switcher with cookie and `/org/<slug>/…` URLs — Task 9; Org area People (role, teams, remove), Teams (create/rename/delete, members with editor/viewer), Roles (list + grid editor), Invites & requests, Settings (name, domain rule, transfer, delete — Owner only) — Tasks 11–13; `/invite/<token>` — Task 13; "email confirmation on + custom SMTP first" — Task 14. Agents in the People list, agent folders, `/agents/approve`, the personal Agents page, session passes, desktop sign-in and MCP are later plans; the existing agents table and routes are untouched.
- **Placeholder scan:** every code step has full code; commands have expected results. The only person-supplied values are the SMTP credentials and sending domain (Task 14, Step 2), which Claude must not type.
- **Name consistency:** store methods (`userEmail`, `createOrg`, `orgBySlug`, `orgById`, `orgsForUser`, `orgsByDomain`, `updateOrg`, `deleteOrg`, `transferOrg`, `listRoles`, `roleById`, `createRole`, `updateRole`, `deleteRole`, `roleInUse`, `memberOf`, `memberById`, `listMembers`, `addMember`, `setMemberRole`, `removeMember`, `listTeams`, `teamById`, `createTeam`, `renameTeam`, `deleteTeam`, `listTeamMembers`, `teamsOfMember`, `addTeamMember`, `setTeamAccess`, `removeTeamMember`, `createInvite`, `inviteByToken`, `inviteById`, `listInvites`, `updateInvite`, `claimInvite`, `createJoinRequest`, `joinRequestById`, `listJoinRequests`, `joinRequestsForUser`, `decideJoinRequest`) match between Tasks 3–4 and the routes in Tasks 5–7. `orgAccess` exposes `can`, `covers`, `need`, `needOwner`, `assignable` as used by all three route modules. The website uses `allowed`, `orgTabs`, `safeMessage`, `when`, `assignableRoles`, `peopleNotIn`, `inviteGone` (`org-view.js`), `orgAction`/`enc` (`org-actions.js`), `rememberSpace`, `SPACE_COOKIE`, `PERSONAL`, `isSlug`, `spaceHome` with the same names everywhere. Resource keys (`org`, `members`, `agents`, `teams`, `team_members`, `invites`, `roles`, `billing`) are the same in the API, the stored `grants` JSON, the website copy and the grid's `g.<resource>.<op>` field names.
- **Decisions made in this plan beyond the brief:** Billing has no checkboxes yet; changing a member's role needs Members: Update *and* Roles: Update, and you can't change, remove or edit a role for someone whose role holds checkboxes you don't; built-in roles can't be renamed or deleted; `GET /roles` is also open to people holding Members: Update or User invites: Create (they pick roles); holders of Teams: Read (including the default Member) see every team's name, but membership lists need Team membership: Read unless it's your own team; any member except the owner may leave; `join_requests` stores the requester's email; an owner must transfer or delete their orgs before deleting their account; org create/transfer run as Postgres functions for atomicity; slugs `personal`, `new`, `discover` are reserved.
