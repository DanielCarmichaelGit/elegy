# Issue Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every error, 404, crash and slow action in the desktop app, the accounts API and the website is recorded in the accounts Supabase project, grouped into issues with counts.

**Architecture:** One API endpoint (`POST /v1/issues`) and two tables (`events`, `issues`) written through a SQL function. The API records its own 404s, 5xx and slow requests straight through the store. The desktop app's UI server times every handler and sends batches through a small reporter; the website forwards 404s, error-boundary hits and failed API calls through a route handler with a shared secret.

**Tech Stack:** Node 22 (`node:test`, `node:http`, `node:crypto`), Supabase (Postgres, `supabase-js` rpc), Next 16 app router, plain ES modules in the Electron renderer (no build step).

**Spec:** `docs/superpowers/specs/2026-10-01-issue-tracking-design.md`

## Global Constraints

- Code style is the repo's: standard-style JS, no semicolons, 2 spaces, single quotes, comments that say *why*. Every file starts with a one or two line comment saying what it is for.
- No new npm dependencies.
- `events.kind` ∈ `action`, `error`, `http404`, `crash`; `events.outcome` ∈ `ok`, `slow`, `error`; `events.surface` ∈ `app`, `api`, `web`.
- Field limits: `name` ≤ 80 characters, `message` ≤ 500, `app_version` ≤ 40, `platform` ≤ 40, `context` ≤ 16 keys of string/number/boolean values with each string ≤ 200 characters and the whole JSON ≤ 2 KB. A batch holds 1 to 20 events.
- Slow thresholds: 2000 ms in the API, 3000 ms in the app and on the website. Reporter batches: 20 events or 10 s, 50 waiting at most, 60 s back-off after a failed send. Retention: events older than 30 days are deleted hourly.
- Reporting never throws into, fails or delays the thing it reports on. Every reporter call site is fire-and-forget with a `.catch`.
- The memory store is the tested reference; the Supabase store mirrors its methods. Both tables are service-role only.
- No file contents, chat text, invite links, tokens or full file paths leave the app. `scrub()` runs on every message and context value in `src/report.js`.
- Run `node --test test/<file>` for one file; `npm test` runs them all (about a minute). Website tests: `cd web && npm test`.
- Commit after every task with a message in the repo's style (a sentence, what and why) ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/api/issues.js` (new) | Pure helpers shared by the route, the API's self-recording and the stores: the allowed values, `normalizeMessage`, `fingerprint`, `cleanEvent`, `cleanContext`, `routeName`. |
| `src/api/routes/issues.js` (new) | `POST /v1/issues`: who may report, batch limits, hands clean events to `store.recordEvents`. |
| `src/api/memory-store.js` | `recordEvents`, `pruneEvents`, plus test-only `listEvents`, `listIssues`. |
| `src/api/supabase-store.js` | The same two methods over `rpc('record_events')` and a delete. |
| `supabase/migrations/20261001000000_issues.sql` (new) | Tables, indexes, RLS, grants, `record_events(jsonb)`. |
| `src/api/server.js` | Wires the route, the report key and limiter, records its own 404/5xx/slow requests, prunes hourly. |
| `bin/quilt.js` | Passes `QUILT_REPORT_KEY` to `startApi`. |
| `src/report.js` (new) | The app's reporter: `scrub`, `createReporter` (buffer, batch, back-off, flush). |
| `src/ui-server.js` | Times every handler, records outcomes, `POST /api/report`, the `report` setting, exposes `report`/`flushReports`. |
| `src/ui/common.js` | Renderer `error`/`unhandledrejection` → `POST /api/report`. |
| `src/ui/home.js` | The "Send problem reports" toggle. |
| `desktop/main.js` | Reports main-process crashes through the UI server before the error box. |
| `web/lib/report.js` (new) | Server-only forwarder to `/v1/issues` with the key; `cleanPath`, `uaFamily`. |
| `web/app/api/report/route.js` (new) | Browser-facing `POST /api/report` → forwarder. |
| `web/components/ReportPageIssue.js` (new) | Client component that posts one report on mount. |
| `web/app/not-found.js`, `web/app/error.js` (new) | Styled 404 and error pages that report. |
| `web/lib/api.js` | Records failed and slow calls to the accounts API. |
| `RELEASES.md`, `fly.api.toml`, `netlify.toml` | Notes and the new secret. |

---

### Task 1: Shared issue helpers (`src/api/issues.js`)

**Files:**
- Create: `src/api/issues.js`
- Test: `test/api-issues-helpers.test.js`

**Interfaces:**
- Produces:
  - `SURFACES = ['app', 'api', 'web']`, `KINDS = ['action', 'error', 'http404', 'crash']`, `OUTCOMES = ['ok', 'slow', 'error']`, `MAX_BATCH = 20`
  - `normalizeMessage(message: string): string`
  - `fingerprint({ surface, kind, name, message }): string` (64 hex chars)
  - `cleanContext(value: unknown): object` (never throws; drops what doesn't fit)
  - `cleanEvent(raw: object, { surface, appVersion, platform, userId, deviceId, now }): Event` (throws `HttpError(400)` on a bad `kind`/`outcome`/`name`)
  - `routeName(method: string, pathname: string): string`
  - `Event = { surface, kind, name, outcome, status: number|null, durationMs: number|null, message, appVersion, platform, userId: string|null, deviceId: string|null, context: object, occurredAt: number, fingerprint: string|null }` (`fingerprint` is null for `ok` events)

- [ ] **Step 1: Write the failing tests**

```js
// test/api-issues-helpers.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMessage, fingerprint, cleanContext, cleanEvent, routeName } from '../src/api/issues.js'

test('normalizeMessage replaces ids, numbers, quoted strings and paths so repeats match', () => {
  const a = normalizeMessage("Could not open '/Users/dana/code/app' for 3f2504e0-4f89-11d3-9a0c-0305e82c3301 (took 1234 ms)")
  const b = normalizeMessage("Could not open '/home/mo/other' for 7c9e6679-7425-40de-944b-e07fc1f90ae7 (took 9 ms)")
  assert.equal(a, b)
  assert.equal(normalizeMessage('ENOENT: no such file, open /tmp/x/y.txt'), 'enoent: no such file, open <path>')
  assert.equal(normalizeMessage('Hash deadbeefcafe1234 again'), 'hash <hex> again')
  assert.equal(normalizeMessage('  spaced   out  '), 'spaced out')
  assert.equal(normalizeMessage('x'.repeat(300)).length, 200)
})

test('fingerprint is stable for the same problem and differs by surface, kind and name', () => {
  const base = { surface: 'app', kind: 'action', name: 'open-in', message: 'Could not open it: spawn /a/b ENOENT' }
  assert.equal(fingerprint(base), fingerprint({ ...base, message: 'Could not open it: spawn /c/d ENOENT' }))
  assert.match(fingerprint(base), /^[0-9a-f]{64}$/)
  assert.notEqual(fingerprint(base), fingerprint({ ...base, surface: 'web' }))
  assert.notEqual(fingerprint(base), fingerprint({ ...base, kind: 'error' }))
  assert.notEqual(fingerprint(base), fingerprint({ ...base, name: 'start' }))
})

test('cleanContext keeps at most 16 flat scalar fields, cut to 200 characters, under 2 KB', () => {
  assert.deepEqual(cleanContext(null), {})
  assert.deepEqual(cleanContext('nope'), {})
  assert.deepEqual(cleanContext({ app: 'cursor', n: 2, ok: true, nested: { a: 1 }, list: [1], fn: () => {} }), { app: 'cursor', n: 2, ok: true })
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]))
  assert.equal(Object.keys(cleanContext(many)).length, 16)
  assert.equal(cleanContext({ s: 'x'.repeat(500) }).s.length, 200)
  const big = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`key${i}`, 'y'.repeat(200)]))
  assert.ok(JSON.stringify(cleanContext(big)).length <= 2048)
})

test('cleanEvent fills defaults, cuts fields, and fingerprints anything that is not ok', () => {
  const now = () => Date.parse('2026-10-01T12:00:00Z')
  const e = cleanEvent({ kind: 'action', name: 'open-in', outcome: 'error', status: 500, durationMs: 12.7, message: 'boom', context: { app: 'cursor' } },
    { surface: 'app', appVersion: '0.3.2', platform: 'darwin', userId: 'u1', deviceId: 'd1', now })
  assert.equal(e.surface, 'app'); assert.equal(e.kind, 'action'); assert.equal(e.outcome, 'error')
  assert.equal(e.status, 500); assert.equal(e.durationMs, 13); assert.equal(e.message, 'boom')
  assert.deepEqual(e.context, { app: 'cursor' }); assert.equal(e.userId, 'u1'); assert.equal(e.deviceId, 'd1')
  assert.equal(e.occurredAt, now())
  assert.equal(e.fingerprint, fingerprint({ surface: 'app', kind: 'action', name: 'open-in', message: 'boom' }))
  const ok = cleanEvent({ kind: 'action', name: 'x' }, { surface: 'app', now })
  assert.equal(ok.outcome, 'ok'); assert.equal(ok.fingerprint, null); assert.equal(ok.status, null)
  assert.equal(ok.durationMs, null); assert.equal(ok.message, ''); assert.deepEqual(ok.context, {})
  assert.equal(ok.userId, null); assert.equal(ok.deviceId, null); assert.equal(ok.appVersion, ''); assert.equal(ok.platform, '')
  assert.equal(cleanEvent({ kind: 'action', name: 'n'.repeat(100), message: 'm'.repeat(600) }, { surface: 'app', now }).name.length, 80)
  assert.equal(cleanEvent({ kind: 'action', name: 'x', message: 'm'.repeat(600) }, { surface: 'app', now }).message.length, 500)
  // An invisible character in a name is stripped, like every other name the API takes.
  assert.equal(cleanEvent({ kind: 'action', name: 'op\u200ben' }, { surface: 'app', now }).name, 'open')
})

test('cleanEvent clamps occurredAt to within a day of now and rejects unknown values', () => {
  const t = Date.parse('2026-10-01T12:00:00Z'); const now = () => t
  const day = 24 * 60 * 60 * 1000
  assert.equal(cleanEvent({ kind: 'action', name: 'x', occurredAt: t - 3 * day }, { surface: 'app', now }).occurredAt, t - day)
  assert.equal(cleanEvent({ kind: 'action', name: 'x', occurredAt: t + 3 * day }, { surface: 'app', now }).occurredAt, t + day)
  assert.equal(cleanEvent({ kind: 'action', name: 'x', occurredAt: 'yesterday' }, { surface: 'app', now }).occurredAt, t)
  for (const bad of [{ kind: 'nope', name: 'x' }, { kind: 'action', name: 'x', outcome: 'meh' }, { kind: 'action', name: '' }, { kind: 'action' }, null, 'str']) {
    assert.throws(() => cleanEvent(bad, { surface: 'app', now }), (err) => err.status === 400, JSON.stringify(bad))
  }
  assert.throws(() => cleanEvent({ kind: 'action', name: 'x' }, { surface: 'moon', now }), (err) => err.status === 400)
})

test('routeName replaces ids and tokens in a path so requests group', () => {
  assert.equal(routeName('GET', '/v1/orgs/3f2504e0-4f89-11d3-9a0c-0305e82c3301/members'), 'GET /v1/orgs/:id/members')
  assert.equal(routeName('GET', '/v1/join/' + 'a'.repeat(32)), 'GET /v1/join/:token')
  assert.equal(routeName('GET', '/v1/device/link/ABCD-1234'), 'GET /v1/device/link/:code')
  assert.equal(routeName('GET', '/healthz'), 'GET /healthz')
  assert.equal(routeName('GET', '/v1/' + 'x'.repeat(200)).length, 80)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/api-issues-helpers.test.js`
Expected: FAIL, `Cannot find module '../src/api/issues.js'`.

- [ ] **Step 3: Write the helpers**

```js
// src/api/issues.js
// What an issue report looks like, and how two reports of the same problem end up
// in one issue: shared by the /v1/issues route, the API's own error recording and
// both stores, so the memory store (the tested reference) and Postgres agree.
import crypto from 'node:crypto'
import { HttpError, UUID, stripInvisible } from './http.js'

export const SURFACES = ['app', 'api', 'web']
export const KINDS = ['action', 'error', 'http404', 'crash']
export const OUTCOMES = ['ok', 'slow', 'error']
export const MAX_BATCH = 20
const DAY = 24 * 60 * 60 * 1000
const MAX_CONTEXT_KEYS = 16
const MAX_CONTEXT_BYTES = 2048

const cut = (value, max) => stripInvisible(value).slice(0, max).join('').trim()

/** A message with the parts that differ between repeats of one problem replaced. */
export function normalizeMessage (message) {
  return String(message ?? '').toLowerCase()
    .replace(/(["'`])(?:(?!\1).){1,500}\1/g, '<str>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<hex>')
    .replace(/(?:~|[a-z]:\\|\/)[^\s'"`:,()]*[\\/][^\s'"`:,()]*/g, '<path>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** The same problem on the same surface, kind and name always gets this fingerprint. */
export function fingerprint ({ surface, kind, name, message }) {
  return crypto.createHash('sha256').update([surface, kind, name, normalizeMessage(message)].join('|')).digest('hex')
}

/** Context is a few flat facts (which editor, which route): scalars only, bounded. Never throws. */
export function cleanContext (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_CONTEXT_KEYS) break
    const key = cut(k, 40)
    if (!key) continue
    if (typeof v === 'string') out[key] = cut(v, 200)
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
    else if (typeof v === 'boolean') out[key] = v
  }
  // Still too big (16 long strings): drop fields from the end until it fits.
  while (JSON.stringify(out).length > MAX_CONTEXT_BYTES) delete out[Object.keys(out).pop()]
  return out
}

const oneOf = (list, value, what) => {
  const v = String(value ?? '')
  if (!list.includes(v)) throw new HttpError(400, `${what} must be one of ${list.join(', ')}`)
  return v
}
const intOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)

/**
 * One event as the stores take it. `surface`, `appVersion`, `platform`, `userId` and
 * `deviceId` are decided by the caller (the route knows who is reporting), never by the body.
 */
export function cleanEvent (raw, { surface, appVersion = '', platform = '', userId = null, deviceId = null, now = Date.now }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'each event must be an object')
  const kind = oneOf(KINDS, raw.kind, 'kind')
  const outcome = oneOf(OUTCOMES, raw.outcome ?? 'ok', 'outcome')
  const name = cut(raw.name, 80)
  if (!name) throw new HttpError(400, 'name is empty')
  const t = now()
  const at = typeof raw.occurredAt === 'number' ? raw.occurredAt : Date.parse(raw.occurredAt)
  const occurredAt = Number.isFinite(at) ? Math.min(Math.max(at, t - DAY), t + DAY) : t
  const message = cut(raw.message, 500)
  const e = {
    surface: oneOf(SURFACES, surface, 'surface'),
    kind, name, outcome,
    status: intOrNull(raw.status),
    durationMs: intOrNull(raw.durationMs),
    message,
    appVersion: cut(appVersion, 40),
    platform: cut(platform, 40),
    userId: userId ? String(userId) : null,
    deviceId: deviceId ? String(deviceId) : null,
    context: cleanContext(raw.context),
    occurredAt,
    fingerprint: null
  }
  if (outcome !== 'ok') e.fingerprint = fingerprint(e)
  return e
}

/** "GET /v1/orgs/:id/members": a request's path with the parts that vary replaced, so requests group. */
export function routeName (method, pathname) {
  const parts = String(pathname || '/').split('/').map((p) => {
    if (UUID.test(p)) return ':id'
    if (/^[A-Za-z0-9_-]{24,}$/.test(p)) return ':token'
    if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(p)) return ':code'
    return p
  })
  return `${method} ${parts.join('/')}`.slice(0, 80)
}
```

`userId` is kept as given: the route (Task 4) decides whose id it is, and only a body-supplied id has to be a uuid. (Test users in the memory store have ids like `'mem'`.) `UUID` is still imported for `routeName`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/api-issues-helpers.test.js`
Expected: PASS, 6 tests. If `normalizeMessage` disagrees on the path case, check the order: quoted strings first, then uuid, then hex, then paths, then numbers.

- [ ] **Step 5: Commit**

```bash
git add src/api/issues.js test/api-issues-helpers.test.js
git commit -m "Issues: shared helpers for cleaning and fingerprinting reports

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Memory store `recordEvents` and `pruneEvents`

**Files:**
- Modify: `src/api/memory-store.js` (the `createMemoryStore` body: add two Maps and four methods)
- Test: `test/api-store.test.js` (append)

**Interfaces:**
- Consumes: `Event` from Task 1 (with `fingerprint`).
- Produces (both stores):
  - `recordEvents(events: Event[]): Promise<number>` (count recorded)
  - `pruneEvents(before: number): Promise<number>` (deleted count; the Supabase store may return 0)
  - Memory only, for tests: `listEvents(): Event[]` (with `id`, `issueId`), `listIssues(): Issue[]` where `Issue = { id, fingerprint, surface, kind, name, message, count, firstSeenAt, lastSeenAt, resolvedAt }`, and `resolveIssue(id)` (sets `resolvedAt`, stands in for someone marking it resolved in the dashboard).

- [ ] **Step 1: Write the failing tests**

Append to `test/api-store.test.js`:

```js
import { cleanEvent } from '../src/api/issues.js'

const at = (iso) => () => Date.parse(iso)
const ev = (raw, now) => cleanEvent(raw, { surface: 'app', appVersion: '0.3.2', platform: 'darwin', userId: 'u1', deviceId: 'd1', now })

test('events: ok outcomes are kept as events only; failures open an issue and repeats count up', async () => {
  const s = createMemoryStore()
  const t1 = at('2026-10-01T10:00:00Z'); const t2 = at('2026-10-01T11:00:00Z')
  assert.equal(await s.recordEvents([
    ev({ kind: 'action', name: 'open-in', outcome: 'ok', durationMs: 40 }, t1),
    ev({ kind: 'action', name: 'open-in', outcome: 'error', message: 'Could not open it: spawn /Users/a/x ENOENT' }, t1)
  ]), 2)
  await s.recordEvents([ev({ kind: 'action', name: 'open-in', outcome: 'error', message: 'Could not open it: spawn /Users/b/y ENOENT' }, t2)])
  const events = s.listEvents()
  assert.equal(events.length, 3)
  assert.equal(events[0].issueId, null, 'an ok event belongs to no issue')
  const issues = s.listIssues()
  assert.equal(issues.length, 1)
  assert.equal(issues[0].count, 2)
  assert.equal(issues[0].message, 'Could not open it: spawn /Users/a/x ENOENT', 'the first message seen is kept')
  assert.equal(issues[0].firstSeenAt, t1()); assert.equal(issues[0].lastSeenAt, t2())
  assert.equal(events[1].issueId, issues[0].id); assert.equal(events[2].issueId, issues[0].id)
  assert.equal(events[1].durationMs, null); assert.equal(events[0].durationMs, 40)
})

test('events: a new occurrence reopens a resolved issue', async () => {
  const s = createMemoryStore()
  const t = at('2026-10-01T10:00:00Z')
  await s.recordEvents([ev({ kind: 'http404', name: '/pricing/old', outcome: 'error', status: 404 }, t)])
  const [issue] = s.listIssues()
  await s.resolveIssue(issue.id)
  assert.ok(s.listIssues()[0].resolvedAt)
  await s.recordEvents([ev({ kind: 'http404', name: '/pricing/old', outcome: 'error', status: 404 }, at('2026-10-02T10:00:00Z'))])
  assert.equal(s.listIssues()[0].resolvedAt, null)
  assert.equal(s.listIssues()[0].count, 2)
})

test('events: pruning deletes old events and keeps issues', async () => {
  const s = createMemoryStore()
  await s.recordEvents([ev({ kind: 'action', name: 'a', outcome: 'error', message: 'x' }, at('2026-08-01T00:00:00Z'))])
  await s.recordEvents([ev({ kind: 'action', name: 'a', outcome: 'ok' }, at('2026-10-01T00:00:00Z'))])
  assert.equal(await s.pruneEvents(Date.parse('2026-09-01T00:00:00Z')), 1)
  assert.equal(s.listEvents().length, 1)
  assert.equal(s.listIssues().length, 1)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/api-store.test.js`
Expected: FAIL, `s.recordEvents is not a function`.

- [ ] **Step 3: Add the methods**

In `src/api/memory-store.js`, next to the other Maps at the top of `createMemoryStore`, add:

```js
  const events = new Map(); const issues = new Map() // issues keyed by fingerprint
```

Then, inside the returned object (after `decideJoinRequest`), add:

```js
    ,
    // Issue reports. One event per outcome; a failure also opens (or counts up) its
    // issue by fingerprint. Mirrors record_events(jsonb) in Postgres.
    async recordEvents (list) {
      for (const e of list) {
        let issueId = null
        if (e.outcome !== 'ok') {
          let issue = issues.get(e.fingerprint)
          if (!issue) {
            issue = { id: uuid(), fingerprint: e.fingerprint, surface: e.surface, kind: e.kind, name: e.name, message: e.message, count: 0, firstSeenAt: e.occurredAt, lastSeenAt: e.occurredAt, resolvedAt: null }
            issues.set(e.fingerprint, issue)
          }
          issue.count += 1
          issue.lastSeenAt = Math.max(issue.lastSeenAt, e.occurredAt)
          issue.resolvedAt = null
          issueId = issue.id
        }
        const row = { id: uuid(), ...copy(e), issueId, createdAt: now() }
        delete row.fingerprint
        events.set(row.id, row)
      }
      return list.length
    },
    async pruneEvents (before) {
      let n = 0
      for (const [id, e] of events) if (e.occurredAt < before) { events.delete(id); n++ }
      return n
    },
    // Test-only views (production reads the tables in the Supabase dashboard).
    listEvents () { return [...events.values()].map(copy) },
    listIssues () { return [...issues.values()].map(copy) },
    async resolveIssue (id) { for (const i of issues.values()) if (i.id === id) i.resolvedAt = now() }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/api-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/memory-store.js test/api-store.test.js
git commit -m "Issues: the memory store records events and counts issues

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Migration and Supabase store

**Files:**
- Create: `supabase/migrations/20261001000000_issues.sql`
- Modify: `src/api/supabase-store.js` (add two methods at the end of the returned object)
- Test: `test/api-supabase-store.test.js` (append)

**Interfaces:**
- Consumes: `Event` (Task 1). Produces: `recordEvents`, `pruneEvents` as in Task 2.

- [ ] **Step 1: Write the failing tests**

Append to `test/api-supabase-store.test.js` (the file already defines `fakeClient`; `rpc` is added to it here):

```js
// The stand-in client above only has from(); record_events is an rpc, so give it one too.
function fakeRpcClient (data = 1) {
  const calls = []
  const base = fakeClient([])
  base.client.rpc = (fn, args) => { calls.push([fn, args]); return Promise.resolve({ data, error: null }) }
  return { client: base.client, calls, fromCalls: base.calls }
}

test('supabase recordEvents sends one record_events call with snake_case rows and ISO times', async () => {
  const { client, calls } = fakeRpcClient(2)
  const s = createSupabaseStore({ client })
  const t = Date.parse('2026-10-01T10:00:00Z')
  const n = await s.recordEvents([
    { surface: 'app', kind: 'action', name: 'open-in', outcome: 'error', status: null, durationMs: 12, message: 'boom', appVersion: '0.3.2', platform: 'darwin', userId: 'u1', deviceId: 'd1', context: { app: 'cursor' }, occurredAt: t, fingerprint: 'f'.repeat(64) },
    { surface: 'app', kind: 'action', name: 'open-in', outcome: 'ok', status: null, durationMs: 3, message: '', appVersion: '0.3.2', platform: 'darwin', userId: 'u1', deviceId: 'd1', context: {}, occurredAt: t, fingerprint: null }
  ])
  assert.equal(n, 2)
  assert.equal(calls.length, 1)
  const [fn, { events }] = calls[0]
  assert.equal(fn, 'record_events')
  assert.equal(events.length, 2)
  assert.deepEqual(events[0], { surface: 'app', kind: 'action', name: 'open-in', outcome: 'error', status: null, duration_ms: 12, message: 'boom', app_version: '0.3.2', platform: 'darwin', user_id: 'u1', device_id: 'd1', context: { app: 'cursor' }, occurred_at: '2026-10-01T10:00:00.000Z', fingerprint: 'f'.repeat(64) })
  assert.equal(events[1].fingerprint, null)
})

test('supabase recordEvents with nothing to record makes no call', async () => {
  const { client, calls } = fakeRpcClient()
  assert.equal(await createSupabaseStore({ client }).recordEvents([]), 0)
  assert.equal(calls.length, 0)
})

test('supabase pruneEvents deletes events that occurred before the cut-off', async () => {
  const { client, fromCalls } = fakeRpcClient()
  await createSupabaseStore({ client }).pruneEvents(Date.parse('2026-09-01T00:00:00Z'))
  const q = fromCalls.at(-1)
  assert.equal(q.table, 'events')
  assert.deepEqual(q.ops[0], ['delete'])
  assert.deepEqual(q.ops[1], ['lt', 'occurred_at', '2026-09-01T00:00:00.000Z'])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/api-supabase-store.test.js`
Expected: FAIL, `s.recordEvents is not a function`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/20261001000000_issues.sql
-- Issue tracking: every error, 404, crash and slow action from the desktop app, the
-- accounts API and the website lands in `events`; failures are grouped into `issues`
-- by a fingerprint the API computes. Both tables are the API's only: nothing is read
-- or written by clients. Events are pruned by the API after 30 days; issues stay.

create table public.issues (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique,
  surface text not null check (surface in ('app', 'api', 'web')),
  kind text not null check (kind in ('action', 'error', 'http404', 'crash')),
  name text not null check (char_length(name) between 1 and 80),
  -- The first message seen for this fingerprint, as it was (the fingerprint uses a normalized copy).
  message text not null default '' check (char_length(message) <= 500),
  count integer not null default 0,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  -- Set by hand in the dashboard; a new occurrence clears it.
  resolved_at timestamptz
);
create index issues_last_seen_at on public.issues (last_seen_at desc);
create index issues_open on public.issues (last_seen_at desc) where resolved_at is null;

create table public.events (
  id uuid primary key default gen_random_uuid(),
  surface text not null check (surface in ('app', 'api', 'web')),
  kind text not null check (kind in ('action', 'error', 'http404', 'crash')),
  name text not null check (char_length(name) between 1 and 80),
  outcome text not null check (outcome in ('ok', 'slow', 'error')),
  status integer,
  duration_ms integer,
  message text not null default '' check (char_length(message) <= 500),
  app_version text not null default '' check (char_length(app_version) <= 40),
  platform text not null default '' check (char_length(platform) <= 40),
  user_id uuid references auth.users (id) on delete set null,
  device_id uuid references public.devices (id) on delete set null,
  -- A few flat facts (which editor, which route). The API caps it at 2 KB of scalars.
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  issue_id uuid references public.issues (id) on delete set null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index events_occurred_at on public.events (occurred_at desc);
create index events_issue_id on public.events (issue_id);
create index events_user_id on public.events (user_id);
create index events_device_id on public.events (device_id);
create index events_surface_name on public.events (surface, name, occurred_at desc);

alter table public.issues enable row level security;
alter table public.events enable row level security;
-- No client policies or grants: the API writes with the service role, and people read the
-- tables in the Supabase dashboard.
revoke all on public.issues, public.events from anon, authenticated;
grant all on public.issues, public.events to service_role;

-- One round trip per batch: insert every event, and for each one that is not ok open or
-- count up its issue. `events` is a JSON array of rows in the columns' names, with
-- `fingerprint` on the ones that are not ok.
create or replace function public.record_events (events jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  e jsonb;
  issue uuid;
  n integer := 0;
begin
  if events is null or jsonb_typeof(events) <> 'array' then
    raise exception 'events must be an array';
  end if;
  for e in select * from jsonb_array_elements(events) loop
    issue := null;
    if (e->>'outcome') <> 'ok' then
      insert into public.issues (fingerprint, surface, kind, name, message, count, first_seen_at, last_seen_at)
      values (e->>'fingerprint', e->>'surface', e->>'kind', e->>'name', coalesce(e->>'message', ''), 1,
              (e->>'occurred_at')::timestamptz, (e->>'occurred_at')::timestamptz)
      on conflict (fingerprint) do update set
        count = public.issues.count + 1,
        last_seen_at = greatest(public.issues.last_seen_at, excluded.last_seen_at),
        resolved_at = null
      returning id into issue;
    end if;
    insert into public.events (surface, kind, name, outcome, status, duration_ms, message, app_version, platform,
                               user_id, device_id, context, issue_id, occurred_at)
    values (e->>'surface', e->>'kind', e->>'name', e->>'outcome', (e->>'status')::integer, (e->>'duration_ms')::integer,
            coalesce(e->>'message', ''), coalesce(e->>'app_version', ''), coalesce(e->>'platform', ''),
            (e->>'user_id')::uuid, (e->>'device_id')::uuid, coalesce(e->'context', '{}'::jsonb), issue,
            (e->>'occurred_at')::timestamptz);
    n := n + 1;
  end loop;
  return n;
end
$$;
revoke execute on function public.record_events(jsonb) from public, anon, authenticated;
grant execute on function public.record_events(jsonb) to service_role;
```

- [ ] **Step 4: Add the store methods**

In `src/api/supabase-store.js`, after `decideJoinRequest` inside the returned object:

```js
    ,
    // Issue reports: one rpc per batch (record_events opens or counts up issues itself).
    async recordEvents (list) {
      if (!list.length) return 0
      const events = list.map((e) => ({ ...toSnake({ ...e, occurredAt: ts(e.occurredAt) }), fingerprint: e.fingerprint ?? null, status: e.status ?? null, duration_ms: e.durationMs ?? null, user_id: e.userId ?? null, device_id: e.deviceId ?? null }))
      return (await one(db.rpc('record_events', { events }))) ?? list.length
    },
    async pruneEvents (before) {
      await one(db.from('events').delete().lt('occurred_at', ts(before)))
      return 0
    }
```

(`toSnake` drops `undefined` values and the explicit `?? null` entries keep the nullable columns present so the function reads them as JSON nulls.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/api-supabase-store.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261001000000_issues.sql src/api/supabase-store.js test/api-supabase-store.test.js
git commit -m "Issues: the events and issues tables, and the Supabase store that writes them

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `POST /v1/issues`

**Files:**
- Create: `src/api/routes/issues.js`
- Modify: `src/api/server.js` (the `startApi` signature, `ctx`, `routes.push`)
- Modify: `bin/quilt.js` (pass `reportKey`)
- Test: `test/api-issues.test.js`

**Interfaces:**
- Consumes: `cleanEvent`, `MAX_BATCH`, `SURFACES` (Task 1); `store.recordEvents` (Task 2); `device(req)` and `bearer(req)` from `startApi`.
- Produces: `issueRoutes({ store, device, bearer, now, reportKey, limitReports })` → route tuples. `startApi` gains options `reportKey = ''` and `reportLimit = 10`. Reply: `{ ok: true, recorded: n }`.

- [ ] **Step 1: Write the failing tests**

```js
// test/api-issues.test.js
// Who may report issues, what a report must look like, and that repeats count up.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi } from './api-helpers.js'
import { generateIdentity } from '../src/identity.js'
import { newToken, hashToken } from '../src/api/tokens.js'

const REPORT_KEY = 'rk_test_secret'
let t
before(async () => { t = await startTestApi({ reportKey: REPORT_KEY, reportLimit: 3 }) })
after(() => t.close())

/** A linked computer for "mem", and its bearer token. */
async function linkComputer () {
  const id = generateIdentity()
  const d = await t.store.upsertDevice({ userId: 'mem', name: 'Mac', platform: 'darwin', publicKey: id.publicKey })
  const token = newToken('qd_')
  await t.store.setDeviceToken(d.id, hashToken(token))
  return { device: d, token }
}
const batch = (events, extra = {}) => ({ surface: 'app', appVersion: '0.3.2', platform: 'darwin', events, ...extra })
const post = (body, headers) => t.call('POST', '/v1/issues', body, null, headers)

test('a linked computer reports as its account; repeats of one problem make one issue', async () => {
  const { device, token } = await linkComputer()
  const auth = { authorization: `Bearer ${token}` }
  const r = await post(batch([
    { kind: 'action', name: 'open-in', outcome: 'ok', durationMs: 50, context: { app: 'cursor' } },
    { kind: 'action', name: 'open-in', outcome: 'error', durationMs: 20, message: 'Could not open it: spawn /Users/a/Cursor ENOENT', context: { app: 'cursor' } }
  ]), auth)
  assert.deepEqual([r.status, r.body], [200, { ok: true, recorded: 2 }])
  await post(batch([{ kind: 'action', name: 'open-in', outcome: 'error', message: 'Could not open it: spawn /Users/b/Cursor ENOENT', context: { app: 'cursor' } }]), auth)
  const events = t.store.listEvents().filter((e) => e.name === 'open-in')
  assert.equal(events.length, 3)
  for (const e of events) {
    assert.equal(e.userId, 'mem'); assert.equal(e.deviceId, device.id); assert.equal(e.surface, 'app')
    assert.equal(e.appVersion, '0.3.2'); assert.equal(e.platform, 'darwin')
  }
  const issues = t.store.listIssues().filter((i) => i.name === 'open-in')
  assert.equal(issues.length, 1); assert.equal(issues[0].count, 2)
})

test('a linked computer may only report for the app, and the body cannot pick a user', async () => {
  const { token } = await linkComputer()
  const auth = { authorization: `Bearer ${token}` }
  assert.equal((await post(batch([{ kind: 'error', name: 'x' }], { surface: 'web' }), auth)).status, 400)
  await post(batch([{ kind: 'error', name: 'claimed', outcome: 'error' }], { userId: 'owner' }), auth)
  assert.equal(t.store.listEvents().find((e) => e.name === 'claimed').userId, 'mem')
})

test('a revoked computer is turned away', async () => {
  const { device, token } = await linkComputer()
  await t.store.revokeDevice(device.id)
  assert.equal((await post(batch([{ kind: 'error', name: 'x' }]), { authorization: `Bearer ${token}` })).status, 401)
})

test('the website reports with the key, for the web surface, naming the signed-in person when it knows one', async () => {
  const key = { 'x-quilt-report-key': REPORT_KEY }
  const r = await post({ surface: 'web', appVersion: '', platform: 'safari', userId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', events: [{ kind: 'http404', name: '/pricing/old', outcome: 'error', status: 404 }] }, key)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const e = t.store.listEvents().find((x) => x.name === '/pricing/old')
  assert.equal(e.surface, 'web'); assert.equal(e.userId, '3f2504e0-4f89-11d3-9a0c-0305e82c3301'); assert.equal(e.platform, 'safari')
  // A user id that isn't a uuid is dropped, not stored.
  await post({ surface: 'web', userId: 'not-a-uuid', events: [{ kind: 'error', name: '/x', outcome: 'error' }] }, key)
  assert.equal(t.store.listEvents().find((x) => x.name === '/x').userId, null)
  assert.equal((await post({ surface: 'app', events: [{ kind: 'error', name: '/y' }] }, key)).status, 400, 'the key is for the website only')
  assert.equal((await post({ surface: 'web', events: [{ kind: 'error', name: '/z' }] }, { 'x-quilt-report-key': 'wrong' })).status, 401)
})

test('without a token or key only app reports are taken, with no user, and only a few a minute', async () => {
  const r = await post(batch([{ kind: 'error', name: 'before-sign-in', outcome: 'error', message: 'Couldn\'t reach Quilt (ECONNREFUSED).' }]))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(t.store.listEvents().find((e) => e.name === 'before-sign-in').userId, null)
  assert.equal((await post(batch([{ kind: 'error', name: 'w' }], { surface: 'web' }))).status, 401)
  await post(batch([{ kind: 'error', name: 'two' }]))
  await post(batch([{ kind: 'error', name: 'three' }]))
  assert.equal((await post(batch([{ kind: 'error', name: 'four' }]))).status, 429)
})

test('a bad batch is a 400 and records nothing', async () => {
  const { token } = await linkComputer()
  const auth = { authorization: `Bearer ${token}` }
  const before = t.store.listEvents().length
  for (const body of [
    batch([]), batch('nope'), batch(Array.from({ length: 21 }, () => ({ kind: 'error', name: 'x' }))),
    batch([{ kind: 'nope', name: 'x' }]), batch([{ kind: 'error', name: 'x', outcome: 'meh' }]), batch([{ kind: 'error' }]),
    batch([{ kind: 'error', name: 'ok' }, 'junk'])
  ]) {
    const r = await post(body, auth)
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80))
  }
  assert.equal(t.store.listEvents().length, before)
})

test('with no report key configured, the website header is just a missing key', async () => {
  const bare = await startTestApi()
  try {
    const r = await bare.call('POST', '/v1/issues', { surface: 'web', events: [{ kind: 'error', name: '/x' }] }, null, { 'x-quilt-report-key': '' })
    assert.equal(r.status, 401)
  } finally { await bare.close() }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/api-issues.test.js`
Expected: FAIL with 404s (`not found`) on every call.

- [ ] **Step 3: Write the route**

```js
// src/api/routes/issues.js
// Issue reports from the desktop app and the website: errors, 404s, crashes and how long
// actions took. Who is reporting decides the surface and who the events belong to; the
// body never does.
import crypto from 'node:crypto'
import { HttpError, UUID } from '../http.js'
import { cleanEvent, MAX_BATCH } from '../issues.js'

const sameKey = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

export function issueRoutes ({ store, device, bearer, now, reportKey = '', limitReports }) {
  /** Who is reporting: { surface, userId, deviceId }. */
  async function reporter (req, body) {
    const surface = String(body.surface || '')
    if (bearer(req).startsWith('qd_')) {
      const d = await device(req)
      if (surface !== 'app') throw new HttpError(400, 'a computer reports for the app')
      return { surface, userId: d.userId, deviceId: d.id }
    }
    const key = String(req.headers['x-quilt-report-key'] || '')
    if (key) {
      if (!reportKey || !sameKey(key, reportKey)) throw new HttpError(401, 'bad report key')
      if (surface !== 'web') throw new HttpError(400, 'the website reports for the web')
      return { surface, userId: UUID.test(String(body.userId || '')) ? String(body.userId) : null, deviceId: null }
    }
    // Nobody signed in: the app before sign-in (a failed sign-in is worth knowing about).
    if (surface !== 'app') throw new HttpError(401, 'sign in first')
    limitReports(req)
    return { surface, userId: null, deviceId: null }
  }

  return [
    ['POST', /^\/v1\/issues$/, async (req, body) => {
      const who = await reporter(req, body)
      if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > MAX_BATCH) throw new HttpError(400, `events must hold 1 to ${MAX_BATCH} items`)
      const events = body.events.map((raw) => cleanEvent(raw, { ...who, appVersion: body.appVersion, platform: body.platform, now }))
      const recorded = await store.recordEvents(events)
      return { ok: true, recorded }
    }]
  ]
}
```

- [ ] **Step 4: Wire it into `startApi`**

In `src/api/server.js`:

1. Add to the import list: `import { issueRoutes } from './routes/issues.js'`.
2. Add to the `startApi` options (end of the destructured list): `, reportKey = '', reportLimit = 10`.
3. After `const limitPasses = ...` add:
   ```js
   // Reports with no sign-in (the app before it's linked): a few batches a minute per address.
   const limitReports = makeLimiter(reportLimit, 'too many reports; try again in a minute')
   ```
4. Change the `ctx` line to include `device`, `bearer`, `reportKey`, `limitReports`:
   ```js
   const ctx = { store, user, person, device, bearer, now, site, apiUrl: api, mailer, log, limit: limitInvites, limitSend: limitInviteSend, limitTokens, limitJoin, agentAuth, reportKey, limitReports }
   routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx), ...agentRoutes(ctx), ...agentInviteRoutes(ctx), ...joinRoutes(ctx), ...issueRoutes(ctx))
   ```

In `bin/quilt.js` `apiCmd`, add `reportKey: env.QUILT_REPORT_KEY || ''` to the `startApi({...})` call (after `passKey,`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/api-issues.test.js test/api.test.js`
Expected: PASS (the existing API tests still pass; the new file passes 7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/issues.js src/api/server.js bin/quilt.js test/api-issues.test.js
git commit -m "Issues: POST /v1/issues takes reports from linked computers, the website and the app before sign-in

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The API records its own 404s, 5xx and slow requests, and prunes

**Files:**
- Modify: `src/api/server.js` (the `http.createServer` handler and the returned `close`)
- Test: `test/api-issues.test.js` (append)

**Interfaces:**
- Consumes: `routeName`, `cleanEvent` (Task 1), `store.recordEvents`, `store.pruneEvents` (Task 2).
- Produces: `startApi` options `slowMs = 2000`, `pruneEveryMs = 60 * 60 * 1000`, `keepEventsMs = 30 * 24 * 60 * 60 * 1000`.

- [ ] **Step 1: Write the failing tests**

Append to `test/api-issues.test.js`:

```js
test('the API records an unknown route as a 404 event, grouped by its path shape', async () => {
  await t.call('GET', '/v1/nothing/3f2504e0-4f89-11d3-9a0c-0305e82c3301')
  await t.call('GET', '/v1/nothing/7c9e6679-7425-40de-944b-e07fc1f90ae7')
  await new Promise((r) => setTimeout(r, 20)) // recording is fire-and-forget
  const own = t.store.listEvents().filter((e) => e.surface === 'api' && e.kind === 'http404')
  assert.equal(own.length, 2)
  assert.equal(own[0].name, 'GET /v1/nothing/:id'); assert.equal(own[0].status, 404); assert.equal(own[0].outcome, 'error')
  assert.equal(t.store.listIssues().find((i) => i.name === 'GET /v1/nothing/:id').count, 2)
})

test('the API records a crash in a handler as a 500 event with the real message, and still answers "internal error"', async () => {
  const saved = t.store.linkByDeviceCode
  t.store.linkByDeviceCode = async () => { throw new Error('db down') }
  try {
    const r = await t.call('POST', '/v1/device/poll', { deviceCode: 'dc_x' })
    assert.deepEqual([r.status, r.body], [500, { error: 'internal error' }])
  } finally { t.store.linkByDeviceCode = saved }
  await new Promise((r) => setTimeout(r, 20))
  const e = t.store.listEvents().find((x) => x.surface === 'api' && x.name === 'POST /v1/device/poll')
  assert.equal(e.status, 500); assert.equal(e.outcome, 'error'); assert.equal(e.message, 'db down'); assert.equal(e.kind, 'action')
})

test('the API does not record the 4xx it answers on purpose', async () => {
  await t.call('GET', '/v1/me') // 401: no token
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(t.store.listEvents().filter((e) => e.surface === 'api' && e.name === 'GET /v1/me').length, 0)
})

test('a request over the slow threshold is recorded as slow, and a store that fails to record never fails the request', async () => {
  const slow = await startTestApi({ slowMs: -1 }) // everything is "slow"
  try {
    const r = await slow.call('GET', '/healthz')
    assert.equal(r.status, 200)
    await new Promise((res) => setTimeout(res, 20))
    const e = slow.store.listEvents().find((x) => x.name === 'GET /healthz')
    assert.equal(e.outcome, 'slow'); assert.equal(e.status, 200); assert.equal(typeof e.durationMs, 'number')
    slow.store.recordEvents = async () => { throw new Error('no db') }
    assert.equal((await slow.call('GET', '/healthz')).status, 200)
  } finally { await slow.close() }
})

test('old events are pruned on the API\'s timer', async () => {
  let n = 0
  const store = { pruneEvents: async () => { n++; return 0 } }
  const api = await startTestApi({ pruneEveryMs: 10, store: undefined })
  // startTestApi builds its own store; swap the prune method so the timer is observable.
  api.store.pruneEvents = store.pruneEvents
  try {
    await new Promise((r) => setTimeout(r, 60))
    assert.ok(n >= 1, 'pruneEvents ran on the timer')
  } finally { await api.close() }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/api-issues.test.js`
Expected: the five new tests FAIL (no `api` events; prune never runs).

- [ ] **Step 3: Record and prune in `startApi`**

In `src/api/server.js`:

1. Import: `import { routeName, cleanEvent } from './issues.js'`.
2. Options: add `, slowMs = 2000, pruneEveryMs = 60 * 60 * 1000, keepEventsMs = 30 * 24 * 60 * 60 * 1000`.
3. Just above `const server = http.createServer(...)`, add:

```js
  // The API's own trouble, straight into the store: unknown routes, crashes (5xx) and
  // slow requests. The 4xx a route throws on purpose is the API working, so it isn't kept.
  // Never awaited by the request, and a failure to record is only logged.
  function recordOwn ({ method, pathname, status, startedAt, message }) {
    const durationMs = now() - startedAt
    const slow = durationMs > slowMs
    if (status < 500 && status !== 404 && !slow) return
    const event = cleanEvent({
      kind: status === 404 ? 'http404' : 'action',
      name: routeName(method, pathname),
      outcome: status >= 400 ? 'error' : 'slow',
      status, durationMs, message
    }, { surface: 'api', appVersion: API_VERSION, now })
    Promise.resolve().then(() => store.recordEvents([event])).catch((err) => log(`issue record failed: ${err?.message || err}`))
  }
```

and near the top of the file:

```js
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const API_VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')).version
```

4. In the request handler: record `const startedAt = now()` as the first line inside the callback. Change `send` so every reply passes through recording:

```js
    const send = (status, data, type = 'application/json', message = '') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra, ...cors(req) })
      res.end(type === 'application/json' ? JSON.stringify(data) : data)
      recordOwn({ method: req.method, pathname, status, startedAt, message })
    }
```

and in the `catch`, pass the real message for crashes: the last line becomes

```js
      send(err.status || 500, { error: err instanceof HttpError ? err.message : 'internal error' }, 'application/json', err instanceof HttpError ? err.message : String(err?.message || err?.stack || JSON.stringify(err) || 'error'))
```

(The 409 branches above it stay as they are: a 409 is never recorded.)

5. Prune on a timer. Just before `return new Promise((resolve) => server.listen(...))`:

```js
  const prune = setInterval(() => { Promise.resolve().then(() => store.pruneEvents(now() - keepEventsMs)).catch((err) => log(`issue prune failed: ${err?.message || err}`)) }, pruneEveryMs)
  prune.unref()
```

and in the returned object's `close`: `close: () => { clearInterval(prune); return new Promise((r) => server.close(r)) }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/api-issues.test.js && npm test`
Expected: PASS; the full suite still passes. If a test in the suite checks exact `startApi` behaviour on close, confirm `clearInterval` runs before `server.close`.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.js test/api-issues.test.js
git commit -m "Issues: the API records its own 404s, crashes and slow requests, and prunes old events

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The app's reporter (`src/report.js`)

**Files:**
- Create: `src/report.js`
- Test: `test/report.test.js`

**Interfaces:**
- Consumes: `apiUrl()` from `src/account.js`, `currentVersion()` from `src/releases.js`.
- Produces:
  - `scrub(text: string): string`
  - `createReporter({ token = () => null, enabled = () => true, fetch = globalThis.fetch, api = apiUrl(), version = currentVersion(), platform = process.platform, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, batchSize = 20, delayMs = 10_000, maxWaiting = 50, backoffMs = 60_000, log = () => {} })` → `{ record(event), flush({ timeoutMs = 2000 }): Promise<void>, close(): Promise<void>, waiting(): number }`
  - `event = { kind, name, outcome = 'ok', status, durationMs, message = '', context = {} }`; the reporter adds `occurredAt: now()` and scrubs `message` and each string in `context`.
  - Request: `POST ${api}/v1/issues`, JSON `{ surface: 'app', appVersion, platform, events }`, header `authorization: Bearer <token>` when `token()` returns one.

- [ ] **Step 1: Write the failing tests**

```js
// test/report.test.js
// The app's issue reporter: it scrubs, batches, backs off and never throws.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrub, createReporter } from '../src/report.js'

test('scrub reduces paths to basenames and hides tokens and invite links', () => {
  assert.equal(scrub('Could not open /Users/dana/Code/my app/src: ENOENT'), 'Could not open src: ENOENT')
  assert.equal(scrub('spawn C:\\Users\\Mo\\AppData\\Local\\Programs\\cursor\\Cursor.exe ENOENT'), 'spawn Cursor.exe ENOENT')
  assert.equal(scrub('saved to ~/quilt/proj'), 'saved to proj')
  assert.equal(scrub('Bearer qd_abcDEF123-_x failed'), 'Bearer [secret] failed')
  assert.equal(scrub('key qa_1 and qr_2 and dc_3'), 'key [secret] and [secret] and [secret]')
  assert.equal(scrub('open https://join.heyquilt.com/room-x#s=abc now'), 'open [invite] now')
  assert.equal(scrub('quilt://join?invite=xyz'), '[invite]')
  assert.equal(scrub('plain message 42'), 'plain message 42')
  assert.equal(scrub(null), '')
})

/** A reporter over fake time and a fake fetch that records every request. */
function harness ({ status = 200, token = 'qd_tok', enabled = true, fail = false } = {}) {
  let t = 1_000_000
  const timers = []
  const sent = []
  const fetch = async (url, opts) => {
    sent.push({ url, headers: opts.headers, body: JSON.parse(opts.body) })
    if (fail) throw new Error('offline')
    return { ok: status < 400, status }
  }
  const r = createReporter({
    token: () => token, enabled: () => enabled, fetch, api: 'https://api.test', version: '0.3.2', platform: 'darwin',
    now: () => t,
    setTimer: (fn, ms) => { const id = { fn, at: t + ms }; timers.push(id); return id },
    clearTimer: (id) => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1) }
  })
  // Moves time forward and fires due timers, then lets promises settle.
  const advance = async (ms) => {
    t += ms
    for (const id of timers.filter((x) => x.at <= t)) { clearTimer(id); id.fn() }
    await new Promise((res) => setImmediate(res))
  }
  const clearTimer = (id) => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1) }
  return { r, sent, advance, timers, now: () => t }
}

test('events wait up to 10 s, then go in one batch with the account token', async () => {
  const h = harness()
  h.r.record({ kind: 'action', name: 'open-in', outcome: 'ok', durationMs: 40, context: { app: 'cursor' } })
  h.r.record({ kind: 'action', name: 'open-in', outcome: 'error', message: 'Could not open /Users/x/y: nope', context: { dir: '/Users/x/y' } })
  assert.equal(h.sent.length, 0)
  await h.advance(9_999)
  assert.equal(h.sent.length, 0)
  await h.advance(1)
  assert.equal(h.sent.length, 1)
  const { url, headers, body } = h.sent[0]
  assert.equal(url, 'https://api.test/v1/issues')
  assert.equal(headers.authorization, 'Bearer qd_tok')
  assert.deepEqual([body.surface, body.appVersion, body.platform], ['app', '0.3.2', 'darwin'])
  assert.equal(body.events.length, 2)
  assert.equal(body.events[0].occurredAt, 1_000_000)
  assert.equal(body.events[1].message, 'Could not open y: nope')
  assert.equal(body.events[1].context.dir, 'y')
  assert.equal(h.r.waiting(), 0)
})

test('twenty events send at once; more than fifty waiting drops the oldest', async () => {
  const h = harness()
  for (let i = 0; i < 20; i++) h.r.record({ kind: 'action', name: `n${i}` })
  await h.advance(0)
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].body.events.length, 20)
  // While a send is in flight and failing, events pile up and are capped.
  const f = harness({ fail: true })
  for (let i = 0; i < 70; i++) f.r.record({ kind: 'action', name: `n${i}` })
  assert.ok(f.r.waiting() <= 50)
})

test('no token means no authorization header; disabled means nothing is kept or sent', async () => {
  const h = harness({ token: null })
  h.r.record({ kind: 'error', name: 'sign-in', outcome: 'error', message: 'x' })
  await h.advance(10_000)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].headers.authorization, undefined)
  const off = harness({ enabled: false })
  off.r.record({ kind: 'error', name: 'x' })
  assert.equal(off.r.waiting(), 0)
  await off.advance(10_000)
  assert.equal(off.sent.length, 0)
})

test('a failed send drops the batch and waits a minute before trying again', async () => {
  const h = harness({ fail: true })
  h.r.record({ kind: 'error', name: 'a' })
  await h.advance(10_000)
  assert.equal(h.sent.length, 1)
  assert.equal(h.r.waiting(), 0, 'the failed batch is dropped, not retried')
  h.r.record({ kind: 'error', name: 'b' })
  await h.advance(10_000)
  assert.equal(h.sent.length, 1, 'backing off')
  await h.advance(50_000)
  assert.equal(h.sent.length, 2)
  // A 4xx reply counts as a failure too.
  const bad = harness({ status: 401 })
  bad.r.record({ kind: 'error', name: 'c' })
  await bad.advance(10_000); bad.r.record({ kind: 'error', name: 'd' }); await bad.advance(10_000)
  assert.equal(bad.sent.length, 1)
})

test('flush sends what is waiting now and gives up after the timeout', async () => {
  const h = harness()
  h.r.record({ kind: 'crash', name: 'main', outcome: 'error', message: 'boom' })
  await h.r.flush()
  assert.equal(h.sent.length, 1)
  let resolveFetch
  const hang = createReporter({ token: () => null, fetch: () => new Promise((res) => { resolveFetch = res }), api: 'x', version: '0', platform: 'p', setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clearTimer: clearTimeout })
  hang.record({ kind: 'crash', name: 'main' })
  const started = Date.now()
  await hang.flush({ timeoutMs: 20 })
  assert.ok(Date.now() - started < 1000, 'flush returned without the fetch finishing')
  resolveFetch({ ok: true, status: 200 })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/report.test.js`
Expected: FAIL, `Cannot find module '../src/report.js'`.

- [ ] **Step 3: Write the reporter**

```js
// src/report.js
// Tells Quilt what went wrong in the app (and how long actions took) so problems can be
// found without anyone filing them. Batches reports to the accounts API, scrubs anything
// personal first, and never gets in the way: it drops rather than retries, and never throws.
import path from 'node:path'
import { apiUrl } from './account.js'
import { currentVersion } from './releases.js'

// A path on this computer says who you are and how your disk is laid out; its last part
// (the project folder, the app) is all a report needs.
const PATH = /(?:~|[A-Za-z]:\\|\/(?:Users|home|private|tmp|var|opt|Applications|Volumes|root|mnt))[^\s'"`:,()]*/g
const TOKEN = /\b(?:qd|qa|qr|dc)_[A-Za-z0-9_-]+/g
const INVITE = /(?:https?:\/\/join\.heyquilt\.com\/[^\s'"`]+|quilt:\/\/[^\s'"`]+)/g

/** `text` with paths cut to their last part, and tokens and invite links hidden. */
export function scrub (text) {
  return String(text ?? '')
    .replace(INVITE, '[invite]')
    .replace(TOKEN, '[secret]')
    .replace(PATH, (m) => m.split(/[\\/]/).filter(Boolean).pop() || '[path]')
}

const scrubContext = (c) => Object.fromEntries(Object.entries(c && typeof c === 'object' ? c : {}).map(([k, v]) => [k, typeof v === 'string' ? scrub(v) : v]))

export function createReporter ({
  token = () => null, enabled = () => true, fetch = globalThis.fetch, api = apiUrl(), version = currentVersion(), platform = process.platform,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  batchSize = 20, delayMs = 10_000, maxWaiting = 50, backoffMs = 60_000, log = () => {}
} = {}) {
  let waiting = []
  let timer = null
  let pausedUntil = 0
  let inflight = null

  function record (event) {
    try {
      if (!enabled()) return
      const { kind, name, outcome = 'ok', status, durationMs, message = '', context = {} } = event || {}
      waiting.push({ kind, name: String(name || '').slice(0, 80), outcome, status, durationMs, message: scrub(message).slice(0, 500), context: scrubContext(context), occurredAt: now() })
      if (waiting.length > maxWaiting) waiting.splice(0, waiting.length - maxWaiting)
      if (waiting.length >= batchSize) send()
      else schedule()
    } catch {}
  }

  function schedule () {
    if (timer || !waiting.length) return
    const delay = Math.max(delayMs, pausedUntil - now())
    timer = setTimer(() => { timer = null; send() }, delay)
  }

  function send () {
    if (inflight || !waiting.length) return
    if (now() < pausedUntil) return schedule()
    if (timer) { clearTimer(timer); timer = null }
    const events = waiting.splice(0, batchSize)
    const t = token()
    inflight = Promise.resolve().then(() => fetch(`${api}/v1/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
      body: JSON.stringify({ surface: 'app', appVersion: version, platform, events })
    })).then((res) => {
      if (!res || !res.ok) throw new Error(`Quilt answered ${res && res.status}`)
    }).catch((err) => {
      // Dropped, not retried: a report is never worth a retry storm. One quiet line.
      pausedUntil = now() + backoffMs
      log(`issue report not sent: ${err?.message || err}`)
    }).finally(() => {
      inflight = null
      if (waiting.length) schedule()
    })
    return inflight
  }

  /** Sends what is waiting now; gives up after `timeoutMs` so shutdown never hangs on it. */
  async function flush ({ timeoutMs = 2000 } = {}) {
    if (!waiting.length && !inflight) return
    const work = (inflight || Promise.resolve()).then(() => { pausedUntil = 0; return send() })
    await Promise.race([work, new Promise((res) => setTimeout(res, timeoutMs))]).catch(() => {})
  }

  return { record, flush, close: () => flush(), waiting: () => waiting.length }
}
```

Note: `flush` uses the real `setTimeout` for its deadline on purpose: it is a wall-clock guard at shutdown, not something tests pace with fake timers (the test passes a real-timer `setTimer` for that case).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/report.test.js`
Expected: PASS, 6 tests. The "twenty events send at once" case relies on `send()` running synchronously up to the `fetch` call, so `sent.length` is 1 right after `advance(0)`.

- [ ] **Step 5: Commit**

```bash
git add src/report.js test/report.test.js
git commit -m "App: a reporter that batches scrubbed issue reports to the accounts API

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The UI server records every action, renderer errors and 404s

**Files:**
- Modify: `src/ui-server.js` (imports, `profile`/`updateProfile`, `OPEN_ROUTES`, `startUi` body, the request handler, the returned object)
- Test: `test/ui-report.test.js`

**Interfaces:**
- Consumes: `createReporter` (Task 6), `getSettings`/`saveSettings`, `readAccount`.
- Produces:
  - `startUi({ ..., reporter })`: an optional reporter (tests pass one over a fake fetch; the app builds its own).
  - Return value gains `report(event)` and `flushReports()`.
  - `GET /api/settings` / `GET /api/state` `profile.report: boolean`; `POST /api/settings { report }`.
  - `POST /api/report { name, message, context }` (open before sign-in) → `{ ok: true }`.
  - Recorded names are the route keys with the session id replaced: `POST /api/sessions/:id/open-in`.

- [ ] **Step 1: Write the failing tests**

```js
// test/ui-report.test.js
// What the app tells Quilt about itself: each action's outcome and timing, renderer
// errors, unknown routes, and nothing at all when reporting is turned off.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-report-'))
process.env.HOME = home

const { startUi } = await import('../src/ui-server.js')
const { createReporter } = await import('../src/report.js')
const { saveSettings } = await import('../src/settings.js')

const sent = []
const reporter = createReporter({
  token: () => null, fetch: async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200 } },
  api: 'https://api.test', version: '0.3.2', platform: 'darwin', batchSize: 1, delayMs: 0
})
let ui
before(async () => {
  // A signed-in computer, so routes answer (the token is never used: the reporter's fetch is fake and the relay isn't needed).
  fs.mkdirSync(path.join(home, '.quilt'), { recursive: true })
  fs.writeFileSync(path.join(home, '.quilt', 'account.json'), JSON.stringify({ token: 'qd_test', account: { id: 'u1', name: 'Dana', email: '' }, signedInAt: Date.now() }), { mode: 0o600 })
  ui = await startUi({ port: 0, reporter })
})
after(() => ui.close())

const call = (method, p, body) => fetch(`http://127.0.0.1:${ui.port}${p}`, {
  method, headers: { 'x-quilt-token': ui.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))
const settle = () => new Promise((r) => setTimeout(r, 30))
const events = () => sent.flatMap((b) => b.events)
const last = (name) => events().filter((e) => e.name === name).at(-1)

test('a handler that works is recorded ok, with its duration and the context fields the route keeps', async () => {
  const r = await call('GET', '/api/settings')
  assert.equal(r.status, 200)
  assert.equal(r.body.report, true, 'reporting is on by default')
  await settle()
  const e = last('GET /api/settings')
  assert.equal(e.kind, 'action'); assert.equal(e.outcome, 'ok'); assert.equal(e.status, 200)
  assert.equal(typeof e.durationMs, 'number'); assert.deepEqual(e.context, {})
})

test('a handler that fails is recorded as an error with the message the person saw, and the session id is not in the name', async () => {
  const r = await call('POST', '/api/sessions/abc123/open-in', { app: 'cursor' })
  assert.equal(r.status, 404)
  await settle()
  const e = last('POST /api/sessions/:id/open-in')
  assert.equal(e.outcome, 'error'); assert.equal(e.status, 404)
  assert.equal(e.message, 'That session is not running.')
  assert.deepEqual(e.context, { app: 'cursor' })
})

test('an unknown route is a 404 event', async () => {
  assert.equal((await call('GET', '/api/nothing-here')).status, 404)
  await settle()
  const e = last('GET /api/nothing-here')
  assert.equal(e.kind, 'http404'); assert.equal(e.outcome, 'error')
})

test('the renderer reports its own errors through /api/report', async () => {
  const r = await call('POST', '/api/report', { name: 'renderer', message: 'TypeError: x is not a function at /Users/dana/app.js', context: { view: 'home' } })
  assert.deepEqual([r.status, r.body], [200, { ok: true }])
  await settle()
  const e = last('renderer')
  assert.equal(e.kind, 'error'); assert.equal(e.outcome, 'error')
  assert.equal(e.message, 'TypeError: x is not a function at app.js')
  assert.deepEqual(e.context, { view: 'home' })
  assert.equal(events().filter((x) => x.name === 'POST /api/report').length, 0, 'reporting a report is not itself recorded')
})

test('the setting turns reporting off and on, and is saved', async () => {
  assert.equal((await call('POST', '/api/settings', { report: false })).body.report, false)
  const before = events().length
  await call('GET', '/api/settings')
  await settle()
  assert.equal(events().length, before, 'nothing recorded while off')
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.quilt', 'settings.json'), 'utf8')).report, false)
  assert.equal((await call('POST', '/api/settings', { report: true })).body.report, true)
  assert.equal('report' in JSON.parse(fs.readFileSync(path.join(home, '.quilt', 'settings.json'), 'utf8')), false, 'on is the default, so it is not written')
})

test('report() and flushReports() are there for the desktop shell', async () => {
  ui.report({ kind: 'crash', name: 'main', outcome: 'error', message: 'boom' })
  await ui.flushReports()
  assert.equal(last('main').kind, 'crash')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/ui-report.test.js`
Expected: FAIL (`profile.report` undefined, `/api/report` 404, `ui.report` not a function).

- [ ] **Step 3: Make the changes in `src/ui-server.js`**

1. Import: `import { createReporter } from './report.js'`.
2. In `profile()` add `report: s.report !== false` after `preferLocal`.
3. In `updateProfile()` add `if ('report' in b) patch.report = b.report ? undefined : false`.
4. Add `'POST /api/report'` to `OPEN_ROUTES`.
5. Change the signature to `export async function startUi ({ port = 7420, onShutdown, preview = false, reporter } = {})` and, as the first lines in the body:

```js
  // What this app tells Quilt about itself (see report.js). Off with the "report" setting.
  reporter = reporter || createReporter({ token: () => readAccount()?.token || null, enabled: () => getSettings().report !== false })
  // Body fields worth keeping with a route's outcome: which editor, which kind of start. Never free text.
  const CONTEXT_FIELDS = { 'POST /api/sessions/:id/open-in': ['app'], 'POST /api/sessions': ['mode', 'tool', 'prefer'], 'POST /api/settings': [] }
  const contextFor = (key, body) => Object.fromEntries((CONTEXT_FIELDS[key] || []).filter((f) => typeof body?.[f] === 'string').map((f) => [f, body[f].slice(0, 40)]))
  const SLOW_MS = 3000
  // Not recorded: the live event stream (it is open for as long as the window is), and reports about reports.
  const UNRECORDED = new Set(['GET /api/events', 'POST /api/report'])
  function recordRoute (key, { startedAt, status, body, error }) {
    if (UNRECORDED.has(key)) return
    const durationMs = Date.now() - startedAt
    reporter.record({ kind: 'action', name: key, outcome: error ? 'error' : durationMs > SLOW_MS ? 'slow' : 'ok', status, durationMs, message: error ? error.message : '', context: contextFor(key, body) })
  }
```

6. Add the report route to the `api` table (near `'GET /api/settings'`):

```js
    'POST /api/report': (b) => {
      reporter.record({ kind: 'error', name: String(b.name || 'renderer').slice(0, 80), outcome: 'error', message: String(b.message || '').slice(0, 500), context: typeof b.context === 'object' && b.context ? b.context : {} })
      return { ok: true }
    },
```

7. In the request handler, time the handler and record. Replace the block from `const pathKey = ...` to the end of the `catch` with:

```js
      const pathKey = url.pathname.replace(/^\/api\/sessions\/[a-f0-9]+/, '/api/sessions/:id')
      const sid = (url.pathname.match(/^\/api\/sessions\/([a-f0-9]+)/) || [])[1]
      const key = `${req.method} ${pathKey}`
      const handler = api[key]
      if (!handler) {
        reporter.record({ kind: 'http404', name: key.slice(0, 80), outcome: 'error', status: 404 })
        return json(404, { error: 'not found' })
      }
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : {}
      const startedAt = Date.now()
      try {
        const out = await handler(body, sid, url)
        recordRoute(key, { startedAt, status: 200, body })
        return json(200, out)
      } catch (err) {
        recordRoute(key, { startedAt, status: err.status || 400, body, error: err })
        throw err
      }
    } catch (err) {
      return json(err.status || 400, { error: err.message, ...(err.signedOut ? { signedOut: true } : {}) })
    }
```

(The outer `try` already wraps `receiveUpload`/`serveFile`; those two stay unrecorded except through the generic catch, which is fine: uploads are files, not actions people wait on in the same way, and the spec lists only the `api` table.)

8. In the returned object add `report: (event) => reporter.record(event), flushReports: () => reporter.flush()`, and make `close` flush first: insert `await reporter.flush()` as the last line before `await new Promise((r) => server.close(r))`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/ui-report.test.js test/ui-account.test.js test/git.test.js`
Expected: PASS. `ui-account.test.js` runs against a real test API with no `/v1/issues` reporter fetch stubbed: the default reporter there posts to `process.env.QUILT_API_URL` (the test API), which accepts anonymous app reports, so nothing breaks; if the test API's anonymous limit (10/min) is hit, raise it with `reportLimit: 1000` in `startTestApi` defaults (edit `test/api-helpers.js`: add `reportLimit: 1000` next to `joinLimit: 1000`).

- [ ] **Step 5: Commit**

```bash
git add src/ui-server.js test/ui-report.test.js test/api-helpers.js
git commit -m "App: record every action's outcome and timing, renderer errors and unknown routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Renderer errors, the Settings toggle, and main-process crashes

**Files:**
- Modify: `src/ui/common.js` (append after the `api` function)
- Modify: `src/ui/home.js` (the `sess` section's toggles and `saveForm`)
- Modify: `desktop/main.js` (`start`, the `whenReady` catch, a new `uncaughtException` handler)

**Interfaces:**
- Consumes: `POST /api/report` and `ui.report`/`ui.flushReports` (Task 7).

No automated test covers the renderer or Electron (no DOM in `node:test`, and the repo has no Electron tests). Verification is by hand in Step 3.

- [ ] **Step 1: Renderer error reporting**

Append to `src/ui/common.js`, after `export async function api (...) { ... }`:

```js
// ------------------------------------------------------------- reports --
// Errors nothing caught (a bug in the page) go to the app, which tells Quilt. The same
// message within ten seconds is sent once. api() failures are not sent from here: the
// handler that failed already recorded them.
const recentReports = new Map()
function reportRendererError (message) {
  const text = String(message || '').slice(0, 500)
  if (!text) return
  const t = Date.now()
  if (recentReports.get(text) > t - 10_000) return
  recentReports.set(text, t)
  for (const [k, v] of recentReports) if (v < t - 60_000) recentReports.delete(k)
  fetch('/api/report', {
    method: 'POST',
    headers: { 'x-quilt-token': TOKEN || '', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'renderer', message: text, context: { view: String(state.view || '') } })
  }).catch(() => {})
}
window.addEventListener('error', (e) => reportRendererError(e.message || (e.error && e.error.message) || ''))
window.addEventListener('unhandledrejection', (e) => reportRendererError((e.reason && e.reason.message) || String(e.reason || '')))
```

Check that `state` is defined above this point in `common.js` (it is exported from the same module; if it is declared below `api`, move this block to the end of the file).

- [ ] **Step 2: The Settings toggle**

In `src/ui/home.js`, in `settingsHtml()` after the `preferLocal` toggle line, add:

```js
      ${toggle('report', p.report, 'Send problem reports to Quilt', 'When something fails or takes too long, the app sends what happened: the action, the error message, how long it took, your app version and OS. Never your files, your chats or your links.')}
```

and in the `saveForm(sess, ...)` call add `report: !!f.get('report')` to the returned object.

- [ ] **Step 3: Electron main-process crashes**

In `desktop/main.js`:

1. Replace the `app.whenReady().then(start).catch(...)` block's catch with:

```js
  app.whenReady().then(start).catch(async (err) => {
    await reportCrash('start', err)
    dialog.showErrorBox('quilt could not start', err.stack || err.message)
    app.exit(1)
  })
```

2. Add, below the `openInvite` function:

```js
/** Tells Quilt about a crash in this process, when the app is far enough along to. Never throws. */
async function reportCrash (name, err) {
  try {
    if (!ui) return
    ui.report({ kind: 'crash', name, outcome: 'error', message: err?.stack || err?.message || String(err) })
    await ui.flushReports()
  } catch {}
}

// Electron would show its own dialog and carry on; do the same, after telling Quilt.
process.on('uncaughtException', (err) => {
  reportCrash('main', err).finally(() => dialog.showErrorBox('quilt hit a problem', err?.stack || err?.message || String(err)))
})
```

3. Verify by hand: `npm run app`, open Settings, confirm the new toggle shows under the session settings and saving it writes `"report": false` to `~/.quilt/settings.json` when off. In the window's DevTools console run `setTimeout(() => { throw new Error('test renderer error') })` and confirm a `POST /api/report` with that message appears in the Network tab (status 200). Then run `npm test` to be sure nothing else moved.

- [ ] **Step 4: Commit**

```bash
git add src/ui/common.js src/ui/home.js desktop/main.js
git commit -m "App: report renderer errors and main-process crashes, with a setting to turn reports off

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Website forwarder and `/api/report`

**Files:**
- Create: `web/lib/report.js`, `web/app/api/report/route.js`
- Test: `web/test/report.test.js`

**Interfaces:**
- Consumes: `POST /v1/issues` with `x-quilt-report-key` (Task 4), `currentUser()` from `web/lib/session.js`.
- Produces:
  - `cleanPath(value: unknown): string` (pathname only, no query or fragment, ≤ 200 chars, `'/'` when empty)
  - `uaFamily(ua: string): string` (`'safari' | 'chrome' | 'firefox' | 'edge' | 'other'`)
  - `report({ kind, name, outcome = 'error', status, durationMs, message = '', userId = null, platform = '' }, { fetchImpl = fetch } = {}): Promise<void>` (never throws; no-op without `QUILT_REPORT_KEY`)
  - `POST /api/report` body `{ kind: 'http404' | 'error', name, message }` → 204 always.

- [ ] **Step 1: Write the failing tests**

```js
// web/test/report.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

let srv; const seen = []; let answer = 200
before(async () => {
  srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { seen.push({ url: req.url, key: req.headers['x-quilt-report-key'], body: JSON.parse(body) }); res.writeHead(answer); res.end('{}') })
  }).listen(0)
  await new Promise((r) => srv.once('listening', r))
  process.env.QUILT_API_URL = `http://127.0.0.1:${srv.address().port}`
  process.env.QUILT_REPORT_KEY = 'rk_web'
})
after(() => srv.close())

test('cleanPath keeps only the path: no query, no fragment (invite links carry secrets there)', async () => {
  const { cleanPath } = await import('../lib/report.js')
  assert.equal(cleanPath('/join/room-x?x=1#s=secret'), '/join/room-x')
  assert.equal(cleanPath('https://heyquilt.com/pricing/old#top'), '/pricing/old')
  assert.equal(cleanPath(''), '/'); assert.equal(cleanPath(null), '/'); assert.equal(cleanPath(42), '/')
  assert.equal(cleanPath('/' + 'a'.repeat(300)).length, 200)
})

test('uaFamily names the browser family, never the whole user agent', async () => {
  const { uaFamily } = await import('../lib/report.js')
  assert.equal(uaFamily('Mozilla/5.0 (Macintosh) AppleWebKit/605 (KHTML, like Gecko) Version/17 Safari/605'), 'safari')
  assert.equal(uaFamily('Mozilla/5.0 (Windows) AppleWebKit/537 Chrome/120 Safari/537'), 'chrome')
  assert.equal(uaFamily('Mozilla/5.0 (Windows) AppleWebKit/537 Chrome/120 Safari/537 Edg/120'), 'edge')
  assert.equal(uaFamily('Mozilla/5.0 (X11) Gecko/20100101 Firefox/120'), 'firefox')
  assert.equal(uaFamily(''), 'other')
})

test('report posts one web event with the key and the person, and swallows failures', async () => {
  const { report } = await import('../lib/report.js')
  await report({ kind: 'http404', name: '/pricing/old', status: 404, userId: 'u-1', platform: 'safari' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, '/v1/issues'); assert.equal(seen[0].key, 'rk_web')
  assert.deepEqual(seen[0].body.surface, 'web'); assert.equal(seen[0].body.userId, 'u-1'); assert.equal(seen[0].body.platform, 'safari')
  assert.deepEqual(seen[0].body.events[0], { kind: 'http404', name: '/pricing/old', outcome: 'error', status: 404, durationMs: undefined, message: '' })
  answer = 500
  await report({ kind: 'error', name: '/x', message: 'boom' })
  assert.equal(seen.length, 2, 'a failed send is not retried and does not throw')
  answer = 200
  const saved = process.env.QUILT_API_URL
  process.env.QUILT_API_URL = 'http://127.0.0.1:9'
  try { await report({ kind: 'error', name: '/y' }) } finally { process.env.QUILT_API_URL = saved }
})

test('without a report key nothing is sent', async () => {
  const { report } = await import('../lib/report.js')
  const saved = process.env.QUILT_REPORT_KEY
  delete process.env.QUILT_REPORT_KEY
  try {
    const n = seen.length
    await report({ kind: 'error', name: '/z' })
    assert.equal(seen.length, n)
  } finally { process.env.QUILT_REPORT_KEY = saved }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && node --conditions=react-server --test test/report.test.js`
Expected: FAIL, `Cannot find module '../lib/report.js'`.

- [ ] **Step 3: Write the forwarder**

```js
// web/lib/report.js
// Tells the accounts API what went wrong on the website (a 404, a page that crashed, a
// failed call to the API), so it lands with the app's and the API's own reports. Server-side
// only: the report key never reaches the browser. Never throws, never retries.
import 'server-only'

/** Only the path of a URL or pathname: no query, no fragment (invite links keep secrets there). */
export function cleanPath (value) {
  if (typeof value !== 'string' || !value) return '/'
  let p = value
  try { p = new URL(value, 'https://x').pathname } catch { p = value.split(/[?#]/)[0] }
  return (p || '/').slice(0, 200)
}

/** The browser family, which is all a report needs to know about the visitor's software. */
export function uaFamily (ua = '') {
  if (/Edg\//.test(ua)) return 'edge'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Chrome\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua)) return 'safari'
  return 'other'
}

export async function report ({ kind, name, outcome = 'error', status, durationMs, message = '', userId = null, platform = '' }, { fetchImpl = fetch } = {}) {
  const key = process.env.QUILT_REPORT_KEY
  const api = process.env.QUILT_API_URL
  if (!key || !api) return
  try {
    await fetchImpl(`${api}/v1/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-quilt-report-key': key },
      body: JSON.stringify({ surface: 'web', appVersion: process.env.NEXT_PUBLIC_SITE_VERSION || '', platform, userId, events: [{ kind, name, outcome, status, durationMs, message: String(message || '').slice(0, 500) }] }),
      cache: 'no-store',
      signal: AbortSignal.timeout(1500)
    })
  } catch {}
}
```

- [ ] **Step 4: Write the route handler**

```js
// web/app/api/report/route.js
// The browser's way to report a 404 or a crashed page: a small body, forwarded to the
// accounts API with the website's key. Always 204, whatever happened.
import { report, cleanPath, uaFamily } from '@/lib/report.js'
import { currentUser } from '@/lib/session.js'

const KINDS = ['http404', 'error']
const MAX_BODY = 4096

export async function POST (request) {
  try {
    const text = await request.text()
    if (text.length > MAX_BODY) return new Response(null, { status: 204 })
    const body = JSON.parse(text)
    if (!body || typeof body !== 'object' || !KINDS.includes(body.kind)) return new Response(null, { status: 204 })
    let userId = null
    try { userId = (await currentUser())?.id || null } catch {}
    await report({
      kind: body.kind,
      name: cleanPath(body.name),
      status: body.kind === 'http404' ? 404 : undefined,
      message: typeof body.message === 'string' ? body.message : '',
      userId,
      platform: uaFamily(request.headers.get('user-agent') || '')
    })
  } catch {}
  return new Response(null, { status: 204 })
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && node --conditions=react-server --test test/report.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add web/lib/report.js web/app/api/report/route.js web/test/report.test.js
git commit -m "Website: forward 404s and page errors to the accounts API as issue reports

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Styled 404 and error pages that report, and failed API calls

**Files:**
- Create: `web/components/ReportPageIssue.js`, `web/app/not-found.js`, `web/app/error.js`
- Modify: `web/lib/api.js`
- Test: `web/test/api.test.js` (append), `web/test/routes.test.js` (one assertion)

**Interfaces:**
- Consumes: `POST /api/report` (Task 9), `report()` from `web/lib/report.js`.
- Produces: `<ReportPageIssue kind message? />` client component.

- [ ] **Step 1: Write the failing test for `apiCall`**

Append to `web/test/api.test.js`:

```js
test('a failed or slow call to the API is reported once, with the key, and ordinary 4xx answers are not', async () => {
  const { apiCall } = await import('../lib/api.js')
  process.env.QUILT_REPORT_KEY = 'rk_web'
  const before = seen.length
  await apiCall({ accessToken: 'tok', id: 'u-1' }, 'GET', '/v1/boom')
  const rep = seen.slice(before).find((s) => s.url === '/v1/issues')
  assert.ok(rep, 'the 500 was reported')
  assert.equal(rep.body.events[0].name, 'GET /v1/boom'); assert.equal(rep.body.events[0].status, 500); assert.equal(rep.body.events[0].outcome, 'error')
  assert.equal(rep.body.userId, 'u-1')
  const n = seen.length
  await apiCall({ accessToken: 'tok' }, 'GET', '/v1/agents')
  assert.equal(seen.slice(n).filter((s) => s.url === '/v1/issues').length, 0, 'a 200 is not reported')
  delete process.env.QUILT_REPORT_KEY
})
```

The fake server in that file answers 500 for `/v1/boom` and 200 for everything else; the report request itself hits the same server at `/v1/issues` and gets a 200. Also change the server to answer 404 for `/v1/missing` and add, inside the same test, a check that a 404 is reported with `status: 404`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && node --conditions=react-server --test test/api.test.js`
Expected: FAIL, "the 500 was reported".

- [ ] **Step 3: Record from `apiCall`**

Replace `web/lib/api.js` with:

```js
import 'server-only'
import { report } from './report.js'

// Calls the Quilt accounts API as the signed-in person (server-side only: the API
// address and the person's token never need to reach the browser for this).
// A call that fails (no answer, a 404 or a 5xx) or takes over 3 s is reported as an issue;
// the 4xx a route answers on purpose (409 "taken", 400 "empty") is the API working.
const SLOW_MS = 3000
const nameOf = (method, path) => `${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, '/:token').split('?')[0]}`.slice(0, 80)

export async function apiCall (user, method, path, body) {
  // Missing config must fail loudly in production rather than silently calling "undefined/v1/..."
  if (!process.env.QUILT_API_URL && process.env.NODE_ENV === 'production') {
    throw new Error('QUILT_API_URL is not set')
  }
  const started = Date.now()
  let result
  try {
    const res = await fetch(process.env.QUILT_API_URL + path, {
      method,
      headers: { authorization: `Bearer ${user.accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      // A hung API request would otherwise leave the page waiting forever.
      signal: AbortSignal.timeout(15000)
    })
    result = { ok: res.ok, status: res.status, data: await res.json().catch(() => null) }
  } catch {
    result = { ok: false, status: 0, data: null }
  }
  const durationMs = Date.now() - started
  const failed = result.status === 0 || result.status === 404 || result.status >= 500
  if (failed || durationMs > SLOW_MS) {
    await report({ kind: 'action', name: nameOf(method, path), outcome: failed ? 'error' : 'slow', status: result.status || undefined, durationMs, message: failed ? (result.data?.error || `Quilt answered ${result.status}`) : '', userId: user?.id || null })
  }
  return result
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && node --conditions=react-server --test test/api.test.js`
Expected: PASS (including the three earlier tests in the file).

- [ ] **Step 5: The reporting component and the two pages**

```js
// web/components/ReportPageIssue.js
// Posts one report about this page (a 404, or a page that crashed) when it is shown.
// Only the path goes: never the query string or fragment, where invite links keep secrets.
'use client'
import { useEffect, useRef } from 'react'

export default function ReportPageIssue ({ kind, message = '' }) {
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current) return
    sent.current = true
    fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, name: window.location.pathname, message: String(message || '').slice(0, 500) }) }).catch(() => {})
  }, [kind, message])
  return null
}
```

```js
// web/app/not-found.js
// The page for an address that isn't anything: the same shell as the rest of the site,
// a way back, and a quiet report so broken links get noticed.
import Link from 'next/link'
import Header from '@/components/Header.js'
import Footer from '@/components/Footer.js'
import ReportPageIssue from '@/components/ReportPageIssue.js'

export const metadata = { title: 'Page not found' }

export default function NotFound () {
  return (
    <>
      <Header />
      <main className='wrap' style={{ padding: '96px 0' }}>
        <div className='card stack' style={{ maxWidth: 520, margin: '0 auto' }}>
          <h1>That page isn’t here</h1>
          <p className='muted'>The link may be old, or the address may have a typo. Nothing of yours was touched.</p>
          <p><Link className='btn primary' href='/'>Back to Quilt</Link></p>
        </div>
      </main>
      <Footer />
      <ReportPageIssue kind='http404' />
    </>
  )
}
```

Check `Header` and `Footer` are default exports taking no required props (see `web/app/page.js`, which renders `<Header />` and `<Footer />`). If `Header` needs a prop there, pass the same one the landing page does.

```js
// web/app/error.js
// Next's error boundary for a page that crashed while rendering: a short page, a retry,
// and a report with the message so the crash is counted.
'use client'
import ReportPageIssue from '@/components/ReportPageIssue.js'

export default function Error ({ error, reset }) {
  return (
    <main className='wrap' style={{ padding: '96px 0' }}>
      <div className='card stack' style={{ maxWidth: 520, margin: '0 auto' }}>
        <h1>Something went wrong</h1>
        <p className='muted'>This page hit a problem. Trying again usually works.</p>
        <p><button className='btn primary' type='button' onClick={() => reset()}>Try again</button></p>
      </div>
      <ReportPageIssue kind='error' message={error?.message || ''} />
    </main>
  )
}
```

- [ ] **Step 6: Add the 404 assertion to the route test**

In `web/test/routes.test.js`, inside `test('public pages render', ...)` add after the loop:

```js
  const missing = await get('/no-such-page')
  assert.equal(missing.status, 404)
  assert.match(await missing.text(), /That page isn’t here/)
```

- [ ] **Step 7: Run the website tests**

Run: `cd web && npm test`
Expected: PASS. `routes.test.js` builds the site (a minute or two); if the build fails on `not-found.js`, read the error: the usual cause is a component import path or a missing `metadata` export shape.

- [ ] **Step 8: Commit**

```bash
git add web/components/ReportPageIssue.js web/app/not-found.js web/app/error.js web/lib/api.js web/test/api.test.js web/test/routes.test.js
git commit -m "Website: a styled 404 and error page that report themselves, and failed API calls are reported

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Release notes, configuration, deploy

**Files:**
- Modify: `RELEASES.md` (the top, unreleased `0.3.2` section), `fly.api.toml` (the secrets comment), `netlify.toml` (a comment), `issues/026-website-missing-pieces.md` (note the styled 404 is done), `issues/README.md` (status column of 026 if the whole issue is now closed; otherwise leave it)
- Also update the spec: `docs/superpowers/specs/2026-10-01-issue-tracking-design.md`, section "Website", last bullet: `apiCall` reports failures (no answer, 404, 5xx) and slow calls, not every non-ok reply; and section "Desktop app": the UI server does not install process-level handlers; the Electron main process reports `start` and `main` crashes through `ui.report`.

- [ ] **Step 1: Release notes**

Add to the `## 0.3.2` section of `RELEASES.md` (after the existing bullets):

```markdown
- **Quilt notices problems.** When something in the app fails or takes too long (say, Open in Cursor), the app tells Quilt what happened: the action, the error message, how long it took, your app version and OS. Never your files, your chats or your links. Turn it off in Settings under **Send problem reports to Quilt**.
```

- [ ] **Step 2: Configuration notes**

In `fly.api.toml`, extend the `fly secrets set` comment with `QUILT_REPORT_KEY=…` and a line: `# QUILT_REPORT_KEY: the website sends issue reports with it (same value in Netlify's environment).`

In `netlify.toml`, add under the build comments: `# Environment (Netlify UI): NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, QUILT_API_URL, QUILT_REPORT_KEY (same value as the quilt-api Fly secret).`

In `issues/026-website-missing-pieces.md`, under the unstyled-404 item, add: `Styled 404 (and an error page) added with issue tracking, 2026-10-01.`

- [ ] **Step 3: Run everything**

Run: `npm test && (cd web && npm test)`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add RELEASES.md fly.api.toml netlify.toml issues/026-website-missing-pieces.md docs/superpowers/specs/2026-10-01-issue-tracking-design.md
git commit -m "Issues: release notes, the report key in the deploy notes, and the spec brought in line

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: Apply the migration and set the secret**

The accounts project is Supabase `pwebomewzuezaxoowykk`. Apply `supabase/migrations/20261001000000_issues.sql` the way earlier migrations were applied (the Supabase MCP `apply_migration` when it is authorized, otherwise `supabase db push` against the linked project, otherwise paste it into the SQL editor). Then:

```bash
KEY=$(openssl rand -base64 24)
fly secrets set --app quilt-api QUILT_REPORT_KEY="$KEY"
```

and set `QUILT_REPORT_KEY` to the same value in the Netlify site's environment (site id in `netlify.toml`). Confirm with one anonymous report against production once the API is deployed:

```bash
curl -s -X POST https://api.heyquilt.com/v1/issues -H 'content-type: application/json' -d '{"surface":"app","appVersion":"dev","platform":"darwin","events":[{"kind":"error","name":"smoke","outcome":"error","message":"deploy check"}]}'
```

Expected: `{"ok":true,"recorded":1}` and one row in `issues` named `smoke` in the dashboard (then delete it by hand).

- [ ] **Step 6: Deploy**

Per the repo's deploy notes: from a clean clone of `main` (not a worktree), deploy the API (`fly deploy --config fly.api.toml --remote-only --ha=false`) and then the website (`cd web && npm ci && NETLIFY_SITE_ID=… netlify deploy --build --prod`). Then load `https://heyquilt.com/no-such-page`, confirm the styled 404, and confirm a `web`/`http404` row for `/no-such-page` appears in `events`.

---

## Self-review

**Spec coverage.** Data model (Task 3), `record_events` and retention (Tasks 2, 3, 5), `POST /v1/issues` with all three callers and limits (Task 4), the API's self-recording excluding deliberate 4xx (Task 5), the reporter with scrubbing, batching, back-off and flush (Task 6), the UI server's wrapper, `/api/report`, 404s, the setting and `close` flushing (Task 7), the renderer listeners with 10 s dedupe, the Settings toggle and Electron crash reporting (Task 8), the website forwarder, route, pages and `apiCall` (Tasks 9, 10), Netlify/Fly secret, release notes, migration, deploy and smoke check (Task 11). Two deliberate narrowings from the spec are written back into it in Task 11: `apiCall` reports failures and slow calls rather than every non-ok reply, and process-level crash handlers live in the Electron main process rather than the UI server (a Node `quilt ui` keeps Node's default crash behaviour).

**Type consistency.** `Event` fields (`surface, kind, name, outcome, status, durationMs, message, appVersion, platform, userId, deviceId, context, occurredAt, fingerprint`) are the same in Tasks 1 to 5. `recordEvents(list) → number` and `pruneEvents(before) → number` match in both stores. `createReporter` option names match between Task 6 and Task 7's test. `ui.report`/`ui.flushReports` match Tasks 7 and 8. `report()`/`cleanPath()`/`uaFamily()` match Tasks 9 and 10.

**Placeholders.** None: every step has its code or exact command.
