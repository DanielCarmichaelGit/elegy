# Session Activity on the Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in person's dashboard on heyquilt.com shows the Quilt sessions they've been in, their time in each, and who they worked with (people and agents) and for how long; the session owner names and renames sessions.

**Architecture:** The relay (`src/server.js`) records a visit start when a connection with a pass is let into a room and a visit end when it leaves, in a disk-backed queue (`src/presence.js`) that it sends every minute to a new accounts API route, `POST /v1/relay/presence`, authenticated by a shared `RELAY_API_SECRET`. The API stores sessions and visits through a new migration (SQL functions do the ingest atomically) and works out time together with pure interval maths (`src/api/activity.js`) for `GET /v1/me/sessions`, `GET /v1/me/sessions/:room`, `PUT /v1/me/sessions/:room` and `GET /v1/me/collaborators`. The owner's app names a new session after its folder with a new relay admin op `{ op: 'name' }` and can rename it; the website's dashboard lists sessions and has a page per session.

**Tech Stack:** Node 22 (`node:test`, `node:crypto`), `ws`, Yjs, plain-DOM app in `src/ui/`, Postgres functions in Supabase migrations, `@supabase/supabase-js`, Next.js 16 app router in `web/`, Fly.io (relay `cowove-relay`, API `quilt-api`), Netlify (website).

**Spec:** `docs/superpowers/specs/2026-10-01-session-activity-dashboard-design.md`. Read it before starting; this plan argues from it. Two later specs build on this one: `2026-10-02-access-types-and-invites-design.md` reads `relay_sessions.owner_account` and `GET /v1/me/collaborators` (both made here), and `2026-10-02-hosted-agents-design.md` connects agents through the API, which this relay reports like any other pass holder.

## Global Constraints

- Code style: StandardJS (no semicolons, 2-space indent, single quotes, a space before function parens), ES modules, matching the files around it. The website uses JSX in the same style.
- Run `npm test` from the repo root after every task; every test must pass before committing. Tasks that touch `web/` also run `cd web && npm test`.
- Tests never touch the network or production: a local API (`startTestApi`), a local relay (`startServer` on port 0), stand-in `fetch` functions, and injectable clocks (`now`).
- The relay behaves exactly as today unless both `QUILT_API_URL` and `RELAY_API_SECRET` are set, and then reports only connections with a pass.
- Presence is recorded on `enter` (let in, not pending) as a **visit start** `{ room, account: 'kind:sub', name, at }`, and on leave (close, removed, ended, pass lapsed) as a **visit end**. Two connections from the same account are separate visits; the API merges them.
- The queue is in memory and in `<dataDir>/presence-queue.jsonl` (appended and fsynced in batches), sent every **60 s** and on shutdown to `POST <QUILT_API_URL>/v1/relay/presence` with `Authorization: Bearer <RELAY_API_SECRET>`, at most **500** events per request, in order. 2xx drops the sent events; a failure keeps them and retries with backoff up to **10 minutes**. The queue is capped at **100,000** events; beyond that the oldest are dropped, with a log line. On startup the relay ends at "now" every visit it had started and not ended.
- Session names: 1 to 80 characters, trimmed, no control characters. The relay op is `{ op: 'name', name }`, owner only.
- `POST /v1/relay/presence` compares the bearer with `RELAY_API_SECRET` in constant time (otherwise 401). Each event carries a relay-generated uuid `id`; duplicates are ignored.
- Tables: `relay_sessions (room pk, name, owner_account, created_at, last_active_at, renamed_at)`, `session_visits (id, event_start_id unique, room → relay_sessions, account, account_name, kind, started_at, ended_at nullable)`, `relay_events_seen (id pk, received_at)` pruned after **7 days**. RLS on, no client policies.
- The owner is the first account recorded for a room whose `start` event says `owner: true`.
- Visits whose `ended_at` is older than **12 months** (365 days) are deleted daily. Deleting an account deletes its visits and the sessions it owns.
- `GET /v1/me/sessions`: `collaboratingThisWeek` (ms), `topCollaborators` (top 3 this month: `account, name, kind, ms`), and sessions `[ { room, name, owner: { name }, mine, lastActiveAt, myTotalMs, people: [ { account, name, kind, togetherMs, lastTogetherAt } ] } ]`, most recently active first, at most **100**. Weeks start Monday 00:00 in `tz` (IANA, default UTC). Open visits count up to now.
- `GET /v1/me/sessions/:room` adds `visits: [ { startedAt, endedAt } ]` (my last **20**), 404 if I was never in it. `PUT /v1/me/sessions/:room { name }` is owner only (403), sets `renamed_at`, and a later relay `name` event never overwrites it.
- `GET /v1/me/collaborators` → `[{ account, name, kind, lastTogetherAt }]`, most recent first, at most **30**.
- `RELAY_API_SECRET` is a long random secret, a Fly secret on both `quilt-api` and `cowove-relay`, never logged, never printed, never pasted into chat.
- User-facing copy, exactly: `Time collaborating this week`, `Worked with most this month`, `Your sessions`, `No sessions yet. Start one in the Quilt app and it shows up here.`, `People and agents`, `Your recent visits`, `Owned by <name>`, durations like `3h 20m` or `under a minute`, `Rename session…` in the app.
- No em dashes in user-facing text (the website's `web/test/no-em-dash.test.js` enforces it there).

## Decisions made in this plan

The spec leaves these open; this plan settles them:

1. **Event format.** `start`: `{ id, type: 'start', room, account, name, owner?: true, at }`. `end`: `{ id, type: 'end', start: <the start event's id>, room, account, at }` (the start id is what tells two connections from one account apart). `name`: `{ id, type: 'name', room, name, at }`. Times are epoch ms.
2. **Bad events don't block the queue.** The API skips malformed events one by one and answers `{ ok: true, applied, skipped }`, so one odd event can never make the relay retry forever. A body that isn't `{ events: [...] }` is 400, more than 500 events is 413, and an API without `RELAY_API_SECRET` answers 503 `presence is not set up on this server`.
3. **Times.** Event times are clamped to the API's clock (nothing in the future); events older than 12 months are skipped.
4. **Body size.** The presence route takes up to 512 KB (routes can now set `{ maxBody }`); the API's usual limit stays 16 KB.
5. **Cleanup without a timer.** The API has no timer, so the 12-month prune runs "on request": at most once every 24 hours, when the relay next reports. It also deletes sessions left with no visits, and seen event ids older than 7 days.
6. **Atomic ingest.** A Postgres function `ingest_presence(p_events, p_received_at)` applies a whole batch in one call; every step is also idempotent on its own. Reads go through `account_sessions` and `visits_in_rooms`, a page of 1000 rows at a time (PostgREST's row cap).
7. **Account deletion** also deletes the visits of the person's personal agents, since those agents are deleted with the account. A SQL function `delete_account_activity` runs before the auth user is deleted (activity is keyed by `'person:<id>'`, not a foreign key).
8. **Names.** A visit's name is cut to 64 characters (`Quilt user` if empty). Session-name rules live in `src/session-name.js`, shared by the relay, the API and the app, with the message `Give the session a name of 1 to 80 characters.` A session with no name shows as `Untitled session`.
9. **Last active** is "now" while anyone's visit in the session is open.
10. **Response shapes.** `GET /v1/me/sessions` → `{ totals: { collaboratingThisWeek, topCollaborators }, sessions }`, each session also carrying `createdAt` (the session page's "Started"). `GET /v1/me/sessions/:room` → `{ session: { …, visits } }`. `PUT` → `{ session: { room, name } }`. `GET /v1/me/collaborators` → `{ collaborators }`, from the same sessions the overview reads.
11. **"This month"** is the calendar month in `tz`, from the 1st at 00:00. An unknown `tz` is 400 `tz must be an IANA time zone, like Europe/London`.
12. **Both sign-ins.** Every `/v1/me/sessions*` route and `/v1/me/collaborators` accept the website JWT or a computer token (`qd_`): the app renames with its token now, and the access-types invite panel reads collaborators with it later.
13. **The visitor's time zone** reaches the server in a cookie, `quilt_tz`, that a small client component sets from the browser, then refreshes the page. Until then times are UTC.
14. **Relay details.** Without a data dir the queue lives in memory only. The queue file is JSONL; when rewritten (after a send, or after the cap drops events) its first line is `{"open":[…]}`, the visits still open, so a visit whose start was already sent can still be ended after a crash. Appends are fsynced every second. Backoff after consecutive failures: 1, 2, 4, 8, then 10 minutes. Each send times out after 15 s. On shutdown the relay ends every open visit and tries one last send for up to 5 s.
15. **Everyone in the app sees the name.** The relay adds `sessionName` to its member-list message (`MSG_MEMBERS`); the app's session tabs and its "Open now" list show it instead of the folder name.
16. **App rename order.** The app renames on the relay first, then calls `PUT /v1/me/sessions/:room`. A 404 there is fine: the relay hasn't reported the session yet, and the relay's own `name` event carries the new name. The app's server checks the person is the owner too.
17. **Which sessions get a folder name.** New sessions in `create` mode (including a fresh GitHub clone) send the folder's basename, cut to 80 characters, once the relay lets them in as owner. Rejoining or joining never renames.
18. **The secret.** 32 random bytes, base64url. `scripts/relay-api-secret.mjs` stages it (`fly secrets import --stage`) on both apps from one value, printing nothing secret; each app picks it up on its next deploy. `FLY_BIN` points the script at a stand-in for tests.
19. **Relay settings.** `fly.toml` sets `QUILT_API_URL = "https://api.heyquilt.com"` as a plain env var; only the secret is secret.
20. **Version.** The desktop release that names sessions is `0.3.2`.
21. **Website look.** Avatars are initials in a circle (agents in another colour, with a small robot badge, and the existing `Agent` pill in lists). Rows read `Active 2 hours ago · 3h 20m for you`. A person page row reads `1h 5m together · last together 2 hours ago`, and an open visit's end reads `still here`. The summary says `Nobody yet this month.` when there is nobody.
22. **Website tests.** There is no DOM harness, so the pages are covered by pure helpers in `web/lib/activity-view.js`, the build manifest (the session page exists), the signed-out redirect, and the em-dash scan. The API tests cover the data the pages show.
23. **A `name` event for a room the API hasn't seen** creates the session row with no owner (the owner's start always comes first in practice).

## File Structure

New files:

- `src/api/activity.js`: pure interval maths and the dashboard sums: `merge`, `intersect`, `clip`, `total`, `isTimeZone`, `zoneOffset`, `midnightIn`, `weekStart`, `monthStart`, `summarize`, `collaborators`, `myVisits`, constants.
- `supabase/migrations/20261002000000_session_activity.sql`: the three tables and five SQL functions.
- `src/session-name.js`: `cleanSessionName`, `SESSION_NAME_MAX`, `BAD_SESSION_NAME`. Shared by relay, API and app.
- `src/api/routes/relay.js`: `POST /v1/relay/presence` (`relayRoutes`, `cleanEvent`).
- `src/api/routes/sessions.js`: `GET /v1/me/sessions`, `GET|PUT /v1/me/sessions/:room`, `GET /v1/me/collaborators` (`sessionRoutes`).
- `src/presence.js`: the relay's `PresenceReporter` (queue, file, batches, backoff, cap, startup and shutdown).
- `scripts/relay-api-secret.mjs`: makes `RELAY_API_SECRET` and stages it on both Fly apps.
- `web/lib/activity-view.js`: pure helpers for the website (durations, "time ago", time zone, avatars).
- `web/components/Avatars.js`, `web/components/SessionName.js`, `web/components/TimeZoneCookie.js`.
- `web/app/dashboard/sessions/[room]/page.js`: one session.
- Tests: `test/activity.test.js`, `test/api-migration-activity.test.js`, `test/api-store-activity.test.js`, `test/api-supabase-activity.test.js`, `test/api-presence.test.js`, `test/api-sessions.test.js`, `test/presence.test.js`, `test/relay-presence.test.js`, `test/ui-session-name.test.js`, `test/relay-api-secret-script.test.js`, `web/test/activity-view.test.js`.

Modified files:

- `src/api/memory-store.js`, `src/api/supabase-store.js`: activity methods; `deleteUser` removes activity.
- `src/api/server.js`: `relaySecret` option, per-route body limits, `caller` (JWT or `qd_`), the two route modules.
- `bin/quilt.js`: `quilt api` passes `RELAY_API_SECRET`; `quilt serve` says whether presence is on.
- `src/server.js`: presence config, hooks in `enter`/`leave`, the `name` admin op, `sessionName` in member lists, `presence` on the returned server, an async `close`.
- `src/protocol.js`: comments for the new op and field.
- `src/session.js`, `src/runner.js`, `src/account.js`, `src/ui-server.js`, `src/ui/common.js`, `src/ui/session.js`, `src/ui/app.js`, `src/ui/home.js`: naming and renaming in the app.
- `web/app/dashboard/page.js`, `web/app/dashboard/actions.js`, `web/app/globals.css`, `web/test/routes.test.js`.
- `fly.toml`, `fly.api.toml`, `docs/hosting.md`, `RELEASES.md`, `package.json`, `package-lock.json`.

---

### Task 1: Overlap maths

Everything the dashboard shows is worked out from visits by pure functions, so they're built and tested first, with no I/O.

**Files:**
- Create: `src/api/activity.js`
- Create: `test/activity.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (in `src/api/activity.js`):
  - `DAY_MS = 86400000`, `MAX_SESSIONS = 100`, `MAX_PEOPLE_TOP = 3`, `MAX_COLLABORATORS = 30`, `MAX_VISITS = 20`
  - `merge(intervals: [number, number][]): [number, number][]` (sorted, overlapping and touching joined, empty dropped)
  - `intersect(a, b): [number, number][]` (both merged), `clip(list, from, to)`, `total(list): number`
  - `isTimeZone(tz: any): boolean`, `zoneOffset(t, tz): number`, `midnightIn(year, month1to12, day, tz): number`
  - `weekStart(now: number, tz: string): number` (Monday 00:00 in `tz`), `monthStart(now, tz): number`
  - `summarize({ me: string, sessions: Session[], visits: Visit[], now: number, tz?: string }): { totals: { collaboratingThisWeek: number, topCollaborators: { account, name, kind, ms }[] }, sessions: SessionRow[] }`, where `Session = { room, name, ownerAccount, createdAt, lastActiveAt, renamedAt }`, `Visit = { room, account, accountName, kind, startedAt, endedAt | null }`, and `SessionRow = { room, name, owner: { name }, mine, createdAt, lastActiveAt, myTotalMs, people: { account, name, kind, togetherMs, lastTogetherAt }[] }`
  - `collaborators(rows: SessionRow[]): { account, name, kind, lastTogetherAt }[]`
  - `myVisits({ me, visits }): { startedAt, endedAt }[]`

- [ ] **Step 1: Write the failing test**

Create `test/activity.test.js`:

```js
// Time in sessions: merging visits, overlap with others, and weeks and months in a time zone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { merge, intersect, clip, total, isTimeZone, weekStart, monthStart, summarize, collaborators, myVisits } from '../src/api/activity.js'

const T = (iso) => Date.parse(iso)
const MIN = 60 * 1000
const HOUR = 60 * MIN
const visit = (room, account, accountName, from, to, kind = account.split(':')[0]) => ({ room, account, accountName, kind, startedAt: T(from), endedAt: to == null ? null : T(to) })
const session = (room, extra = {}) => ({ room, name: room.toUpperCase(), ownerAccount: 'person:me', createdAt: T('2026-10-01T00:00:00Z'), lastActiveAt: T('2026-10-06T00:00:00Z'), renamedAt: null, ...extra })

test('merge joins overlapping and touching intervals and drops empty ones', () => {
  assert.deepEqual(merge([[5, 7], [1, 3], [2, 4], [4, 5], [9, 9], [10, 8]]), [[1, 7]])
  assert.deepEqual(merge([[1, 2], [3, 4]]), [[1, 2], [3, 4]])
  assert.deepEqual(merge([]), [])
})

test('intersect, clip and total', () => {
  assert.deepEqual(intersect([[0, 10], [20, 30]], [[5, 25]]), [[5, 10], [20, 25]])
  assert.deepEqual(intersect([[0, 5]], [[5, 9]]), [], 'touching is not overlapping')
  assert.deepEqual(clip([[0, 10], [20, 30]], 5, 22), [[5, 10], [20, 22]])
  assert.equal(total([[0, 10], [20, 25]]), 15)
})

test('isTimeZone accepts IANA names and refuses anything else', () => {
  for (const tz of ['UTC', 'Europe/Paris', 'America/New_York']) assert.equal(isTimeZone(tz), true, tz)
  for (const tz of ['', 'Mars/Olympus', 'x'.repeat(65), null, 5]) assert.equal(isTimeZone(tz), false, String(tz))
})

test('a week starts on Monday 00:00 and a month on the 1st, in the given time zone', () => {
  // Tuesday 6 October, 23:00 in New York, is already Wednesday in UTC.
  const now = T('2026-10-07T03:00:00Z')
  assert.equal(weekStart(now, 'UTC'), T('2026-10-05T00:00:00Z'))
  assert.equal(weekStart(now, 'America/New_York'), T('2026-10-05T04:00:00Z'))
  // Sunday evening in Los Angeles is Monday in UTC: the week there began six days earlier.
  assert.equal(weekStart(T('2026-10-12T02:00:00Z'), 'America/Los_Angeles'), T('2026-10-05T07:00:00Z'))
  assert.equal(weekStart(T('2026-10-12T02:00:00Z'), 'UTC'), T('2026-10-12T00:00:00Z'))
  // 1 October, 02:00 UTC is still September in Los Angeles.
  assert.equal(monthStart(T('2026-10-01T02:00:00Z'), 'America/Los_Angeles'), T('2026-09-01T07:00:00Z'))
  assert.equal(monthStart(T('2026-10-01T02:00:00Z'), 'Asia/Tokyo'), T('2026-09-30T15:00:00Z'))
  // Across a daylight-saving change (Europe, 25 October): Monday 26 October starts at UTC+1.
  assert.equal(weekStart(T('2026-10-27T12:00:00Z'), 'Europe/Paris'), T('2026-10-25T23:00:00Z'))
})

test('time together is the overlap of my visits and theirs, never counting two connections twice', () => {
  const now = T('2026-10-06T12:00:00Z')
  const visits = [
    // Me on two computers at once: 09:00-11:00 and 10:00-12:00 merge to 09:00-12:00.
    visit('r1', 'person:me', 'Me', '2026-10-06T09:00:00Z', '2026-10-06T11:00:00Z'),
    visit('r1', 'person:me', 'Me', '2026-10-06T10:00:00Z', '2026-10-06T12:00:00Z'),
    // Dana, also on two connections, 08:00-09:30 and 09:15-10:00: 1h together.
    visit('r1', 'person:dana', 'Dana', '2026-10-06T08:00:00Z', '2026-10-06T09:30:00Z'),
    visit('r1', 'person:dana', 'Dana', '2026-10-06T09:15:00Z', '2026-10-06T10:00:00Z'),
    // An agent from 11:30, still there: open visits count up to now.
    visit('r1', 'agent:a1', 'Larry', '2026-10-06T11:30:00Z', null),
    // Eli came after I left: never shown.
    visit('r1', 'person:eli', 'Eli', '2026-10-06T12:00:00Z', null)
  ]
  const out = summarize({ me: 'person:me', sessions: [session('r1')], visits, now, tz: 'UTC' })
  const [s] = out.sessions
  assert.equal(s.myTotalMs, 3 * HOUR)
  assert.equal(s.lastActiveAt, now, 'someone is still there')
  assert.equal(s.mine, true)
  assert.deepEqual(s.owner, { name: 'Me' })
  assert.deepEqual(s.people, [
    { account: 'person:dana', name: 'Dana', kind: 'person', togetherMs: HOUR, lastTogetherAt: T('2026-10-06T10:00:00Z') },
    { account: 'agent:a1', name: 'Larry', kind: 'agent', togetherMs: 30 * MIN, lastTogetherAt: now }
  ])
  // Collaborating: 09:00-10:00 with Dana, 11:30-12:00 with Larry.
  assert.equal(out.totals.collaboratingThisWeek, 90 * MIN)
  assert.deepEqual(out.totals.topCollaborators.map((c) => [c.account, c.ms]), [['person:dana', HOUR], ['agent:a1', 30 * MIN]])
})

test('only sessions I was in, newest first, with the latest names; the week and month cut the totals', () => {
  const now = T('2026-10-07T12:00:00Z') // a Wednesday
  const visits = [
    // Last week (Thursday 1 October): counts for the month, not the week.
    visit('old', 'person:me', 'Me', '2026-10-01T10:00:00Z', '2026-10-01T12:00:00Z'),
    visit('old', 'person:dana', 'Dana Old', '2026-10-01T10:00:00Z', '2026-10-01T12:00:00Z'),
    // Last month: counts for neither.
    visit('older', 'person:me', 'Me', '2026-09-20T10:00:00Z', '2026-09-20T15:00:00Z'),
    visit('older', 'person:eli', 'Eli', '2026-09-20T10:00:00Z', '2026-09-20T15:00:00Z'),
    // This week, Monday: 30 minutes with Dana, now named "Dana C".
    visit('new', 'person:me', 'Me', '2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z'),
    visit('new', 'person:dana', 'Dana C', '2026-10-05T09:00:00Z', '2026-10-05T11:00:00Z'),
    // A session I was never in.
    visit('theirs', 'person:dana', 'Dana C', '2026-10-06T09:00:00Z', '2026-10-06T11:00:00Z')
  ]
  const sessions = [
    session('old', { lastActiveAt: T('2026-10-01T12:00:00Z'), ownerAccount: 'person:dana' }),
    session('older', { lastActiveAt: T('2026-09-20T15:00:00Z'), ownerAccount: null, name: '' }),
    session('new', { lastActiveAt: T('2026-10-05T11:00:00Z') }),
    session('theirs', { lastActiveAt: T('2026-10-06T11:00:00Z'), ownerAccount: 'person:dana' })
  ]
  const out = summarize({ me: 'person:me', sessions, visits, now, tz: 'UTC' })
  assert.deepEqual(out.sessions.map((s) => s.room), ['new', 'old', 'older'])
  assert.deepEqual(out.sessions.map((s) => s.mine), [true, false, false])
  assert.deepEqual(out.sessions[1].owner, { name: 'Dana Old' })
  assert.deepEqual(out.sessions[2], { ...out.sessions[2], name: '', owner: { name: '' } })
  assert.equal(out.totals.collaboratingThisWeek, 30 * MIN)
  assert.deepEqual(out.totals.topCollaborators, [{ account: 'person:dana', name: 'Dana C', kind: 'person', ms: 2 * HOUR + 30 * MIN }])
})

test('the week boundary follows the time zone', () => {
  // Sunday 11 October 23:30 to Monday 00:30 in New York (03:30-04:30 UTC on the 12th).
  const visits = [
    visit('r', 'person:me', 'Me', '2026-10-12T03:30:00Z', '2026-10-12T04:30:00Z'),
    visit('r', 'person:dana', 'Dana', '2026-10-12T03:30:00Z', '2026-10-12T04:30:00Z')
  ]
  const now = T('2026-10-12T12:00:00Z')
  const sessions = [session('r', { lastActiveAt: T('2026-10-12T04:30:00Z') })]
  assert.equal(summarize({ me: 'person:me', sessions, visits, now, tz: 'America/New_York' }).totals.collaboratingThisWeek, 30 * MIN)
  assert.equal(summarize({ me: 'person:me', sessions, visits, now, tz: 'UTC' }).totals.collaboratingThisWeek, HOUR)
})

test('at most 100 sessions and 3 top collaborators', () => {
  const now = T('2026-10-07T12:00:00Z')
  const sessions = []
  const visits = []
  for (let i = 0; i < 105; i++) {
    const room = `r${i}`
    sessions.push(session(room, { lastActiveAt: now - i * MIN }))
    visits.push(visit(room, 'person:me', 'Me', '2026-10-07T10:00:00Z', '2026-10-07T11:00:00Z'))
    visits.push(visit(room, `person:p${i % 5}`, `P${i % 5}`, '2026-10-07T10:00:00Z', `2026-10-07T10:${String(10 + (i % 5) * 10).padStart(2, '0')}:00Z`))
  }
  const out = summarize({ me: 'person:me', sessions, visits, now, tz: 'UTC' })
  assert.equal(out.sessions.length, 100)
  assert.equal(out.sessions[0].room, 'r0')
  assert.deepEqual(out.totals.topCollaborators.map((c) => c.account), ['person:p4', 'person:p3', 'person:p2'])
})

test('collaborators: everyone I overlapped with, most recent first; my visits newest first', () => {
  const sessions = [
    { people: [{ account: 'person:a', name: 'A', kind: 'person', togetherMs: 1, lastTogetherAt: 10 }, { account: 'agent:b', name: 'B', kind: 'agent', togetherMs: 1, lastTogetherAt: 30 }] },
    { people: [{ account: 'person:a', name: 'A2', kind: 'person', togetherMs: 1, lastTogetherAt: 20 }] }
  ]
  assert.deepEqual(collaborators(sessions), [
    { account: 'agent:b', name: 'B', kind: 'agent', lastTogetherAt: 30 },
    { account: 'person:a', name: 'A2', kind: 'person', lastTogetherAt: 20 }
  ])
  const visits = Array.from({ length: 25 }, (_, i) => ({ room: 'r', account: i === 3 ? 'person:x' : 'person:me', startedAt: i, endedAt: i === 24 ? null : i + 1 }))
  const mine = myVisits({ me: 'person:me', visits })
  assert.equal(mine.length, 20)
  assert.deepEqual(mine[0], { startedAt: 24, endedAt: null })
  assert.equal(mine.some((v) => v.startedAt === 3), false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/activity.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/api/activity.js`.

- [ ] **Step 3: Implement**

Create `src/api/activity.js`:

```js
// Time spent in sessions, from the visits the relay reports (see routes/relay.js).
// Pure: the API's routes hand it rows from the store and the time now. Times are
// epoch ms; an interval is [start, end) and a list of them is kept sorted and merged.

export const DAY_MS = 24 * 60 * 60 * 1000
export const MAX_SESSIONS = 100
export const MAX_PEOPLE_TOP = 3
export const MAX_COLLABORATORS = 30
export const MAX_VISITS = 20

/** Sorted, overlapping and touching intervals joined, empty ones dropped. */
export function merge (intervals) {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])
  const out = []
  for (const [s, e] of sorted) {
    const last = out[out.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/** Where two merged lists overlap, as a merged list. */
export function intersect (a, b) {
  const out = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0])
    const e = Math.min(a[i][1], b[j][1])
    if (e > s) out.push([s, e])
    if (a[i][1] < b[j][1]) i++
    else j++
  }
  return out
}

/** A merged list cut to [from, to). */
export function clip (list, from, to) {
  return list.map(([s, e]) => [Math.max(s, from), Math.min(e, to)]).filter(([s, e]) => e > s)
}

export const total = (list) => list.reduce((n, [s, e]) => n + (e - s), 0)

/** A visit as an interval: an open visit runs until now. */
const span = (v, now) => [v.startedAt, v.endedAt == null ? now : Math.min(v.endedAt, now)]

const formatters = new Map()
function partsIn (t, tz) {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formatters.set(tz, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]))
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, weekday: p.weekday }
}

/** Whether `tz` is an IANA time zone this runtime knows ("Europe/Paris", "UTC"). */
export function isTimeZone (tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return true } catch { return false }
}

/** How far `tz` is ahead of UTC at `t`, in ms. */
export function zoneOffset (t, tz) {
  const p = partsIn(t, tz)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000
}

/** 00:00 on a calendar day in `tz` (month 1-12; days past the month's end roll over). */
export function midnightIn (year, month, day, tz) {
  const guess = Date.UTC(year, month - 1, day)
  const first = guess - zoneOffset(guess, tz)
  return guess - zoneOffset(first, tz)
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Monday 00:00 of the week `now` falls in, in `tz`. */
export function weekStart (now, tz) {
  const p = partsIn(now, tz)
  return midnightIn(p.year, p.month, p.day - WEEKDAYS.indexOf(p.weekday), tz)
}

/** The 1st of the month `now` falls in, 00:00 in `tz`. */
export function monthStart (now, tz) {
  const p = partsIn(now, tz)
  return midnightIn(p.year, p.month, 1, tz)
}

/** The newest name an account went by in these rows. */
function latest (rows) {
  return rows.reduce((a, b) => (b.startedAt > a.startedAt ? b : a))
}

/**
 * The dashboard: for `me` ('person:<id>'), each session in `sessions` I was in, my
 * time there and the people and agents whose visits overlapped mine; plus my time
 * collaborating this week and who I worked with most this month (both in `tz`).
 * `visits` are every visit in those sessions. Nobody I never overlapped with appears.
 */
export function summarize ({ me, sessions, visits, now, tz = 'UTC' }) {
  const byRoom = new Map()
  for (const v of visits) {
    if (!byRoom.has(v.room)) byRoom.set(v.room, [])
    byRoom.get(v.room).push(v)
  }
  const collab = [] // time I overlapped anyone, across every session
  const together = new Map() // account -> { name, kind, spans } across every session
  const rows = []
  for (const s of sessions) {
    const inRoom = byRoom.get(s.room) || []
    const mineRows = inRoom.filter((v) => v.account === me)
    if (!mineRows.length) continue
    const mine = merge(mineRows.map((v) => span(v, now)))
    const others = new Map()
    for (const v of inRoom) {
      if (v.account === me) continue
      if (!others.has(v.account)) others.set(v.account, [])
      others.get(v.account).push(v)
    }
    collab.push(...intersect(mine, merge(inRoom.filter((v) => v.account !== me).map((v) => span(v, now)))))
    const people = []
    for (const [account, theirs] of others) {
      const both = intersect(mine, merge(theirs.map((v) => span(v, now))))
      const ms = total(both)
      if (ms <= 0) continue
      const last = latest(theirs)
      people.push({ account, name: last.accountName, kind: last.kind, togetherMs: ms, lastTogetherAt: both[both.length - 1][1] })
      const t = together.get(account) || { name: last.accountName, kind: last.kind, at: 0, spans: [] }
      if (last.startedAt >= t.at) Object.assign(t, { name: last.accountName, kind: last.kind, at: last.startedAt })
      t.spans.push(...both)
      together.set(account, t)
    }
    people.sort((a, b) => b.togetherMs - a.togetherMs || a.name.localeCompare(b.name))
    const ownerRows = s.ownerAccount ? inRoom.filter((v) => v.account === s.ownerAccount) : []
    const open = inRoom.some((v) => v.endedAt == null)
    rows.push({
      room: s.room,
      name: s.name || '',
      owner: { name: ownerRows.length ? latest(ownerRows).accountName : '' },
      mine: !!s.ownerAccount && s.ownerAccount === me,
      createdAt: s.createdAt,
      lastActiveAt: open ? now : s.lastActiveAt,
      myTotalMs: total(mine),
      people
    })
  }
  rows.sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.room.localeCompare(b.room))
  const week = weekStart(now, tz)
  const month = monthStart(now, tz)
  const topCollaborators = [...together].map(([account, t]) => ({ account, name: t.name, kind: t.kind, ms: total(clip(merge(t.spans), month, now)) }))
    .filter((c) => c.ms > 0)
    .sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name))
    .slice(0, MAX_PEOPLE_TOP)
  return {
    totals: { collaboratingThisWeek: total(clip(merge(collab), week, now)), topCollaborators },
    sessions: rows.slice(0, MAX_SESSIONS)
  }
}

/** Everyone I've overlapped with in these sessions, most recent first (for invites). */
export function collaborators (sessions) {
  const seen = new Map()
  for (const s of sessions) {
    for (const p of s.people) {
      const was = seen.get(p.account)
      if (!was || p.lastTogetherAt > was.lastTogetherAt) seen.set(p.account, { account: p.account, name: p.name, kind: p.kind, lastTogetherAt: p.lastTogetherAt })
    }
  }
  return [...seen.values()].sort((a, b) => b.lastTogetherAt - a.lastTogetherAt).slice(0, MAX_COLLABORATORS)
}

/** My last visits to one session, newest first. */
export function myVisits ({ me, visits }) {
  return visits.filter((v) => v.account === me)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_VISITS)
    .map((v) => ({ startedAt: v.startedAt, endedAt: v.endedAt ?? null }))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/activity.test.js`
Expected: PASS (9 tests).

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/activity.js test/activity.test.js
git commit -m "Add the interval maths for time in sessions and time together"
```

---

### Task 2: Activity tables and the memory store

**Files:**
- Create: `supabase/migrations/20261002000000_session_activity.sql`
- Modify: `src/api/memory-store.js` (new maps, `dropActivity`, `deleteUser`, six new methods after `userEmail`)
- Create: `test/api-migration-activity.test.js`, `test/api-store-activity.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces (store methods, the same in both stores; times are epoch ms):
  - `ingestPresence(events: Event[], receivedAt: number): Promise<number>` (how many were new). `Event` is a cleaned event from Decision 1 (`start` events always carry `owner: boolean` and a non-empty `name`).
  - `accountSessions(account: string, { since: number, limit: number }): Promise<Session[]>`: the sessions `account` has a visit in, the `limit` most recently active plus any active since `since`, newest first.
  - `sessionByRoom(room: string): Promise<Session | null>`
  - `visitsInRooms(rooms: string[]): Promise<Visit[]>` (oldest first; `Visit` also has `id` and `eventStartId`)
  - `renameSession(room, name, at): Promise<Session | null>` (sets `renamedAt = at`)
  - `pruneActivity({ before: number, seenBefore: number }): Promise<void>`
  - `deleteUser(userId)` now also deletes the activity of `person:<userId>` and of that person's agents (`agent:<id>`), and every session such an account owns.
  - SQL: `ingest_presence(jsonb, timestamptz) returns integer`, `account_sessions(text, timestamptz, integer) returns setof relay_sessions`, `visits_in_rooms(text[]) returns setof session_visits`, `prune_activity(timestamptz, timestamptz)`, `delete_account_activity(text[])`.

- [ ] **Step 1: Write the failing tests**

Create `test/api-migration-activity.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = () => fs.readFileSync(new URL('../supabase/migrations/20261002000000_session_activity.sql', import.meta.url), 'utf8')
const table = (s, name) => (s.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`)) || [''])[0]
const TABLES = ['relay_sessions', 'session_visits', 'relay_events_seen']
const FUNCTIONS = ['ingest_presence (jsonb, timestamptz)', 'account_sessions (text, timestamptz, integer)', 'visits_in_rooms (text[])', 'prune_activity (timestamptz, timestamptz)', 'delete_account_activity (text[])']

test('sessions, visits and seen event ids, with the columns the spec names', () => {
  const s = sql()
  const sessions = table(s, 'relay_sessions')
  for (const col of ['room text primary key', 'name text not null', 'owner_account text', 'created_at timestamptz not null', 'last_active_at timestamptz not null', 'renamed_at timestamptz']) assert.ok(sessions.includes(col), col)
  const visits = table(s, 'session_visits')
  for (const col of ['event_start_id uuid not null unique', 'room text not null references public.relay_sessions (room) on delete cascade', 'account text not null', 'account_name text not null', "kind text not null check (kind in ('person', 'agent'))", 'started_at timestamptz not null', 'ended_at timestamptz']) assert.ok(visits.includes(col), col)
  const seen = table(s, 'relay_events_seen')
  for (const col of ['id uuid primary key', 'received_at timestamptz not null']) assert.ok(seen.includes(col), col)
})

test('clients never touch activity: RLS on, no policies, no grants, functions for the service role only', () => {
  const s = sql()
  for (const t of TABLES) assert.match(s, new RegExp(`alter table public\\.${t} enable row level security`), t)
  assert.doesNotMatch(s, /create policy/)
  assert.match(s, /revoke all on public\.relay_sessions, public\.session_visits, public\.relay_events_seen from anon, authenticated;/)
  for (const line of s.split('\n').filter((l) => /^grant\b/.test(l))) assert.doesNotMatch(line, /\b(anon|authenticated)\b/, line)
  for (const f of FUNCTIONS) {
    assert.ok(s.includes(`revoke execute on function public.${f} from public, anon, authenticated;`), f)
    assert.ok(s.includes(`grant execute on function public.${f} to service_role;`), f)
  }
  for (const m of s.matchAll(/create function public\.\w+[\s\S]*?\nas \$\$/g)) assert.match(m[0], /set search_path = ''/, m[0].split('\n')[0])
})

test("a relay name never replaces the owner's rename, and the first owner wins", () => {
  const s = sql()
  assert.match(s, /on conflict \(room\) do update set name = excluded\.name\s+where s\.renamed_at is null;/)
  assert.match(s, /owner_account = coalesce\(s\.owner_account, excluded\.owner_account\)/)
  assert.match(s, /on conflict \(event_start_id\) do nothing;/)
})
```

Create `test/api-store-activity.test.js`:

```js
// Session activity in the memory store, the reference for ingest_presence and the
// other functions in 20261002000000_session_activity.sql.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createMemoryStore } from '../src/api/memory-store.js'

const id = () => crypto.randomUUID()
const DAY = 24 * 60 * 60 * 1000
const start = (room, account, at, extra = {}) => ({ id: id(), type: 'start', room, account, name: account.split(':')[1].toUpperCase(), at, ...extra })
const end = (s, at) => ({ id: id(), type: 'end', start: s.id, room: s.room, account: s.account, at })
const named = (room, name, at) => ({ id: id(), type: 'name', room, name, at })

test('starts open visits and ends close them; the first owner start sets the owner', async () => {
  const s = createMemoryStore()
  const a = start('r1', 'person:dana', 1000)
  const b = start('r1', 'person:eli', 1500, { owner: true })
  const c = start('r1', 'person:fay', 1600, { owner: true })
  assert.equal(await s.ingestPresence([a, b, c, end(a, 3000)], 5000), 4)
  const session = await s.sessionByRoom('r1')
  assert.deepEqual({ ...session }, { room: 'r1', name: '', ownerAccount: 'person:eli', createdAt: 1000, lastActiveAt: 3000, renamedAt: null })
  const visits = await s.visitsInRooms(['r1'])
  assert.deepEqual(visits.map((v) => [v.account, v.accountName, v.kind, v.startedAt, v.endedAt]), [
    ['person:dana', 'DANA', 'person', 1000, 3000],
    ['person:eli', 'ELI', 'person', 1500, null],
    ['person:fay', 'FAY', 'person', 1600, null]
  ])
  assert.equal(visits[0].eventStartId, a.id)
})

test('the same event twice applies once, and an end never moves a visit back before its start', async () => {
  const s = createMemoryStore()
  const a = start('r1', 'agent:a1', 1000)
  const e = end(a, 500)
  assert.equal(await s.ingestPresence([a, e], 1), 2)
  assert.equal(await s.ingestPresence([a, e, end(a, 9000)], 2), 1, 'only the new end is applied')
  const [v] = await s.visitsInRooms(['r1'])
  assert.deepEqual([v.kind, v.startedAt, v.endedAt], ['agent', 1000, 1000], 'the first end wins; a visit ends once')
})

test('the relay names a session until the owner renames it', async () => {
  const s = createMemoryStore()
  await s.ingestPresence([start('r1', 'person:me', 1000, { owner: true }), named('r1', 'quilt-site', 1100)], 1)
  assert.equal((await s.sessionByRoom('r1')).name, 'quilt-site')
  const renamed = await s.renameSession('r1', 'Pricing page', 2000)
  assert.deepEqual([renamed.name, renamed.renamedAt], ['Pricing page', 2000])
  await s.ingestPresence([named('r1', 'something else', 3000)], 2)
  assert.equal((await s.sessionByRoom('r1')).name, 'Pricing page')
  assert.equal(await s.renameSession('nope', 'x', 1), null)
})

test('accountSessions: only rooms the account was in, the newest `limit`, plus any active since `since`', async () => {
  const s = createMemoryStore()
  const events = []
  for (let i = 0; i < 5; i++) events.push(start(`r${i}`, 'person:me', 1000 + i * 100))
  events.push(start('theirs', 'person:dana', 5000))
  await s.ingestPresence(events, 1)
  assert.deepEqual((await s.accountSessions('person:me', { since: Infinity, limit: 2 })).map((x) => x.room), ['r4', 'r3'])
  assert.deepEqual((await s.accountSessions('person:me', { since: 1150, limit: 2 })).map((x) => x.room), ['r4', 'r3', 'r2'])
  assert.deepEqual((await s.accountSessions('person:nobody', { since: 0, limit: 10 })), [])
})

test('pruning drops visits that ended before the cutoff, emptied sessions, and old event ids', async () => {
  const s = createMemoryStore()
  const now = 400 * DAY
  const old = start('old', 'person:me', 1 * DAY)
  const kept = start('kept', 'person:me', 2 * DAY) // still open: never pruned
  const recent = start('recent', 'person:me', 390 * DAY)
  await s.ingestPresence([old, end(old, 2 * DAY), kept, recent, end(recent, 391 * DAY)], 1 * DAY)
  await s.pruneActivity({ before: now - 365 * DAY, seenBefore: now - 7 * DAY })
  assert.deepEqual((await s.visitsInRooms(['old', 'kept', 'recent'])).map((v) => v.room), ['kept', 'recent'])
  assert.equal(await s.sessionByRoom('old'), null)
  assert.ok(await s.sessionByRoom('kept'))
  // The event ids are forgotten, so a replay of the old start applies again.
  assert.equal(await s.ingestPresence([old], now), 1)
})

test("deleting an account deletes its visits, its agents' visits, and the sessions it owns", async () => {
  const s = createMemoryStore()
  s.addUser('u1', { name: 'Dana' })
  s.addUser('u2', { name: 'Eli' })
  const agent = await s.createAgent({ name: 'Larry', provider: 'Anthropic', type: 'coding agent', ownerUserId: 'u1', invitedBy: 'u1' })
  await s.ingestPresence([
    start('owned', 'person:u1', 1000, { owner: true }),
    start('owned', 'person:u2', 1100),
    start('shared', 'person:u2', 1000, { owner: true }),
    start('shared', 'person:u1', 1100),
    start('shared', `agent:${agent.id}`, 1200)
  ], 1)
  await s.deleteUser('u1')
  assert.equal(await s.sessionByRoom('owned'), null)
  assert.deepEqual(await s.visitsInRooms(['owned']), [], "everyone's visits in it go with it")
  assert.deepEqual((await s.visitsInRooms(['shared'])).map((v) => v.account), ['person:u2'])
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/api-migration-activity.test.js test/api-store-activity.test.js`
Expected: FAIL. The migration test with `ENOENT` (no such file), the store test with `TypeError: s.ingestPresence is not a function`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261002000000_session_activity.sql`:

```sql
-- Session activity: the relay reports who is in which session, and when (by
-- account, from their pass), and the website shows people the sessions they
-- were in and who they worked with. Only session names and times are kept: no
-- paths, files or chat. Everything goes through the accounts API, so row-level
-- security is on with no client policies and no client grants.

create table public.relay_sessions (
  room text primary key check (room ~ '^[A-Za-z0-9_-]{1,64}$'),
  name text not null default '' check (char_length(name) <= 80),
  -- 'person:<uuid>' or 'agent:<uuid>': the first account the relay reported as the room's owner.
  owner_account text,
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  -- Set when the owner renames the session; the relay's name no longer replaces it after that.
  renamed_at timestamptz
);
create index relay_sessions_owner_account on public.relay_sessions (owner_account);
create index relay_sessions_last_active_at on public.relay_sessions (last_active_at);

-- One row per connection let into a session. Two computers on one account are two visits;
-- the API merges them when it adds up time.
create table public.session_visits (
  id uuid primary key default gen_random_uuid(),
  -- The relay's id for the "start" event: a replayed event can't make a second visit.
  event_start_id uuid not null unique,
  room text not null references public.relay_sessions (room) on delete cascade,
  account text not null check (account ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$'),
  account_name text not null default '' check (char_length(account_name) <= 64),
  kind text not null check (kind in ('person', 'agent')),
  started_at timestamptz not null,
  ended_at timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
create index session_visits_room on public.session_visits (room, started_at);
create index session_visits_account on public.session_visits (account, room);
create index session_visits_ended_at on public.session_visits (ended_at);

-- Event ids the API has applied, so a batch the relay sends twice applies once. Pruned after 7 days.
create table public.relay_events_seen (
  id uuid primary key,
  received_at timestamptz not null default now()
);
create index relay_events_seen_received_at on public.relay_events_seen (received_at);

alter table public.relay_sessions enable row level security;
alter table public.session_visits enable row level security;
alter table public.relay_events_seen enable row level security;
revoke all on public.relay_sessions, public.session_visits, public.relay_events_seen from anon, authenticated;
grant all on public.relay_sessions, public.session_visits, public.relay_events_seen to service_role;

-- Applies the relay's events in order, each once. Every step is safe to repeat as well.
create function public.ingest_presence (p_events jsonb, p_received_at timestamptz default now())
returns integer
language plpgsql
set search_path = ''
as $$
declare
  e jsonb;
  t timestamptz;
  applied integer := 0;
begin
  for e in select value from jsonb_array_elements(p_events) loop
    insert into public.relay_events_seen (id, received_at) values ((e->>'id')::uuid, p_received_at)
      on conflict (id) do nothing;
    if not found then
      continue;
    end if;
    applied := applied + 1;
    t := to_timestamp((e->>'at')::double precision / 1000);
    if e->>'type' = 'start' then
      insert into public.relay_sessions as s (room, owner_account, created_at, last_active_at)
        values (e->>'room', case when (e->>'owner')::boolean then e->>'account' end, t, t)
        on conflict (room) do update set
          owner_account = coalesce(s.owner_account, excluded.owner_account),
          last_active_at = greatest(s.last_active_at, excluded.last_active_at);
      insert into public.session_visits (event_start_id, room, account, account_name, kind, started_at)
        values ((e->>'id')::uuid, e->>'room', e->>'account', coalesce(e->>'name', ''), split_part(e->>'account', ':', 1), t)
        on conflict (event_start_id) do nothing;
    elsif e->>'type' = 'end' then
      update public.session_visits set ended_at = greatest(started_at, t)
        where event_start_id = (e->>'start')::uuid and ended_at is null;
      update public.relay_sessions set last_active_at = greatest(last_active_at, t)
        where room = e->>'room';
    elsif e->>'type' = 'name' then
      insert into public.relay_sessions as s (room, name, created_at, last_active_at)
        values (e->>'room', e->>'name', t, t)
        on conflict (room) do update set name = excluded.name
        where s.renamed_at is null;
    end if;
  end loop;
  return applied;
end;
$$;

-- The sessions an account was in: the p_limit most recently active, plus any active since p_since.
create function public.account_sessions (p_account text, p_since timestamptz, p_limit integer)
returns setof public.relay_sessions
language sql
stable
set search_path = ''
as $$
  with mine as (
    select s.* from public.relay_sessions s
    where exists (select 1 from public.session_visits v where v.account = p_account and v.room = s.room)
  ), recent as (
    select m.room from mine m order by m.last_active_at desc, m.room limit p_limit
  )
  select m.* from mine m
  where m.room in (select r.room from recent r) or m.last_active_at >= p_since
  order by m.last_active_at desc, m.room;
$$;

-- Every visit in these sessions (the API works out who overlapped whom).
create function public.visits_in_rooms (p_rooms text[])
returns setof public.session_visits
language sql
stable
set search_path = ''
as $$
  select v.* from public.session_visits v where v.room = any (p_rooms) order by v.started_at, v.id;
$$;

-- Visits that ended before p_before go, then sessions left with no visits, then old event ids.
create function public.prune_activity (p_before timestamptz, p_seen_before timestamptz)
returns void
language sql
set search_path = ''
as $$
  delete from public.session_visits where ended_at < p_before;
  delete from public.relay_sessions s where s.last_active_at < p_before
    and not exists (select 1 from public.session_visits v where v.room = s.room);
  delete from public.relay_events_seen where received_at < p_seen_before;
$$;

-- Deleting an account: its sessions (with everyone's visits in them) and its own visits.
create function public.delete_account_activity (p_accounts text[])
returns void
language sql
set search_path = ''
as $$
  delete from public.relay_sessions where owner_account = any (p_accounts);
  delete from public.session_visits where account = any (p_accounts);
$$;

revoke execute on function public.ingest_presence (jsonb, timestamptz) from public, anon, authenticated;
revoke execute on function public.account_sessions (text, timestamptz, integer) from public, anon, authenticated;
revoke execute on function public.visits_in_rooms (text[]) from public, anon, authenticated;
revoke execute on function public.prune_activity (timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.delete_account_activity (text[]) from public, anon, authenticated;
grant execute on function public.ingest_presence (jsonb, timestamptz) to service_role;
grant execute on function public.account_sessions (text, timestamptz, integer) to service_role;
grant execute on function public.visits_in_rooms (text[]) to service_role;
grant execute on function public.prune_activity (timestamptz, timestamptz) to service_role;
grant execute on function public.delete_account_activity (text[]) to service_role;
```

- [ ] **Step 4: Add the memory store methods**

In `src/api/memory-store.js`, change the line

```js
  const agentInvites = new Map(); const keyRows = new Map()
```

to

```js
  const agentInvites = new Map(); const keyRows = new Map()
  const relaySessions = new Map(); const visits = new Map(); const seenEvents = new Map()
```

Just before `  return {` (the line before `    addUser (userId, …`), add:

```js
  // Deleting an account takes the sessions it owns (with everyone's visits in them) and its
  // own visits, like delete_account_activity.
  const dropActivity = (accounts) => {
    for (const [room, s] of relaySessions) if (accounts.includes(s.ownerAccount)) relaySessions.delete(room)
    for (const [id, v] of visits) if (accounts.includes(v.account) || !relaySessions.has(v.room)) visits.delete(id)
  }

```

Make the first line of `deleteUser` (before `profiles.delete(userId); users.delete(userId)`):

```js
      dropActivity([`person:${userId}`, ...all(agents, (a) => a.ownerUserId === userId).map((a) => `agent:${a.id}`)])
```

After the `userEmail` method:

```js
    // The address a person signs in with, and whether they've confirmed it.
    async userEmail (userId) { const u = users.get(userId); return u ? { ...u } : null },
```

add:

```js
    // Session activity, as the relay reports it (routes/relay.js). Mirrors ingest_presence:
    // events apply in order, each once; returns how many were new.
    async ingestPresence (events, receivedAt) {
      let applied = 0
      for (const e of events) {
        if (seenEvents.has(e.id)) continue
        seenEvents.set(e.id, receivedAt)
        applied++
        const s = relaySessions.get(e.room)
        if (e.type === 'start') {
          if (!s) relaySessions.set(e.room, { room: e.room, name: '', ownerAccount: e.owner ? e.account : null, createdAt: e.at, lastActiveAt: e.at, renamedAt: null })
          else {
            if (!s.ownerAccount && e.owner) s.ownerAccount = e.account
            s.lastActiveAt = Math.max(s.lastActiveAt, e.at)
          }
          if (!all(visits, (v) => v.eventStartId === e.id).length) {
            const v = { id: uuid(), eventStartId: e.id, room: e.room, account: e.account, accountName: e.name || '', kind: e.account.split(':')[0], startedAt: e.at, endedAt: null }
            visits.set(v.id, v)
          }
        } else if (e.type === 'end') {
          for (const v of visits.values()) if (v.eventStartId === e.start && v.endedAt == null) v.endedAt = Math.max(v.startedAt, e.at)
          if (s) s.lastActiveAt = Math.max(s.lastActiveAt, e.at)
        } else if (e.type === 'name') {
          if (!s) relaySessions.set(e.room, { room: e.room, name: e.name, ownerAccount: null, createdAt: e.at, lastActiveAt: e.at, renamedAt: null })
          else if (s.renamedAt == null) s.name = e.name
        }
      }
      return applied
    },
    // The sessions an account was in: the `limit` most recently active, plus any active since `since`.
    async accountSessions (account, { since, limit }) {
      const rooms = new Set(all(visits, (v) => v.account === account).map((v) => v.room))
      const list = all(relaySessions, (s) => rooms.has(s.room)).sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.room.localeCompare(b.room))
      const keep = new Set(list.slice(0, limit))
      return list.filter((s) => keep.has(s) || s.lastActiveAt >= since).map(copy)
    },
    async sessionByRoom (room) { return copy(relaySessions.get(room)) },
    async visitsInRooms (rooms) {
      const set = new Set(rooms)
      return all(visits, (v) => set.has(v.room)).sort((a, b) => a.startedAt - b.startedAt).map(copy)
    },
    // The owner's rename: from now on the relay's name events leave it alone.
    async renameSession (room, name, at) {
      const s = relaySessions.get(room)
      if (!s) return null
      Object.assign(s, { name, renamedAt: at })
      return copy(s)
    },
    // Mirrors prune_activity.
    async pruneActivity ({ before, seenBefore }) {
      for (const [id, v] of visits) if (v.endedAt != null && v.endedAt < before) visits.delete(id)
      for (const [room, s] of relaySessions) if (s.lastActiveAt < before && !all(visits, (v) => v.room === room).length) relaySessions.delete(room)
      for (const [id, at] of seenEvents) if (at < seenBefore) seenEvents.delete(id)
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/api-migration-activity.test.js test/api-store-activity.test.js`
Expected: PASS.

Optional, if Postgres is installed locally (`which pg_ctl`), check the SQL itself runs:

```bash
D="$(mktemp -d)" && initdb -D "$D/pg" -U postgres >/dev/null && \
  pg_ctl -D "$D/pg" -o "-p 54329 -k '' -h 127.0.0.1" -l "$D/log" start >/dev/null && sleep 2 && \
  psql -h 127.0.0.1 -p 54329 -U postgres -v ON_ERROR_STOP=1 -q \
    -c 'create role anon; create role authenticated; create role service_role;' \
    -f supabase/migrations/20261002000000_session_activity.sql \
    -c "select public.ingest_presence('[{\"id\":\"11111111-1111-1111-1111-111111111111\",\"type\":\"start\",\"room\":\"r1\",\"account\":\"person:me\",\"name\":\"Me\",\"owner\":true,\"at\":1759744800000}]'::jsonb, now());" ; \
  pg_ctl -D "$D/pg" stop >/dev/null
```

Expected: the last command prints `1`.

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261002000000_session_activity.sql src/api/memory-store.js test/api-migration-activity.test.js test/api-store-activity.test.js
git commit -m "Store session activity: sessions, visits and seen event ids"
```

---

### Task 3: The Supabase store's activity methods

**Files:**
- Modify: `src/api/supabase-store.js` (a column list, a paging helper, `deleteUser`, six methods)
- Create: `test/api-supabase-activity.test.js`

**Interfaces:**
- Consumes: the SQL functions and the store method contract from Task 2.
- Produces: the same six methods and the extended `deleteUser` on `createSupabaseStore(...)`.

- [ ] **Step 1: Write the failing test**

Create `test/api-supabase-activity.test.js`:

```js
// The Supabase store's session-activity methods, against a stand-in client that
// records each call: they go through the SQL functions, a page at a time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStore } from '../src/api/supabase-store.js'

// A stand-in supabase client. `answer(call)` gives each query's rows; every call is kept.
function fakeClient (answer = () => []) {
  const calls = []
  const chain = (call) => new Proxy({}, {
    get (_, op) {
      if (op === 'then') return (res, rej) => Promise.resolve({ data: answer(call), error: null }).then(res, rej)
      return (...args) => { call.ops.push([op, ...args]); return chain(call) }
    }
  })
  const client = {
    from (table) { const call = { table, ops: [] }; calls.push(call); return chain(call) },
    rpc (fn, args) { const call = { rpc: fn, args, ops: [] }; calls.push(call); return chain(call) },
    auth: { admin: { deleteUser: async (id) => { calls.push({ deletedUser: id }); return { error: null } } } }
  }
  return { client, calls }
}

test('ingestPresence hands the events to ingest_presence with the time they arrived', async () => {
  const { client, calls } = fakeClient(() => 2)
  const s = createSupabaseStore({ client })
  const events = [{ id: 'e1', type: 'start', room: 'r1', account: 'person:u1', name: 'Dana', at: 1000 }]
  assert.equal(await s.ingestPresence(events, Date.parse('2026-10-02T00:00:00Z')), 2)
  assert.deepEqual(calls[0], { rpc: 'ingest_presence', args: { p_events: events, p_received_at: '2026-10-02T00:00:00.000Z' }, ops: [] })
})

test('visits are read a page of 1000 at a time until a short page', async () => {
  const row = (i) => ({ id: `v${i}`, event_start_id: `e${i}`, room: 'r1', account: 'person:u1', account_name: 'Dana', kind: 'person', started_at: '2026-10-01T00:00:00Z', ended_at: null })
  const { client, calls } = fakeClient((call) => {
    const [, from] = call.ops.find(([op]) => op === 'range')
    return Array.from({ length: from === 0 ? 1000 : 3 }, (_, i) => row(from + i))
  })
  const s = createSupabaseStore({ client })
  const visits = await s.visitsInRooms(['r1'])
  assert.equal(visits.length, 1003)
  assert.deepEqual(calls.map((c) => [c.rpc, c.args.p_rooms, c.ops]), [
    ['visits_in_rooms', ['r1'], [['range', 0, 999]]],
    ['visits_in_rooms', ['r1'], [['range', 1000, 1999]]]
  ])
  assert.deepEqual([visits[0].eventStartId, visits[0].accountName, visits[0].startedAt, visits[0].endedAt], ['e0', 'Dana', Date.parse('2026-10-01T00:00:00Z'), null])
  assert.deepEqual(await s.visitsInRooms([]), [], 'no rooms, no query')
  assert.equal(calls.length, 2)
})

test('accountSessions, renameSession and pruneActivity call their functions with ISO times', async () => {
  const { client, calls } = fakeClient((call) => (call.rpc === 'account_sessions' ? [{ room: 'r1', name: 'x', owner_account: null, created_at: '2026-10-01T00:00:00Z', last_active_at: '2026-10-01T00:00:00Z', renamed_at: null }] : { room: 'r1', name: 'New', renamed_at: '2026-10-02T00:00:00Z' }))
  const s = createSupabaseStore({ client })
  const [row] = await s.accountSessions('person:u1', { since: Date.parse('2026-09-28T00:00:00Z'), limit: 100 })
  assert.equal(row.lastActiveAt, Date.parse('2026-10-01T00:00:00Z'))
  assert.deepEqual(calls[0].args, { p_account: 'person:u1', p_since: '2026-09-28T00:00:00.000Z', p_limit: 100 })
  await s.renameSession('r1', 'New', Date.parse('2026-10-02T00:00:00Z'))
  assert.equal(calls[1].table, 'relay_sessions')
  assert.deepEqual(calls[1].ops[0], ['update', { name: 'New', renamed_at: '2026-10-02T00:00:00.000Z' }])
  assert.deepEqual(calls[1].ops[1], ['eq', 'room', 'r1'])
  await s.pruneActivity({ before: 0, seenBefore: 1000 })
  assert.deepEqual(calls[2], { rpc: 'prune_activity', args: { p_before: '1970-01-01T00:00:00.000Z', p_seen_before: '1970-01-01T00:00:01.000Z' }, ops: [] })
})

test("deleting a user removes its activity and its agents' before the auth user", async () => {
  const { client, calls } = fakeClient((call) => (call.table === 'agents' ? [{ id: 'a1' }, { id: 'a2' }] : null))
  const s = createSupabaseStore({ client })
  await s.deleteUser('u1')
  assert.deepEqual(calls[0].ops, [['select', 'id'], ['eq', 'owner_user_id', 'u1']])
  assert.deepEqual([calls[1].rpc, calls[1].args], ['delete_account_activity', { p_accounts: ['person:u1', 'agent:a1', 'agent:a2'] }])
  assert.deepEqual(calls[2], { deletedUser: 'u1' })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/api-supabase-activity.test.js`
Expected: FAIL with `TypeError: s.ingestPresence is not a function`.

- [ ] **Step 3: Implement**

In `src/api/supabase-store.js`, after the `AGENT_KEY` constant add:

```js
const RELAY_SESSION = 'room, name, owner_account, created_at, last_active_at, renamed_at'
// PostgREST hands back at most 1000 rows per request: longer lists are read a page at a time.
const PAGE = 1000
```

Inside `createSupabaseStore`, just before `  const memberOf = async (orgId, userId) =>`, add:

```js
  // Every row of a query, a page at a time. `build` makes a fresh query (with a stable order) per page.
  const pages = async (build) => {
    const out = []
    for (let from = 0; ; from += PAGE) {
      const rows = await one(build().range(from, from + PAGE - 1))
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
  }
```

Replace `deleteUser` (its comment and body) with:

```js
    // Deleting the auth user cascades through profiles, devices, links and agents. Session
    // activity is keyed by 'person:<id>' and 'agent:<id>', not foreign keys, so it goes first.
    async deleteUser (userId) {
      const agents = await one(db.from('agents').select('id').eq('owner_user_id', userId))
      await one(db.rpc('delete_account_activity', { p_accounts: [`person:${userId}`, ...agents.map((a) => `agent:${a.id}`)] }))
      const { error } = await db.auth.admin.deleteUser(userId)
      if (error) throw error
    },
```

Just before the comment `    // Orgs. create_org makes the org, …`, add:

```js
    // Session activity (see 20261002000000_session_activity.sql). Event times are epoch ms.
    async ingestPresence (events, receivedAt) {
      return await one(db.rpc('ingest_presence', { p_events: events, p_received_at: ts(receivedAt) }))
    },
    async accountSessions (account, { since, limit }) {
      return (await pages(() => db.rpc('account_sessions', { p_account: account, p_since: ts(since), p_limit: limit }))).map(rowFrom)
    },
    async sessionByRoom (room) { return rowFrom(await one(db.from('relay_sessions').select(RELAY_SESSION).eq('room', room).maybeSingle())) },
    async visitsInRooms (rooms) {
      if (!rooms.length) return []
      return (await pages(() => db.rpc('visits_in_rooms', { p_rooms: rooms }))).map(rowFrom)
    },
    async renameSession (room, name, at) {
      return rowFrom(await one(db.from('relay_sessions').update({ name, renamed_at: ts(at) }).eq('room', room).select(RELAY_SESSION).maybeSingle()))
    },
    async pruneActivity ({ before, seenBefore }) {
      await one(db.rpc('prune_activity', { p_before: ts(before), p_seen_before: ts(seenBefore) }))
    },

```

(`rowFrom` already turns `started_at`, `ended_at`, `last_active_at`, `renamed_at` and `created_at` into epoch ms, and `event_start_id`, `account_name` and `owner_account` into camelCase.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/api-supabase-activity.test.js test/api-supabase-store.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/supabase-store.js test/api-supabase-activity.test.js
git commit -m "Read and write session activity in Supabase through its SQL functions"
```

---

### Task 4: `POST /v1/relay/presence`

**Files:**
- Create: `src/session-name.js`
- Create: `src/api/routes/relay.js`
- Modify: `src/api/server.js` (import, `startApi` option, `ctx`, per-route body limit, `readJson`)
- Modify: `bin/quilt.js` (`apiCmd`)
- Create: `test/api-presence.test.js`

**Interfaces:**
- Consumes: `store.ingestPresence`, `store.pruneActivity`, `store.deleteUser` (Task 2); `DAY_MS` (Task 1); `HttpError`, `UUID`, `stripInvisible` from `src/api/http.js`.
- Produces:
  - `src/session-name.js`: `SESSION_NAME_MAX = 80`, `cleanSessionName(value: any): string | null`, `BAD_SESSION_NAME = 'Give the session a name of 1 to 80 characters.'`
  - `src/api/routes/relay.js`: `MAX_EVENTS = 500`, `PRESENCE_BODY = 524288`, `KEEP_MS`, `SEEN_MS`, `cleanEvent(e, now): Event | null`, `relayRoutes({ store, now, log, bearer, relaySecret })`
  - `startApi({ …, relaySecret = '' })`; `POST /v1/relay/presence { events }` → `{ ok: true, applied, skipped }`; 401 for a wrong secret, 503 without one.
  - A route tuple may carry a fourth element `{ maxBody }`.
  - The route context `ctx` gains `bearer` and `relaySecret`.

- [ ] **Step 1: Write the failing test**

Create `test/api-presence.test.js`:

```js
// POST /v1/relay/presence: the relay reports who is in which session, and when.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startTestApi } from './api-helpers.js'

const SECRET = 'test-relay-secret-0123456789'
const T = (iso) => Date.parse(iso)
let clock = T('2026-10-07T12:00:00Z')
let t
before(async () => { t = await startTestApi({ relaySecret: SECRET, now: () => clock }) })
after(() => t.close())
beforeEach(() => { clock = T('2026-10-07T12:00:00Z') })

let rooms = 0
const room = () => `pres-${++rooms}`
const report = (events, secret = SECRET) => t.call('POST', '/v1/relay/presence', { events }, null, secret === null ? {} : { authorization: `Bearer ${secret}` })
const start = (r, account, name, at, extra = {}) => ({ id: crypto.randomUUID(), type: 'start', room: r, account, name, at: T(at), ...extra })
const end = (s, at) => ({ id: crypto.randomUUID(), type: 'end', start: s.id, room: s.room, account: s.account, at: T(at) })
const named = (r, name, at) => ({ id: crypto.randomUUID(), type: 'name', room: r, name, at: T(at) })

test('only the relay, with RELAY_API_SECRET, may report presence', async () => {
  assert.equal((await report([], null)).status, 401)
  assert.equal((await report([], 'wrong')).status, 401)
  assert.equal((await report([], `${SECRET}x`)).status, 401)
  assert.deepEqual((await report([])).body, { ok: true, applied: 0, skipped: 0 })
  const off = await startTestApi()
  try {
    const r = await off.call('POST', '/v1/relay/presence', { events: [] }, null, { authorization: `Bearer ${SECRET}` })
    assert.equal(r.status, 503)
  } finally { await off.close() }
})

test('a report takes up to 500 events (more than the usual body limit), skips bad ones, and ignores replays', async () => {
  const r = room()
  const many = Array.from({ length: 500 }, (_, i) => start(r, `person:p${i}`, `Person ${i}`, '2026-10-07T10:00:00Z'))
  const first = await report(many)
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.applied, 500)
  assert.equal((await report(many)).body.applied, 0, 'the same events again change nothing')
  assert.equal((await t.store.visitsInRooms([r])).length, 500)
  assert.equal((await report([...many, many[0]])).status, 413)
  const bad = [
    { ...start(r, 'person:x', 'X', '2026-10-07T10:00:00Z'), id: 'not-a-uuid' },
    start('bad room!', 'person:x', 'X', '2026-10-07T10:00:00Z'),
    start(r, 'robot:x', 'X', '2026-10-07T10:00:00Z'),
    start(r, 'person:x', 'X', '2025-09-01T00:00:00Z'), // older than 12 months
    named(r, '', '2026-10-07T10:00:00Z'),
    named(r, 'x'.repeat(81), '2026-10-07T10:00:00Z'),
    { id: crypto.randomUUID(), type: 'wave', room: r, at: clock },
    null
  ]
  assert.deepEqual((await report(bad)).body, { ok: true, applied: 0, skipped: 8 })
  assert.equal((await report({ not: 'a list' })).status, 400)
})

test('visits open and close, the owner is the first owner start, and the relay names the session', async () => {
  const r = room()
  const mo = start(r, 'person:mem', 'Mo', '2026-10-07T09:00:00Z', { owner: true })
  const ada = start(r, 'person:admin', '  Ada‮  ', '2026-10-07T09:30:00Z')
  const late = start(r, 'person:lim', 'Lin', '2026-10-07T09:40:00Z', { owner: true })
  // The relay's clock may run ahead of the API's: nothing is recorded in the future.
  await report([mo, ada, late, end(ada, '2026-10-07T10:30:00Z'), named(r, 'quilt-site', '2026-10-07T09:01:00Z'), end(late, '2026-10-07T13:00:00Z')])
  const s = await t.store.sessionByRoom(r)
  assert.deepEqual([s.name, s.ownerAccount, s.createdAt, s.lastActiveAt], ['quilt-site', 'person:mem', T('2026-10-07T09:00:00Z'), clock])
  const visits = await t.store.visitsInRooms([r])
  assert.deepEqual(visits.map((v) => [v.account, v.accountName, v.endedAt]), [
    ['person:mem', 'Mo', null],
    ['person:admin', 'Ada', T('2026-10-07T10:30:00Z')],
    ['person:lim', 'Lin', clock]
  ])
})

test('visits that ended over 12 months ago are deleted once a day, when the relay reports', async () => {
  const r = room()
  const s = start(r, 'person:lim', 'Lin', '2026-10-21T10:00:00Z')
  clock = T('2027-10-20T12:00:00Z') // over a day since the last prune: this report prunes
  await report([s, end(s, '2026-10-21T11:00:00Z')])
  assert.equal((await t.store.visitsInRooms([r])).length, 1, 'ended less than 12 months ago')
  clock = T('2027-10-21T11:30:00Z') // over 12 months now, but the last prune was under a day ago
  await report([])
  assert.equal((await t.store.visitsInRooms([r])).length, 1)
  clock = T('2027-10-21T12:00:00Z')
  await report([])
  assert.deepEqual(await t.store.visitsInRooms([r]), [])
  assert.equal(await t.store.sessionByRoom(r), null, 'and the session, now empty')
})

test('deleting an account deletes its visits and the sessions it owns', async () => {
  const r = room()
  const shared = room()
  t.store.addUser('gone', { name: 'Gwen', email: 'gwen@else.com' })
  await report([
    start(r, 'person:gone', 'Gwen', '2026-10-07T08:00:00Z', { owner: true }),
    start(r, 'person:lim', 'Lin', '2026-10-07T08:00:00Z'),
    start(shared, 'person:lim', 'Lin', '2026-10-07T08:00:00Z', { owner: true }),
    start(shared, 'person:gone', 'Gwen', '2026-10-07T08:00:00Z')
  ])
  assert.equal((await t.call('DELETE', '/v1/me/account', null, 'gone')).status, 200)
  assert.equal(await t.store.sessionByRoom(r), null, 'her session is gone, for everyone')
  assert.deepEqual((await t.store.visitsInRooms([r, shared])).map((v) => v.account), ['person:lim'])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/api-presence.test.js`
Expected: FAIL: the route doesn't exist yet, so the first test gets `404 !== 401`.

- [ ] **Step 3: Implement**

Create `src/session-name.js`:

```js
// Session names: the owner's app names a session after its folder, and the owner can
// rename it. The relay and the accounts API both check names with this.
export const SESSION_NAME_MAX = 80
// C0 and C1 control characters, including newlines and tabs.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** The name trimmed, or null unless it is 1 to 80 characters with no control characters. */
export function cleanSessionName (value) {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || [...name].length > SESSION_NAME_MAX || CONTROL.test(name)) return null
  return name
}

export const BAD_SESSION_NAME = 'Give the session a name of 1 to 80 characters.'
```

Create `src/api/routes/relay.js`:

```js
// The relay reports who is in which session and when (src/presence.js on the relay). It
// signs in with RELAY_API_SECRET. Each event applies once: replays are ignored.
import crypto from 'node:crypto'
import { HttpError, UUID, stripInvisible } from '../http.js'
import { DAY_MS } from '../activity.js'
import { cleanSessionName } from '../../session-name.js'

export const MAX_EVENTS = 500
// 500 events of a few hundred bytes each: more than the API's usual 16 KB.
export const PRESENCE_BODY = 512 * 1024
export const KEEP_MS = 365 * DAY_MS
export const SEEN_MS = 7 * DAY_MS
const ROOM = /^[A-Za-z0-9_-]{1,64}$/
const ACCOUNT = /^(person|agent):[A-Za-z0-9_-]{1,64}$/

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest()

/** An event as the store takes it, or null when it isn't one (it is skipped, not retried). */
export function cleanEvent (e, now) {
  if (!e || typeof e !== 'object' || !UUID.test(String(e.id)) || !ROOM.test(String(e.room)) || !Number.isFinite(e.at)) return null
  // The relay's clock may run ahead; nothing is recorded in the future.
  const at = Math.min(e.at, now)
  if (at < now - KEEP_MS) return null
  const base = { id: String(e.id).toLowerCase(), type: e.type, room: e.room, at }
  if (e.type === 'start') {
    if (!ACCOUNT.test(String(e.account))) return null
    const name = stripInvisible(e.name).slice(0, 64).join('').trim() || 'Quilt user'
    return { ...base, account: e.account, name, owner: e.owner === true }
  }
  if (e.type === 'end') {
    if (!ACCOUNT.test(String(e.account)) || !UUID.test(String(e.start))) return null
    return { ...base, account: e.account, start: String(e.start).toLowerCase() }
  }
  if (e.type === 'name') {
    const name = cleanSessionName(e.name)
    return name ? { ...base, name } : null
  }
  return null
}

export function relayRoutes ({ store, now, log, bearer, relaySecret }) {
  let prunedAt = 0
  const fromRelay = (req) => {
    if (!relaySecret) throw new HttpError(503, 'presence is not set up on this server')
    // Hashed first so the comparison takes the same time whatever was sent.
    if (!crypto.timingSafeEqual(digest(bearer(req)), digest(relaySecret))) throw new HttpError(401, 'only the relay may report presence')
  }

  return [
    ['POST', /^\/v1\/relay\/presence$/, async (req, body) => {
      fromRelay(req)
      if (!Array.isArray(body.events)) throw new HttpError(400, 'events must be a list')
      if (body.events.length > MAX_EVENTS) throw new HttpError(413, `at most ${MAX_EVENTS} events at a time`)
      const t = now()
      const events = body.events.map((e) => cleanEvent(e, t)).filter(Boolean)
      const applied = events.length ? await store.ingestPresence(events, t) : 0
      // Visits older than 12 months go once a day, when the relay next reports (the API has no timer).
      if (t - prunedAt >= DAY_MS) {
        prunedAt = t
        await store.pruneActivity({ before: t - KEEP_MS, seenBefore: t - SEEN_MS })
          .catch((err) => log(`could not prune session activity: ${err?.message || err}`))
      }
      return { ok: true, applied, skipped: body.events.length - events.length }
    }, { maxBody: PRESENCE_BODY }]
  ]
}
```

In `src/api/server.js`:

- After `import { joinRoutes } from './routes/join.js'` add:

  ```js
  import { relayRoutes } from './routes/relay.js'
  ```

- In the `startApi` parameter list, change `passKey = '', passLimit = 60 })` to `passKey = '', passLimit = 60, relaySecret = '' })`.
- Replace the `ctx` line and the `routes.push(…)` line under `// Org routes live in their own modules…` with:

  ```js
  const ctx = { store, user, bearer, now, site, apiUrl: api, mailer, log, limit: limitInvites, limitSend: limitInviteSend, limitTokens, limitJoin, agentAuth, relaySecret }
  routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx), ...agentRoutes(ctx), ...agentInviteRoutes(ctx), ...joinRoutes(ctx), ...relayRoutes(ctx))
  ```

- In the request handler, replace

  ```js
      const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {}
  ```

  with

  ```js
      // A route may take a bigger body than usual (the relay's presence reports): route[3].maxBody.
      const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req, route[3]?.maxBody || MAX_BODY) : {}
  ```

- Change `readJson` to take the limit: its first line becomes `function readJson (req, limit) {`, and in its `data` handler `if (size > MAX_BODY)` becomes `if (size > limit)`.

In `bin/quilt.js`, in `apiCmd`, change the `startApi({` call's first line from

```js
    port, host, store, verifyUser, mailer, passKey,
```

to

```js
    port, host, store, verifyUser, mailer, passKey,
    // The relay signs its presence reports with this (scripts/relay-api-secret.mjs).
    relaySecret: env.RELAY_API_SECRET || '',
```

and after the line that logs `quilt accounts API listening on …` add:

```js
  if (!env.RELAY_API_SECRET) console.log('RELAY_API_SECRET is not set: the relay cannot report sessions for the dashboard')
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/api-presence.test.js`
Expected: PASS (5 tests).

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-name.js src/api/routes/relay.js src/api/server.js bin/quilt.js test/api-presence.test.js
git commit -m "Take presence reports from the relay, signed with RELAY_API_SECRET"
```

---

### Task 5: Reading sessions, renaming, and collaborators

**Files:**
- Create: `src/api/routes/sessions.js`
- Modify: `src/api/server.js` (`caller`, `ctx`, the route list)
- Create: `test/api-sessions.test.js`

**Interfaces:**
- Consumes: `summarize`, `collaborators`, `myVisits`, `isTimeZone`, `weekStart`, `monthStart`, `MAX_SESSIONS` (Task 1); `accountSessions`, `sessionByRoom`, `visitsInRooms`, `renameSession` (Tasks 2-3); `cleanSessionName`, `BAD_SESSION_NAME` (Task 4).
- Produces:
  - `caller(req): Promise<{ userId }>` in `startApi`, on `ctx`: a `qd_` bearer is a linked computer (401 `this computer is signed out` when unknown), anything else the website JWT (401 `sign in first`).
  - `sessionRoutes({ store, now, caller })`:
    - `GET /v1/me/sessions?tz=` → `{ totals: { collaboratingThisWeek, topCollaborators }, sessions }`; 400 for a bad `tz`.
    - `GET /v1/me/sessions/:room` → `{ session: { room, name, owner: { name }, mine, createdAt, lastActiveAt, myTotalMs, people, visits } }`; 404 `no such session`.
    - `PUT /v1/me/sessions/:room { name }` → `{ session: { room, name } }`; 400 `Give the session a name of 1 to 80 characters.`, 403 `Only the session owner can rename it.`, 404.
    - `GET /v1/me/collaborators` → `{ collaborators: [{ account, name, kind, lastTogetherAt }] }`.

- [ ] **Step 1: Write the failing test**

Create `test/api-sessions.test.js`:

```js
// Reading session activity: GET /v1/me/sessions, one session, renaming, and collaborators.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startTestApi, linkDevice, makeAgent } from './api-helpers.js'

const SECRET = 'test-relay-secret-0123456789'
const T = (iso) => Date.parse(iso)
const MIN = 60 * 1000
const HOUR = 60 * MIN
let clock = T('2026-10-07T12:00:00Z') // a Wednesday
let t
before(async () => { t = await startTestApi({ relaySecret: SECRET, now: () => clock }) })
after(() => t.close())
beforeEach(() => { clock = T('2026-10-07T12:00:00Z') })

let rooms = 0
const room = () => `sess-${++rooms}`
const report = (events) => t.call('POST', '/v1/relay/presence', { events }, null, { authorization: `Bearer ${SECRET}` })
const start = (r, account, name, at, extra = {}) => ({ id: crypto.randomUUID(), type: 'start', room: r, account, name, at: T(at), ...extra })
const end = (s, at) => ({ id: crypto.randomUUID(), type: 'end', start: s.id, room: s.room, account: s.account, at: T(at) })
const sessions = (userId, tz) => t.call('GET', `/v1/me/sessions${tz ? `?tz=${encodeURIComponent(tz)}` : ''}`, null, userId)
const sessionOf = async (userId, r) => (await sessions(userId)).body.sessions.find((s) => s.room === r)

test('my time, time together and the totals; open visits count up to now', async () => {
  const r = room()
  const me = start(r, 'person:mem', 'Mo', '2026-10-07T09:00:00Z', { owner: true })
  const ada = start(r, 'person:admin', 'Ada', '2026-10-07T09:30:00Z')
  const bot = start(r, 'agent:a1', 'Larry', '2026-10-07T11:00:00Z')
  await report([me, ada, bot, end(ada, '2026-10-07T10:30:00Z'), { id: crypto.randomUUID(), type: 'name', room: r, name: 'quilt-site', at: T('2026-10-07T09:01:00Z') }])
  const res = await sessions('mem')
  assert.equal(res.status, 200)
  const s = res.body.sessions.find((x) => x.room === r)
  assert.deepEqual([s.name, s.owner, s.mine, s.myTotalMs, s.lastActiveAt], ['quilt-site', { name: 'Mo' }, true, 3 * HOUR, clock])
  assert.deepEqual(s.people, [
    { account: 'person:admin', name: 'Ada', kind: 'person', togetherMs: HOUR, lastTogetherAt: T('2026-10-07T10:30:00Z') },
    { account: 'agent:a1', name: 'Larry', kind: 'agent', togetherMs: HOUR, lastTogetherAt: clock }
  ])
  assert.equal(res.body.totals.collaboratingThisWeek, 2 * HOUR)
  assert.deepEqual(res.body.totals.topCollaborators.map((c) => [c.account, c.ms]), [['person:admin', HOUR], ['agent:a1', HOUR]])
  const hers = await sessionOf('admin', r)
  assert.deepEqual([hers.mine, hers.myTotalMs, hers.people.map((p) => p.account)], [false, HOUR, ['person:mem']], 'Larry came after Ada left')
})

test('you see only sessions you were in, and only people who overlapped with you', async () => {
  const r = room()
  const olive = start(r, 'person:owner', 'Olive', '2026-10-07T08:00:00Z', { owner: true })
  await report([
    olive,
    start(r, 'person:lim', 'Lin', '2026-10-07T09:00:00Z'),
    end(olive, '2026-10-07T08:30:00Z'),
    start(r, 'person:mem', 'Mo', '2026-10-07T08:00:00Z')
  ])
  assert.deepEqual((await sessionOf('owner', r)).people.map((p) => p.name), ['Mo'], 'Lin came after Olive left')
  assert.equal(await sessionOf('out', r), undefined, 'Otto was never there')
  assert.equal((await t.call('GET', `/v1/me/sessions/${r}`, null, 'out')).status, 404)
  assert.equal((await t.call('GET', '/v1/me/sessions/no-such-room', null, 'owner')).status, 404)
  assert.equal((await t.call('GET', '/v1/me/sessions/bad%20room', null, 'owner')).status, 404)
  assert.equal((await t.call('GET', '/v1/me/sessions', null, null)).status, 401)
})

test('the week starts on Monday in the time zone the website passes', async () => {
  // Sunday 11 October, 23:00 to Monday 01:00 in New York; asked on Monday at noon.
  clock = T('2026-10-12T16:00:00Z')
  const r = room()
  await report([
    start(r, 'person:gm', 'Gee', '2026-10-12T03:00:00Z'),
    start(r, 'person:unconf', 'Una', '2026-10-12T03:00:00Z')
  ].flatMap((s) => [s, end(s, '2026-10-12T05:00:00Z')]))
  assert.equal((await sessions('gm', 'America/New_York')).body.totals.collaboratingThisWeek, HOUR)
  assert.equal((await sessions('gm')).body.totals.collaboratingThisWeek, 2 * HOUR, 'UTC by default')
  assert.deepEqual((await sessions('gm', 'America/New_York')).body.totals.topCollaborators, [{ account: 'person:unconf', name: 'Una', kind: 'person', ms: 2 * HOUR }])
  const bad = await sessions('gm', 'Mars/Olympus')
  assert.deepEqual([bad.status, bad.body.error], [400, 'tz must be an IANA time zone, like Europe/London'])
})

test('one session: the same details, plus my last 20 visits', async () => {
  const r = room()
  const visits = []
  for (let i = 0; i < 22; i++) {
    const s = { ...start(r, 'person:lim', 'Lin', '2026-10-06T00:00:00Z'), at: T('2026-10-06T00:00:00Z') + i * HOUR }
    visits.push(s, { ...end(s, '2026-10-06T00:00:00Z'), at: s.at + 30 * MIN })
  }
  await report(visits)
  const res = await t.call('GET', `/v1/me/sessions/${r}`, null, 'lim')
  assert.equal(res.status, 200)
  assert.deepEqual([res.body.session.room, res.body.session.myTotalMs, res.body.session.createdAt], [r, 22 * 30 * MIN, T('2026-10-06T00:00:00Z')])
  assert.equal(res.body.session.visits.length, 20)
  assert.deepEqual(res.body.session.visits[0], { startedAt: T('2026-10-06T21:00:00Z'), endedAt: T('2026-10-06T21:30:00Z') })
})

test('only the owner renames, from the website or a linked computer; the relay never undoes it', async () => {
  const r = room()
  await report([
    start(r, 'person:owner', 'Olive', '2026-10-07T08:00:00Z', { owner: true }),
    start(r, 'person:admin', 'Ada', '2026-10-07T08:30:00Z'),
    { id: crypto.randomUUID(), type: 'name', room: r, name: 'folder-name', at: T('2026-10-07T08:01:00Z') }
  ])
  const rename = (userId, name, headers) => t.call('PUT', `/v1/me/sessions/${r}`, { name }, userId, headers)
  const notOwner = await rename('admin', 'Mine now')
  assert.deepEqual([notOwner.status, notOwner.body.error], [403, 'Only the session owner can rename it.'])
  assert.equal((await rename('out', 'Mine now')).status, 404)
  for (const bad of ['   ', 'a\nb', 'x'.repeat(81)]) {
    const res = await rename('owner', bad)
    assert.deepEqual([res.status, res.body.error], [400, 'Give the session a name of 1 to 80 characters.'], JSON.stringify(bad))
  }
  assert.deepEqual((await rename('owner', '  Pricing page  ')).body, { session: { room: r, name: 'Pricing page' } })
  assert.equal((await sessionOf('admin', r)).name, 'Pricing page', 'everyone sees it')
  await report([{ id: crypto.randomUUID(), type: 'name', room: r, name: 'folder-name', at: clock }])
  assert.equal((await sessionOf('owner', r)).name, 'Pricing page')
  const { token } = await linkDevice(t, 'owner')
  const fromApp = await t.call('PUT', `/v1/me/sessions/${r}`, { name: 'From the app' }, null, { authorization: `Bearer ${token}` })
  assert.equal(fromApp.status, 200)
  assert.equal((await sessionOf('owner', r)).name, 'From the app')
})

test('collaborators: people and agents you overlapped with, most recent first, with a computer token too', async () => {
  const r1 = room()
  const r2 = room()
  const { agent } = await makeAgent(t, { name: 'Larry', ownerUserId: 'out', invitedBy: 'out' })
  await report([
    start(r1, 'person:out', 'Otto', '2026-10-07T08:00:00Z', { owner: true }),
    start(r1, 'person:mem', 'Mo', '2026-10-07T08:00:00Z'),
    start(r2, 'person:out', 'Otto', '2026-10-06T08:00:00Z'),
    start(r2, `agent:${agent.id}`, 'Larry', '2026-10-06T08:00:00Z')
  ].flatMap((s) => [s, end(s, s.room === r1 ? '2026-10-07T09:00:00Z' : '2026-10-06T09:00:00Z')]))
  const { token } = await linkDevice(t, 'out')
  const res = await t.call('GET', '/v1/me/collaborators', null, null, { authorization: `Bearer ${token}` })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.collaborators, [
    { account: 'person:mem', name: 'Mo', kind: 'person', lastTogetherAt: T('2026-10-07T09:00:00Z') },
    { account: `agent:${agent.id}`, name: 'Larry', kind: 'agent', lastTogetherAt: T('2026-10-06T09:00:00Z') }
  ])
  assert.equal((await t.call('GET', '/v1/me/collaborators', null, null, { authorization: 'Bearer qd_nope' })).status, 401)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/api-sessions.test.js`
Expected: FAIL: `GET /v1/me/sessions` is a 404 (`404 !== 200`).

- [ ] **Step 3: Implement**

Create `src/api/routes/sessions.js`:

```js
// Your sessions on the dashboard: where you've been, your time there, and who you
// worked with (activity.js does the sums). Only sessions you were in, and only people
// who were there at the same time as you.
import { HttpError } from '../http.js'
import { summarize, collaborators, myVisits, isTimeZone, weekStart, monthStart, MAX_SESSIONS } from '../activity.js'
import { cleanSessionName, BAD_SESSION_NAME } from '../../session-name.js'

const ROOM = /^[A-Za-z0-9_-]{1,64}$/
const NO_SESSION = 'no such session'

export function sessionRoutes ({ store, now, caller }) {
  const me = async (req) => `person:${(await caller(req)).userId}`
  const zoneOf = (req) => {
    const tz = new URL(req.url, 'http://x').searchParams.get('tz') || 'UTC'
    if (!isTimeZone(tz)) throw new HttpError(400, 'tz must be an IANA time zone, like Europe/London')
    return tz
  }

  async function overview (account, tz) {
    const t = now()
    // The latest sessions, plus every one active this week or month, for the totals.
    const since = Math.min(weekStart(t, tz), monthStart(t, tz))
    const sessions = await store.accountSessions(account, { since, limit: MAX_SESSIONS })
    const visits = await store.visitsInRooms(sessions.map((s) => s.room))
    return summarize({ me: account, sessions, visits, now: t, tz })
  }

  /** A session I was in, with every visit to it; 404 otherwise, whether or not it exists. */
  async function mine (account, room) {
    if (!ROOM.test(room)) throw new HttpError(404, NO_SESSION)
    const session = await store.sessionByRoom(room)
    const visits = session ? await store.visitsInRooms([room]) : []
    if (!visits.some((v) => v.account === account)) throw new HttpError(404, NO_SESSION)
    return { session, visits }
  }

  return [
    ['GET', /^\/v1\/me\/sessions$/, async (req) => overview(await me(req), zoneOf(req))],

    ['GET', /^\/v1\/me\/sessions\/([^/]+)$/, async (req, body, [room]) => {
      const account = await me(req)
      const { session, visits } = await mine(account, room)
      const [s] = summarize({ me: account, sessions: [session], visits, now: now() }).sessions
      return { session: { ...s, visits: myVisits({ me: account, visits }) } }
    }],

    // The owner's rename shows for everyone, and the relay's name no longer replaces it.
    ['PUT', /^\/v1\/me\/sessions\/([^/]+)$/, async (req, body, [room]) => {
      const account = await me(req)
      const name = cleanSessionName(body.name)
      if (!name) throw new HttpError(400, BAD_SESSION_NAME)
      const { session } = await mine(account, room)
      if (session.ownerAccount !== account) throw new HttpError(403, 'Only the session owner can rename it.')
      const renamed = await store.renameSession(room, name, now())
      return { session: { room, name: renamed.name } }
    }],

    // People and agents you've worked with, for invites (most recent first, at most 30).
    ['GET', /^\/v1\/me\/collaborators$/, async (req) => {
      const { sessions } = await overview(await me(req), 'UTC')
      return { collaborators: collaborators(sessions) }
    }]
  ]
}
```

In `src/api/server.js`:

- After `import { relayRoutes } from './routes/relay.js'` add `import { sessionRoutes } from './routes/sessions.js'`.
- Just before `  const needPassKey = () =>`, add:

  ```js
  /** The person calling: the website's sign-in (a Supabase JWT), or a linked computer's qd_ token. */
  async function caller (req) {
    if (bearer(req).startsWith('qd_')) return { userId: (await device(req)).userId }
    return user(req)
  }

  ```

- Change the `ctx` line to add `caller` after `user`, and add `...sessionRoutes(ctx)` at the end of `routes.push(…)`:

  ```js
  const ctx = { store, user, caller, bearer, now, site, apiUrl: api, mailer, log, limit: limitInvites, limitSend: limitInviteSend, limitTokens, limitJoin, agentAuth, relaySecret }
  routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx), ...agentRoutes(ctx), ...agentInviteRoutes(ctx), ...joinRoutes(ctx), ...relayRoutes(ctx), ...sessionRoutes(ctx))
  ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/api-sessions.test.js test/api-presence.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/sessions.js src/api/server.js test/api-sessions.test.js
git commit -m "Your sessions, time together and collaborators from the accounts API; owners rename"
```

---

### Task 6: The relay's presence queue

**Files:**
- Create: `src/presence.js`
- Create: `test/presence.test.js`

**Interfaces:**
- Consumes: nothing (it calls the route from Task 4 over HTTP, through an injectable `fetch`).
- Produces (in `src/presence.js`):
  - `PRESENCE_FILE = 'presence-queue.jsonl'`, `PRESENCE_FLUSH_MS = 60000`, `PRESENCE_BATCH = 500`, `PRESENCE_MAX_QUEUE = 100000`, `PRESENCE_MAX_BACKOFF_MS = 600000`
  - `new PresenceReporter({ apiUrl, secret, file = null, log, now = Date.now, fetch = globalThis.fetch, flushMs, batch, maxQueue, maxBackoffMs, syncMs = 1000, timeoutMs = 15000 })`
  - `load(): number` (reads the file; ends left-open visits at `now()`; returns how many), `start()` (timers), `visitStart({ room, account, name, owner }): { start, room, account } | null`, `visitEnd(visit)`, `rename({ room, name })`, `endAll()`, `persist()`, `tick(): Promise<boolean>`, `flush(): Promise<boolean>`, `close(): Promise<void>`
  - Fields tests read: `size`, `open` (a `Map`), `retryAt`, `failures`, `now`.

- [ ] **Step 1: Write the failing test**

Create `test/presence.test.js`:

```js
// The relay's presence reports: a queue kept on disk, sent in order in batches,
// retried with backoff, and capped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PresenceReporter, PRESENCE_FILE } from '../src/presence.js'

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-presence-')), PRESENCE_FILE)
/** A stand-in for the accounts API: records each request, answers with `status()`. */
function fakeApi (status = () => 200) {
  const requests = []
  const fetch = async (url, init) => {
    requests.push({ url, headers: init.headers, events: JSON.parse(init.body).events })
    return { ok: status() < 300, status: status() }
  }
  return { fetch, requests, events: () => requests.flatMap((r) => r.events) }
}
const reporter = (o = {}) => {
  let clock = 1_000_000
  const logs = []
  const r = new PresenceReporter({ apiUrl: 'http://api.test/', secret: 's3cret', now: () => clock, log: (m) => logs.push(m), ...o })
  return { r, logs, advance: (ms) => { clock += ms }, at: () => clock }
}

test('a visit starts and ends once, with the account, name and owner; a rename is an event too', async () => {
  const api = fakeApi()
  const { r, advance } = reporter({ fetch: api.fetch })
  const v = r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana', owner: true })
  advance(5000)
  r.visitEnd(v)
  r.visitEnd(v)
  r.rename({ room: 'r1', name: 'Pricing' })
  assert.equal(await r.flush(), true)
  const [start, end, name] = api.events()
  assert.deepEqual({ ...start, id: 'x' }, { id: 'x', type: 'start', room: 'r1', account: 'person:u1', name: 'Dana', owner: true, at: 1_000_000 })
  assert.deepEqual({ ...end, id: 'x' }, { id: 'x', type: 'end', start: start.id, room: 'r1', account: 'person:u1', at: 1_005_000 })
  assert.deepEqual({ ...name, id: 'x' }, { id: 'x', type: 'name', room: 'r1', name: 'Pricing', at: 1_005_000 })
  assert.equal(api.events().length, 3, 'one end per visit')
  assert.equal(api.requests[0].url, 'http://api.test/v1/relay/presence')
  assert.equal(api.requests[0].headers.authorization, 'Bearer s3cret')
  assert.equal(r.size, 0, 'sent events leave the queue')
})

test('sends at most 500 events per request, in order', async () => {
  const api = fakeApi()
  const { r } = reporter({ fetch: api.fetch })
  for (let i = 0; i < 1201; i++) r.rename({ room: 'r1', name: `n${i}` })
  assert.equal(await r.flush(), true)
  assert.deepEqual(api.requests.map((q) => q.events.length), [500, 500, 201])
  assert.deepEqual(api.events().map((e) => e.name), Array.from({ length: 1201 }, (_, i) => `n${i}`))
})

test('a failure keeps the events and backs off, doubling up to 10 minutes', async () => {
  let status = 503
  const api = fakeApi(() => status)
  const { r, logs, advance } = reporter({ fetch: api.fetch })
  r.rename({ room: 'r1', name: 'a' })
  const waits = []
  for (let i = 0; i < 6; i++) {
    assert.equal(await r.tick(), false)
    waits.push(r.retryAt - r.now())
    assert.equal(await r.tick(), false, 'too soon: not even tried')
    advance(waits[i])
  }
  assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
  assert.equal(api.requests.length, 6)
  assert.equal(r.size, 1)
  assert.match(logs[0], /could not report to the accounts API \(the accounts API answered 503\); trying again in 60 s/)
  assert.ok(logs.every((l) => !l.includes('s3cret')), 'the secret is never logged')
  status = 200
  assert.equal(await r.tick(), true)
  assert.equal(r.size, 0)
  assert.equal(r.failures, 0)
})

test('the queue is capped: beyond it the oldest events go, with a log line', async () => {
  const api = fakeApi()
  const { r, logs } = reporter({ fetch: api.fetch, maxQueue: 3 })
  for (const n of ['a', 'b', 'c', 'd', 'e']) r.rename({ room: 'r1', name: n })
  assert.equal(r.size, 3)
  assert.match(logs[0], /queue is full \(3 events\); dropped the 1 oldest/)
  await r.flush()
  assert.deepEqual(api.events().map((e) => e.name), ['c', 'd', 'e'])
})

test('the queue survives a restart, and visits left open are ended at startup', async () => {
  const file = tmp()
  const down = fakeApi(() => 500)
  const first = reporter({ file, fetch: down.fetch })
  const a = first.r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana' })
  const b = first.r.visitStart({ room: 'r1', account: 'agent:a1', name: 'Larry' })
  first.r.visitEnd(b)
  first.r.persist()
  // The process dies here: no close(). A line cut off mid-write is skipped.
  fs.appendFileSync(file, '{"id":"half')
  const api = fakeApi()
  const second = reporter({ file, fetch: api.fetch })
  second.advance(60_000)
  assert.equal(second.r.load(), 1)
  assert.match(second.logs[0], /skipped 1 unreadable line/)
  assert.equal(await second.r.flush(), true)
  const events = api.events()
  assert.deepEqual(events.map((e) => [e.type, e.account]), [['start', 'person:u1'], ['start', 'agent:a1'], ['end', 'agent:a1'], ['end', 'person:u1']])
  assert.equal(events[3].start, a.start)
  assert.equal(events[3].at, 1_060_000, 'ended when the relay came back')
  // Everything was sent, so a third start finds nothing to send or end.
  const third = reporter({ file, fetch: api.fetch })
  assert.equal(third.r.load(), 0)
  assert.equal(third.r.size, 0)
})

test('a visit whose start was already sent is still ended after a crash', async () => {
  const file = tmp()
  const api = fakeApi()
  const first = reporter({ file, fetch: api.fetch })
  const v = first.r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana' })
  await first.r.flush() // the start is sent, and leaves the queue
  assert.equal(first.r.size, 0)
  const second = reporter({ file, fetch: api.fetch })
  assert.equal(second.r.load(), 1)
  await second.r.flush()
  const last = api.events().at(-1)
  assert.deepEqual([last.type, last.start], ['end', v.start])
})

test('closing ends open visits, saves the queue and sends it; nothing is recorded after', async () => {
  const file = tmp()
  const api = fakeApi()
  const { r } = reporter({ file, fetch: api.fetch })
  r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana' })
  await r.close()
  assert.deepEqual(api.events().map((e) => e.type), ['start', 'end'])
  assert.equal(r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana' }), null)
  assert.equal(r.size, 0)
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.deepEqual(lines, ['{"open":[]}'], 'only the (empty) list of open visits is left on disk')
})

test('with no file the queue lives in memory', async () => {
  const api = fakeApi()
  const { r } = reporter({ fetch: api.fetch })
  assert.equal(r.load(), 0)
  r.rename({ room: 'r1', name: 'x' })
  r.persist()
  assert.equal(await r.flush(), true)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/presence.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/presence.js`.

- [ ] **Step 3: Implement**

Create `src/presence.js`:

```js
// Presence reports: the relay tells the accounts API who is in which session, and
// when, so people's dashboards can show their sessions and who they worked with.
// Only for connections with a pass (an account), and only when the relay has both
// QUILT_API_URL and RELAY_API_SECRET. Events wait in a queue that is kept on disk
// (`<dataDir>/presence-queue.jsonl`), so a restart or a down API loses nothing, and
// are sent every minute, at most 500 per request, in order.
import fs from 'node:fs'
import crypto from 'node:crypto'

export const PRESENCE_FILE = 'presence-queue.jsonl'
export const PRESENCE_FLUSH_MS = 60 * 1000
export const PRESENCE_BATCH = 500
export const PRESENCE_MAX_QUEUE = 100_000
export const PRESENCE_MAX_BACKOFF_MS = 10 * 60 * 1000
const SYNC_MS = 1000
const SEND_TIMEOUT_MS = 15 * 1000
const CLOSE_TIMEOUT_MS = 5 * 1000

export class PresenceReporter {
  /**
   * @param {object} o
   * @param {string} o.apiUrl   the accounts API, e.g. https://api.heyquilt.com
   * @param {string} o.secret   RELAY_API_SECRET. Never logged.
   * @param {string|null} [o.file]  the queue file; null keeps the queue in memory only
   */
  constructor ({ apiUrl, secret, file = null, log = () => {}, now = Date.now, fetch = globalThis.fetch, flushMs = PRESENCE_FLUSH_MS, batch = PRESENCE_BATCH, maxQueue = PRESENCE_MAX_QUEUE, maxBackoffMs = PRESENCE_MAX_BACKOFF_MS, syncMs = SYNC_MS, timeoutMs = SEND_TIMEOUT_MS }) {
    this.url = `${String(apiUrl).replace(/\/+$/, '')}/v1/relay/presence`
    this.secret = secret
    this.file = file
    this.log = log
    this.now = now
    this.fetch = fetch
    this.flushMs = flushMs
    this.batch = batch
    this.maxQueue = maxQueue
    this.maxBackoffMs = maxBackoffMs
    this.syncMs = syncMs
    this.timeoutMs = timeoutMs
    this.queue = [] // { seq, ev }, oldest first
    this.seq = 0
    this.open = new Map() // start event id -> { start, room, account }: visits not ended yet
    this.unwritten = [] // queue lines not yet appended to the file
    this.rewrite = false // the file no longer matches the queue: write it whole next time
    this.failures = 0
    this.retryAt = 0
    this.sending = null
    this.closed = false
    this.timers = []
  }

  /**
   * Reads the queue file a previous run left, and ends at "now" every visit it had
   * started and not ended (the relay crashed, or was redeployed). Returns how many.
   */
  load () {
    if (!this.file) return 0
    let text = ''
    try { text = fs.readFileSync(this.file, 'utf8') } catch (err) { if (err.code !== 'ENOENT') this.log(`presence: could not read ${this.file}: ${err.message}`); return 0 }
    let bad = 0
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { bad++; continue } // a line cut off by a crash
      if (Array.isArray(row.open)) {
        for (const v of row.open) if (v && v.start) this.open.set(v.start, v)
        continue
      }
      if (!row || !row.id || !row.type) { bad++; continue }
      this.queue.push({ seq: ++this.seq, ev: row })
      if (row.type === 'start') this.open.set(row.id, { start: row.id, room: row.room, account: row.account })
      if (row.type === 'end') this.open.delete(row.start)
    }
    if (bad) this.log(`presence: skipped ${bad} unreadable line(s) in ${this.file}`)
    const ended = this.open.size
    this.endAll()
    this.rewrite = true
    this.persist()
    return ended
  }

  /** Sends every minute (sooner retries wait for their backoff) and saves the queue every second. */
  start () {
    const tick = setInterval(() => { this.tick().catch(() => {}) }, this.flushMs)
    const sync = setInterval(() => this.persist(), this.syncMs)
    tick.unref()
    sync.unref()
    this.timers.push(tick, sync)
  }

  get size () { return this.queue.length }

  /** Someone with a pass was let into a room. Returns the visit, for visitEnd. */
  visitStart ({ room, account, name, owner = false }) {
    if (this.closed) return null
    const ev = { id: crypto.randomUUID(), type: 'start', room, account, name, ...(owner ? { owner: true } : {}), at: this.now() }
    const visit = { start: ev.id, room, account }
    this.open.set(ev.id, visit)
    this.enqueue(ev)
    return visit
  }

  /** That connection left (closed, removed, ended, or its pass lapsed). Once per visit. */
  visitEnd (visit) {
    if (this.closed || !visit || !this.open.delete(visit.start)) return
    this.enqueue({ id: crypto.randomUUID(), type: 'end', start: visit.start, room: visit.room, account: visit.account, at: this.now() })
  }

  /** The owner named the session. */
  rename ({ room, name }) {
    if (this.closed) return
    this.enqueue({ id: crypto.randomUUID(), type: 'name', room, name, at: this.now() })
  }

  /** Ends every open visit now: on shutdown, and for visits a previous run left open. */
  endAll () {
    for (const visit of [...this.open.values()]) {
      this.open.delete(visit.start)
      this.enqueue({ id: crypto.randomUUID(), type: 'end', start: visit.start, room: visit.room, account: visit.account, at: this.now() })
    }
  }

  enqueue (ev) {
    this.queue.push({ seq: ++this.seq, ev })
    this.unwritten.push(ev)
    if (this.queue.length > this.maxQueue) {
      const drop = this.queue.length - this.maxQueue
      this.queue.splice(0, drop)
      this.rewrite = true
      this.log(`presence: the queue is full (${this.maxQueue} events); dropped the ${drop} oldest`)
    }
  }

  /** Saves what's new in the queue: appended and fsynced, or the whole file when it has to be. */
  persist () {
    if (!this.file || (!this.rewrite && !this.unwritten.length)) return
    try {
      if (this.rewrite) {
        // Written whole, then renamed: a crash mid-write leaves the old file, never half of one.
        const tmp = `${this.file}.tmp`
        const lines = [JSON.stringify({ open: [...this.open.values()] }), ...this.queue.map((x) => JSON.stringify(x.ev))]
        const fd = fs.openSync(tmp, 'w')
        try { fs.writeSync(fd, lines.join('\n') + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        fs.renameSync(tmp, this.file)
      } else {
        const fd = fs.openSync(this.file, 'a')
        try { fs.writeSync(fd, this.unwritten.map((ev) => JSON.stringify(ev)).join('\n') + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      }
      this.unwritten = []
      this.rewrite = false
    } catch (err) {
      this.log(`presence: could not save the queue: ${err.message}`)
    }
  }

  /** Sends now unless a failure's backoff hasn't run out. */
  async tick () {
    if (this.now() < this.retryAt) return false
    return this.flush()
  }

  /**
   * Sends everything queued, oldest first, in requests of at most 500. Resolves true
   * when the queue is empty, false after a failure (the events stay for the retry).
   */
  flush () {
    if (!this.sending) this.sending = this.send().finally(() => { this.sending = null })
    return this.sending
  }

  async send () {
    let sent = false
    try {
      while (this.queue.length) {
        const chunk = this.queue.slice(0, this.batch)
        const res = await this.fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
          body: JSON.stringify({ events: chunk.map((x) => x.ev) }),
          signal: AbortSignal.timeout(this.timeoutMs)
        })
        if (!res.ok) throw new Error(`the accounts API answered ${res.status}`)
        // By sequence number: the queue may have dropped its oldest while this was in flight.
        const last = chunk[chunk.length - 1].seq
        const i = this.queue.findIndex((x) => x.seq > last)
        this.queue = i < 0 ? [] : this.queue.slice(i)
        sent = true
      }
      this.failures = 0
      this.retryAt = 0
      return true
    } catch (err) {
      this.failures++
      const wait = Math.min(this.flushMs * 2 ** (this.failures - 1), this.maxBackoffMs)
      this.retryAt = this.now() + wait
      this.log(`presence: could not report to the accounts API (${err.cause?.code || err.message}); trying again in ${Math.round(wait / 1000)} s`)
      return false
    } finally {
      if (sent) { this.rewrite = true; this.persist() }
    }
  }

  /** On shutdown: ends every open visit, stops the timers, saves the queue, and tries one last send (for at most 5 s). */
  async close () {
    if (this.closed) return
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.endAll()
    this.persist()
    this.closed = true
    let timer
    await Promise.race([this.flush(), new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS) })])
    clearTimeout(timer)
    this.persist()
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/presence.test.js`
Expected: PASS (8 tests).

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/presence.js test/presence.test.js
git commit -m "Add the relay's presence queue: kept on disk, sent in batches, retried with backoff"
```

---

### Task 7: The relay reports presence, and the owner names sessions

**Files:**
- Modify: `src/server.js` (imports, `relayConfig`, `Room` constructor, `broadcastMembers`, `adminRequest`, `enter`, `leave`, the admin reply in `handle`, `startServer`)
- Modify: `src/protocol.js` (two comments)
- Modify: `bin/quilt.js` (`serve`)
- Modify: `fly.toml`, `docs/hosting.md`
- Create: `test/relay-presence.test.js`

**Interfaces:**
- Consumes: `PresenceReporter`, `PRESENCE_FILE` (Task 6); `cleanSessionName`, `BAD_SESSION_NAME` (Task 4); `startTestApi` with `relaySecret` (Tasks 4-5).
- Produces:
  - `relayConfig()` gains `apiUrl` (`QUILT_API_URL`) and `relayApiSecret` (`RELAY_API_SECRET`).
  - `startServer({ …, apiUrl, relayApiSecret, presenceOptions = {} })`; the result has `presence` (a `PresenceReporter`, or `null` when off) and an async `close()` that ends open visits and sends them first.
  - Relay admin op `{ op: 'name', name }` (owner only) → `{ ok: true }`, or an error reply `Give the session a name of 1 to 80 characters.` / `only the session owner can do that`. Saved as `room.meta.name`.
  - Every `MSG_MEMBERS` message carries `sessionName` (a string, `''` when unnamed).
  - `Room#presence` (set by `startServer`); `ws.visit` on a connection while its visit is open.

- [ ] **Step 1: Write the failing test**

Create `test/relay-presence.test.js`:

```js
// The relay reports presence to the accounts API: a visit starts when an account is
// let into a session and ends when it leaves. The owner names the session.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { startServer, relayConfig } from '../src/server.js'
import { generateIdentity, signChallenge } from '../src/identity.js'
import { MSG_AUTH, MSG_ACCESS, MSG_ADMIN, MSG_MEMBERS, decoding, bytesMessage, jsonMessage } from '../src/protocol.js'
import { PRESENCE_FILE } from '../src/presence.js'
import { PASS_KEYS, makePass } from './pass-helpers.js'
import { startTestApi } from './api-helpers.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-presence-home-'))
const SECRET = 'relay-api-secret-for-tests'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
let rooms = 0
const room = () => `pr-${++rooms}`

/** A stand-in accounts API: every event the relay sends, in order. */
function collector () {
  const events = []
  const fetch = async (url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${SECRET}`)
    events.push(...JSON.parse(init.body).events)
    return { ok: true, status: 200 }
  }
  return { fetch, events }
}

async function relay (t, opts = {}) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: PASS_KEYS.publicKey, apiUrl: 'http://api.test', relayApiSecret: SECRET, ...opts })
  t.after(() => srv.close())
  return srv
}

function connect (srv, r, { identity = generateIdentity(), pass, viewSecret } = {}) {
  const q = new URLSearchParams({ secret: 's', name: 'n', key: identity.publicKey, kind: 'human', features: 'large-files' })
  if (pass) q.set('pass', pass)
  if (viewSecret) q.set('viewSecret', viewSecret)
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/${r}?${q}`)
  ws.binaryType = 'arraybuffer'
  const c = { ws, access: [], members: [] }
  c.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  return new Promise((resolve, reject) => {
    c.closed.then((code) => reject(new Error(`closed with ${code}`)))
    ws.on('error', () => {})
    ws.on('message', (data) => {
      const dec = decoding.createDecoder(new Uint8Array(data))
      const type = decoding.readVarUint(dec)
      if (type === MSG_AUTH) ws.send(bytesMessage(MSG_AUTH, signChallenge(identity, r, decoding.readVarUint8Array(dec))))
      else if (type === MSG_ACCESS) { c.access.push(JSON.parse(decoding.readVarString(dec))); resolve(c) } else if (type === MSG_MEMBERS) c.members.push(JSON.parse(decoding.readVarString(dec)))
    })
  })
}
const as = (name, sub, kind = 'person') => { const identity = generateIdentity(); return { identity, pass: makePass({ identity, name, sub, kind }) } }
let adminIds = 0
function admin (c, req) {
  const id = ++adminIds
  c.ws.send(jsonMessage(MSG_ADMIN, { id, ...req }))
  return waitFor(() => c.members.find((m) => m.reply && m.reply.id === id)?.reply)
}
const leave = async (c) => { c.ws.close(); await c.closed.catch(() => {}) }

test('presence is off unless both QUILT_API_URL and RELAY_API_SECRET are set', async (t) => {
  for (const opts of [{ apiUrl: '', relayApiSecret: '' }, { apiUrl: 'http://api.test', relayApiSecret: '' }, { apiUrl: '', relayApiSecret: SECRET }]) {
    const srv = await relay(t, opts)
    assert.equal(srv.presence, null, JSON.stringify(opts))
  }
  assert.deepEqual([relayConfig({}).apiUrl, relayConfig({}).relayApiSecret], ['', ''])
})

test('an account let in starts a visit, and leaving ends it', async (t) => {
  const api = collector()
  const srv = await relay(t, { presenceOptions: { fetch: api.fetch } })
  const r = room()
  const olive = as('Olive', 'user-olive')
  const o = await connect(srv, r, { ...olive, viewSecret: 'v' })
  const bot = as('Larry', 'agent-1', 'agent')
  const b = await connect(srv, r, bot)
  assert.equal(b.access[0].state, 'pending')
  await admin(o, { op: 'approve', key: 'agent:agent-1' })
  await leave(b)
  await waitFor(() => srv.presence.open.size === 1)
  await srv.presence.flush()
  assert.deepEqual(api.events.map((e) => [e.type, e.room, e.account, e.name, e.owner]), [
    ['start', r, 'person:user-olive', 'Olive', true],
    ['start', r, 'agent:agent-1', 'Larry', undefined],
    ['end', r, 'agent:agent-1', undefined, undefined]
  ])
  assert.equal(api.events[2].start, api.events[1].id)
})

test('someone waiting for the owner records nothing, and nothing if they are turned away', async (t) => {
  const api = collector()
  const srv = await relay(t, { presenceOptions: { fetch: api.fetch } })
  const r = room()
  const o = await connect(srv, r, { ...as('Olive', 'user-olive'), viewSecret: 'v' })
  const gus = await connect(srv, r, as('Gus', 'user-gus'))
  assert.equal(gus.access[0].state, 'pending')
  await admin(o, { op: 'deny', key: 'person:user-gus' })
  await srv.presence.flush()
  assert.deepEqual(api.events.map((e) => e.account), ['person:user-olive'])
})

test('connections without a pass are never reported', async (t) => {
  const api = collector()
  const srv = await relay(t, { passPublicKey: '', presenceOptions: { fetch: api.fetch } })
  await connect(srv, room())
  await srv.presence.flush()
  assert.deepEqual(api.events, [])
})

test('only the owner names the session; the name reaches everyone in it, and the API', async (t) => {
  const api = collector()
  const srv = await relay(t, { presenceOptions: { fetch: api.fetch } })
  const r = room()
  const o = await connect(srv, r, { ...as('Olive', 'user-olive'), viewSecret: 'v' })
  const gus = await connect(srv, r, as('Gus', 'user-gus'))
  await admin(o, { op: 'approve', key: 'person:user-gus' })
  for (const bad of ['', '   ', 'x'.repeat(81), 'two\nlines', 42]) {
    const reply = await admin(o, { op: 'name', name: bad })
    assert.deepEqual(reply, { id: reply.id, ok: false, error: 'Give the session a name of 1 to 80 characters.' }, JSON.stringify(bad))
  }
  assert.equal((await admin(gus, { op: 'name', name: 'Mine' })).error, 'only the session owner can do that')
  assert.equal((await admin(o, { op: 'name', name: '  quilt-site  ' })).ok, true)
  await waitFor(() => gus.members.some((m) => m.sessionName === 'quilt-site'))
  assert.equal(srv.rooms.get(r).meta.name, 'quilt-site')
  await srv.presence.flush()
  assert.deepEqual(api.events.filter((e) => e.type === 'name').map((e) => [e.room, e.name]), [[r, 'quilt-site']])
})

test('the queue file survives a crash, and the next start ends the visits left open', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-presence-data-'))
  const down = { fetch: async () => ({ ok: false, status: 503 }) }
  const first = await relay(t, { dataDir: dir, presenceOptions: down })
  const r = room()
  await connect(first, r, as('Olive', 'user-olive'))
  first.presence.persist()
  // A crash: the next relay finds the file as this one left it.
  const crashed = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-presence-data-'))
  fs.copyFileSync(path.join(dir, PRESENCE_FILE), path.join(crashed, PRESENCE_FILE))
  const api = collector()
  const second = await relay(t, { dataDir: crashed, presenceOptions: { fetch: api.fetch } })
  await second.presence.flush()
  assert.deepEqual(api.events.map((e) => [e.type, e.account]), [['start', 'person:user-olive'], ['end', 'person:user-olive']])
})

test('shutting down ends open visits and sends them', async (t) => {
  const api = collector()
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: PASS_KEYS.publicKey, apiUrl: 'http://api.test', relayApiSecret: SECRET, presenceOptions: { fetch: api.fetch } })
  await connect(srv, room(), as('Olive', 'user-olive'))
  await srv.close()
  assert.deepEqual(api.events.map((e) => e.type), ['start', 'end'])
})

test('end to end: two accounts in one session see each other on their dashboards', async (t) => {
  const accounts = await startTestApi({ relaySecret: SECRET })
  t.after(() => accounts.close())
  const srv = await relay(t, { apiUrl: accounts.api.url })
  const r = room()
  const mo = await connect(srv, r, { ...as('Mo', 'mem'), viewSecret: 'v' })
  const ada = await connect(srv, r, as('Ada', 'admin'))
  await admin(mo, { op: 'approve', key: 'person:admin' })
  await admin(mo, { op: 'name', name: 'quilt-site' })
  await wait(50)
  await leave(ada)
  await waitFor(() => srv.presence.open.size === 1)
  assert.equal(await srv.presence.flush(), true)
  const mine = (await accounts.call('GET', '/v1/me/sessions', null, 'mem')).body.sessions.find((s) => s.room === r)
  assert.deepEqual([mine.name, mine.mine, mine.people.map((p) => p.name)], ['quilt-site', true, ['Ada']])
  const hers = (await accounts.call('GET', '/v1/me/sessions', null, 'admin')).body.sessions.find((s) => s.room === r)
  assert.deepEqual([hers.name, hers.mine, hers.owner.name, hers.people.map((p) => p.name)], ['quilt-site', false, 'Mo', ['Mo']])
  assert.ok(hers.people[0].togetherMs > 0)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/relay-presence.test.js`
Expected: FAIL: the first test gets `undefined !== null` (the server has no `presence` yet).

- [ ] **Step 3: Implement**

In `src/server.js`:

- After `import { JOIN_HOST } from './ui/invite.js'` add:

  ```js
  import { PresenceReporter, PRESENCE_FILE } from './presence.js'
  import { cleanSessionName, BAD_SESSION_NAME } from './session-name.js'
  ```

- In `relayConfig`'s returned object, right after `passPublicKey,`, add:

  ```js
    // Presence reports for the dashboard (presence.js): only when both are set.
    apiUrl: opts.apiUrl ?? env.QUILT_API_URL ?? '',
    relayApiSecret: opts.relayApiSecret ?? env.RELAY_API_SECRET ?? '',
  ```

- In the `Room` constructor, after `this.unloadTimer = null` add:

  ```js
    this.presence = null // a PresenceReporter when the relay reports presence (set by startServer)
  ```

- In `broadcastMembers`, change the message line to:

  ```js
      const msg = { members, sessionName: this.meta.name || '', ...(a.owner ? { pending } : {}), ...(ws === replyTo && reply ? { reply } : {}) }
  ```

- In `adminRequest`, between `if (!me || !me.owner) throw new Error('only the session owner can do that')` and `if (req.op === 'end') {`, add:

  ```js
    if (req.op === 'name') {
      // The owner's app names the session after its folder, and the owner can rename it.
      const name = cleanSessionName(req.name)
      if (!name) throw new Error(BAD_SESSION_NAME)
      this.meta.name = name
      this.saveMeta()
      if (this.presence) this.presence.rename({ room: this.name, name })
      return { ok: true }
    }
  ```

- Make `enter` start a visit:

  ```js
  enter (ws, a) {
    this.setAccess(ws, a)
    // Presence: an account's visit starts once it's let in (never while it waits for the owner).
    if (ws.pass && this.presence && !ws.visit) ws.visit = this.presence.visitStart({ room: this.name, account: `${ws.pass.kind}:${ws.pass.sub}`, name: a.name, owner: !!a.owner })
    send(ws, jsonMessage(MSG_ACCESS, this.accessMessage(a)))
    this.join(ws, a.name)
    this.broadcastMembers()
  }
  ```

- Make the first line of `leave (ws) {` end the visit:

  ```js
    if (ws.visit) { if (this.presence) this.presence.visitEnd(ws.visit); ws.visit = null }
  ```

- In `handle`, the `MSG_ADMIN` failure reply also carries the name:

  ```js
      else send(ws, jsonMessage(MSG_MEMBERS, { members: this.memberList(), sessionName: this.meta.name || '', ...(this.access.get(ws)?.owner ? { pending: this.pendingList() } : {}), reply }))
  ```

- Change the `startServer` signature to:

  ```js
  export function startServer ({ port = 4321, host = '0.0.0.0', dataDir = null, log = console.log, presenceOptions = {}, ...opts } = {}) {
  ```

- After `if (dataDir) fs.mkdirSync(dataDir, { recursive: true })` add:

  ```js
  // Who is in which session, for the dashboard (presence.js). Off unless both settings are set,
  // and then only for connections with a pass. Visits a crash left open are ended now.
  const presence = cfg.apiUrl && cfg.relayApiSecret
    ? new PresenceReporter({ apiUrl: cfg.apiUrl, secret: cfg.relayApiSecret, file: dataDir ? path.join(dataDir, PRESENCE_FILE) : null, log, ...presenceOptions })
    : null
  if (presence) {
    const ended = presence.load()
    if (ended) log(`presence: ended ${ended} visit(s) left open by the last run`)
    presence.start()
  }
  ```

- In `getRoom`, after `rooms.set(name, room)` add `room.presence = presence`.
- In the object `startServer` resolves with, add `presence, // exposed for tests` after `store, // exposed for tests`, and replace `close` with:

  ```js
        close: async () => {
          clearInterval(heartbeat)
          clearInterval(sweeper)
          // Every open visit ends now, and the queue gets one last try at the accounts API.
          if (presence) await presence.close()
          for (const ws of wss.clients) ws.terminate()
          for (const room of rooms.values()) room.destroy()
          rooms.clear()
          wss.close()
          await new Promise((resolve) => httpServer.close(() => resolve()))
        }
  ```

(The room sweep only looks at `*.json` files, so it never touches `presence-queue.jsonl`.)

In `src/protocol.js`, update the two comments:

```js
export const MSG_ADMIN = 14 // client (owner) -> relay: JSON { id, op: 'approve'|'deny'|'set'|'remove'|'end'|'name', key, role, scopes, name }
export const MSG_MEMBERS = 15 // relay -> client: JSON { members, sessionName, pending?, reply?: { id, ok, error } }
```

In `bin/quilt.js`, in `serve`, after the line that logs `  sign-in: …` add:

```js
  console.log(`  dashboard: ${c.apiUrl && c.relayApiSecret ? `reports who is in which session to ${c.apiUrl}` : 'off (set QUILT_API_URL and RELAY_API_SECRET to report sessions to the dashboard)'}`)
```

In `fly.toml`, in `[env]` after `PORT = "4321"`, add:

```toml
  # Presence reports for people's dashboards. They also need the RELAY_API_SECRET secret
  # (node scripts/relay-api-secret.mjs sets it on this app and on quilt-api).
  QUILT_API_URL = "https://api.heyquilt.com"
```

In `docs/hosting.md`, in the Settings table, after the `QUILT_PASS_PUBLIC_KEY` row add:

```markdown
| `QUILT_API_URL` | *(none)* | The accounts API, e.g. `https://api.heyquilt.com`. With `RELAY_API_SECRET`, the relay reports who is in which session (account, display name and times only) for people's dashboards. Unsent reports wait in `presence-queue.jsonl` in the data folder. |
| `RELAY_API_SECRET` | *(none)* | Shared with the accounts API; `node scripts/relay-api-secret.mjs` sets it on both. Set it as a secret. Without both settings, the relay reports nothing. |
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/relay-presence.test.js test/relay.test.js test/relay-passes.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.js src/protocol.js bin/quilt.js fly.toml docs/hosting.md test/relay-presence.test.js
git commit -m "The relay reports who is in which session, and owners name their sessions"
```

---

### Task 8: Naming and renaming sessions in the app

**Files:**
- Modify: `src/session.js` (constructor, `setAccess`, `setMembers`, `rename`, `sendStartName`, `status`)
- Modify: `src/runner.js` (`runSession` passes `startName`)
- Modify: `src/account.js` (`renameSession`)
- Modify: `src/ui-server.js` (imports, `startName` on create, `rename`, a route)
- Modify: `src/ui/common.js` (`ask` takes an input value), `src/ui/session.js` (Rename in the session menu), `src/ui/app.js`, `src/ui/home.js` (show the name)
- Create: `test/ui-session-name.test.js`

**Interfaces:**
- Consumes: the relay `name` op and `sessionName` in `MSG_MEMBERS` (Task 7); `PUT /v1/me/sessions/:room` with a `qd_` token (Task 5); `cleanSessionName`, `BAD_SESSION_NAME`, `SESSION_NAME_MAX` (Task 4).
- Produces:
  - `new Session({ …, startName = '' })`, `session.sessionName: string`, `session.rename(name): Promise`, `session.sendStartName()`; `status().sessionName`.
  - `runSession({ …, startName = '' })`.
  - `renameSession({ token, room, name, api?, fetch? }): Promise<{ session: { room, name } }>` in `src/account.js` (throws with `.status`).
  - App route `POST /api/sessions/:id/rename { name }` → `{ name }`; 403 `Only the session owner can rename it.`, 400 `Give the session a name of 1 to 80 characters.`, 502 when heyquilt.com refuses for a reason other than 404.
  - `ask({ input: { label, placeholder, value } })`.

- [ ] **Step 1: Write the failing test**

Create `test/ui-session-name.test.js`:

```js
// Session names in the app: a new session is named after its folder, and its owner
// can rename it for everyone, in the app and on heyquilt.com.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-names-'))
process.env.HOME = home

const { startUi } = await import('../src/ui-server.js')
const { startServer } = await import('../src/server.js')
const { startTestApi } = await import('./api-helpers.js')
const { newPassKeys } = await import('../src/passes.js')

const SECRET = 'relay-secret-for-ui-tests'
let ui, accounts, relay
before(async () => {
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey, relaySecret: SECRET })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey, apiUrl: accounts.api.url, relayApiSecret: SECRET })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  ui = await startUi({ port: 0 })
})
after(async () => { await ui.close(); await relay.close(); await accounts.close() })

const api = (method, p, body) => fetch(`http://127.0.0.1:${ui.port}${p}`, {
  method,
  headers: { 'x-quilt-token': ui.token, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))
async function waitFor (fn, ms = 10000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error('timed out')
}
const nameInApp = async (id) => (await api('GET', '/api/state')).body.sessions.find((s) => s.id === id)?.status.sessionName
const onDashboard = async (room) => (await accounts.call('GET', '/v1/me/sessions', null, 'mem')).body.sessions.find((s) => s.room === room)

test('a new session is named after its folder, and its owner renames it in the app and on heyquilt.com', async () => {
  const started = await api('POST', '/api/account/start')
  await accounts.call('POST', '/v1/device/approve', { userCode: started.body.link.userCode, approve: true }, 'mem')
  await waitFor(async () => (await api('GET', '/api/account')).body.signedIn)

  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'quilt-site') })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  const { id } = s.body
  const room = s.body.status.room
  assert.equal(await waitFor(() => nameInApp(id)), 'quilt-site')

  assert.equal((await api('POST', `/api/sessions/${id}/rename`, { name: '  ' })).status, 400)
  // Before the relay has reported the session, heyquilt.com doesn't know it yet: that's fine.
  const early = await api('POST', `/api/sessions/${id}/rename`, { name: 'Pricing page' })
  assert.deepEqual([early.status, early.body], [200, { name: 'Pricing page' }])
  assert.equal(await waitFor(async () => (await nameInApp(id)) === 'Pricing page' && 'Pricing page'), 'Pricing page')
  await relay.presence.flush()
  assert.equal((await onDashboard(room)).name, 'Pricing page', "the relay's report carries the name")

  // Now heyquilt.com knows the session, and the rename goes there directly.
  assert.equal((await api('POST', `/api/sessions/${id}/rename`, { name: 'Launch' })).status, 200)
  assert.equal((await onDashboard(room)).name, 'Launch')
  await api('POST', `/api/sessions/${id}/stop`)
})

test('the app has Rename for the owner, and shows the name in its session tabs', async () => {
  const session = await (await fetch(`http://127.0.0.1:${ui.port}/session.js`)).text()
  assert.ok(session.includes('Rename session…'))
  assert.ok(session.includes("$('#rename-btn').hidden = !st.access?.owner"))
  const app = await (await fetch(`http://127.0.0.1:${ui.port}/app.js`)).text()
  assert.ok(app.includes('s.status.sessionName || basename(s.dir)'))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/ui-session-name.test.js`
Expected: FAIL: the first test times out waiting for the session's name (`Error: timed out`), and the second finds no `Rename session…`.

- [ ] **Step 3: Implement the session side**

In `src/session.js`:

- Add `startName = ''` at the end of the constructor's options: `… identity = null, passes = null, startName = '' }) {`.
- After `this.waiting = [] // people asking to join (only the owner hears about them)` add:

  ```js
    this.sessionName = '' // what the owner named the session (the relay sends it with the member list)
    this.startName = startName // a new session's name (its folder), sent once the relay lets us in as owner
    this.startNameSent = false
  ```

- In `setAccess`, right after `this.access = a` add:

  ```js
    if (a.state === 'approved' && a.owner) this.sendStartName()
  ```

- Change `setMembers` to start:

  ```js
  setMembers ({ members, pending, sessionName }) {
    this.members = members || []
    if (typeof sessionName === 'string') this.sessionName = sessionName
  ```

- After `removeMember (key) { … }` add:

  ```js
  /** Owner only: names the session for everyone in it (1 to 80 characters). */
  rename (name) { return this.conn.adminRequest({ op: 'name', name }) }

  /** A new session is named after its folder, once, as soon as the relay lets us in as its owner. */
  sendStartName () {
    if (!this.startName || this.startNameSent) return
    this.startNameSent = true
    this.rename(this.startName).catch((err) => this.log(`couldn't name the session: ${err.message}`))
  }
  ```

- In `status()`, after `access: this.access,` add `sessionName: this.sessionName,`.

In `src/runner.js`, add `startName = ''` at the end of `runSession`'s options (`… passes = null, identity = null, startName = '' }) {`) and pass it on:

```js
  const session = new Session({ dir, ...conn, name, tool, color, prefer, kind, shareAgent, identity, passes, startName })
```

In `src/account.js`, before the `signOut` doc comment, add:

```js
/**
 * The owner renames a session on heyquilt.com: { session: { room, name } }. Throws with
 * .status: 404 until the relay has reported the session, 403 for anyone but the owner.
 */
export async function renameSession ({ token, room, name, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  return call(fetchImpl, api, 'PUT', `/v1/me/sessions/${encodeURIComponent(room)}`, { name }, token)
}
```

- [ ] **Step 4: Implement the app's server**

In `src/ui-server.js`:

- Change the `./account.js` import to add `renameSession`, and import the name rules:

  ```js
  import { readAccount, saveAccount, clearAccount, startLink, waitForLink, fetchMe, signOut, revokeToken, accountFromProfile, renameSession } from './account.js'
  import { cleanSessionName, BAD_SESSION_NAME, SESSION_NAME_MAX } from './session-name.js'
  ```

- In `start`, in the `runSession({ … })` call, after `passes: sessionPasses,` add:

  ```js
        // A new session is named after its folder (the owner can rename it later).
        startName: mode === 'create' ? cleanSessionName([...path.basename(dir)].slice(0, SESSION_NAME_MAX).join('')) || '' : '',
  ```

- Before the comment `/** The session's folder, if this app may run git in it. */`, add:

  ```js
  /**
   * The owner renames a session: on the relay, so everyone in it sees the new name, then on
   * heyquilt.com. Until the relay has reported a new session there (within a minute) the
   * website answers 404, and the relay's own report carries the new name instead.
   */
  async function rename (id, raw) {
    const s = get(id)
    if (!s.isOwner) throw httpError(403, 'Only the session owner can rename it.')
    const name = cleanSessionName(raw)
    if (!name) throw httpError(400, BAD_SESSION_NAME)
    await s.rename(name)
    try {
      await renameSession({ token: readAccount()?.token, room: s.room, name })
    } catch (err) {
      if (err.status !== 404) throw httpError(502, `Renamed here, but heyquilt.com didn't take it: ${err.message}`)
    }
    return { name }
  }

  ```

- In the `api` table, before `'POST /api/sessions/:id/end'`, add:

  ```js
    'POST /api/sessions/:id/rename': (b, id) => rename(id, b.name),
  ```

- [ ] **Step 5: Implement the page**

In `src/ui/common.js`, in `ask`, give the input its value:

```js
      ${input ? `<div class="field"><label for="ask-input">${esc(input.label || '')}</label><input class="input" id="ask-input" placeholder="${esc(input.placeholder || '')}" value="${esc(input.value || '')}"></div>` : ''}
```

In `src/ui/session.js`:

- In the `#more-menu` markup, before the `ask-commit` item, add:

  ```js
          <button class="pop-item" role="menuitem" id="rename-btn" hidden>Rename session…</button>
  ```

- In `bindTop`, after `$('#ask-commit').onclick = askForCommit` add `$('#rename-btn').onclick = renameSession`.
- In `renderTop`, after `renderCommitChip()` add `$('#rename-btn').hidden = !st.access?.owner`.
- Before `/** Owner controls for everyone who has been let in, shown in the people menu. */` add:

  ```js
  /** Owner only: renames the session for everyone in it, and on heyquilt.com. */
  async function renameSession () {
    const s = sum()
    const name = await ask({ title: 'Rename this session', message: 'Everyone in it sees the new name, here and on heyquilt.com.', ok: 'Rename', input: { label: 'Name', value: s.status.sessionName || basename(s.dir) } })
    if (!name) return
    try { await api('POST', `/api/sessions/${current}/rename`, { name }); toast('Renamed') } catch (err) { toast(err.message) }
  }

  ```

In `src/ui/app.js`, in `renderTabs`, show the name: replace `${esc(basename(s.dir))}` with `${esc(s.status.sessionName || basename(s.dir))}`.

In `src/ui/home.js`, in the "Open now" menu items, replace `<span class="grow">${esc(basename(s.dir))}</span><span class="hint">${s.status.peers.length + 1} here</span>` with `<span class="grow">${esc(s.status.sessionName || basename(s.dir))}</span><span class="hint">${s.status.peers.length + 1} here</span>`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/ui-session-name.test.js test/ui.test.js test/ui-account.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/session.js src/runner.js src/account.js src/ui-server.js src/ui/common.js src/ui/session.js src/ui/app.js src/ui/home.js test/ui-session-name.test.js
git commit -m "Name new sessions after their folder, and let the owner rename them from the app"
```

---

### Task 9: Sessions on the website

**Files:**
- Create: `web/lib/activity-view.js`, `web/test/activity-view.test.js`
- Create: `web/components/Avatars.js`, `web/components/SessionName.js`, `web/components/TimeZoneCookie.js`
- Create: `web/app/dashboard/sessions/[room]/page.js`
- Modify: `web/app/dashboard/page.js`, `web/app/dashboard/actions.js`, `web/app/globals.css`, `web/test/routes.test.js`

**Interfaces:**
- Consumes: `GET /v1/me/sessions?tz=`, `GET /v1/me/sessions/:room`, `PUT /v1/me/sessions/:room` (Task 5) through `apiCall` (`web/lib/api.js`); `requireUser` (`web/lib/session.js`); `AppHeader`.
- Produces:
  - `web/lib/activity-view.js`: `TZ_COOKIE = 'quilt_tz'`, `EMPTY_SESSIONS`, `UNTITLED`, `MAX_AVATARS = 5`, `isRoom(s)`, `tzFrom(cookieValue)`, `formatDuration(ms)`, `timeAgo(t, now, tz)`, `formatDate(t, tz)`, `formatTime(t, tz)`, `visitLine(v, tz)`, `sessionTitle(name)`, `initialsOf(name)`, `avatarList(people, max)`, `ownerLine(session)`.
  - `<Avatars people max />`, `<SessionName room name canRename action href />`, `<TimeZoneCookie current />`.
  - Server action `renameSession(prev, formData)` in `web/app/dashboard/actions.js` → `{ name }` or `{ error }`.
  - The page `/dashboard/sessions/[room]`.

- [ ] **Step 1: Write the failing tests**

Create `web/test/activity-view.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRoom, tzFrom, formatDuration, timeAgo, formatDate, formatTime, visitLine, sessionTitle, initialsOf, avatarList, ownerLine, EMPTY_SESSIONS } from '../lib/activity-view.js'

const T = (iso) => Date.parse(iso)
const MIN = 60 * 1000

test('durations read like "3h 20m", and short ones as "under a minute"', () => {
  assert.equal(formatDuration(0), 'under a minute')
  assert.equal(formatDuration(59 * 1000), 'under a minute')
  assert.equal(formatDuration(MIN), '1m')
  assert.equal(formatDuration(45 * MIN + 30 * 1000), '45m')
  assert.equal(formatDuration(180 * MIN), '3h')
  assert.equal(formatDuration(200 * MIN), '3h 20m')
  assert.equal(formatDuration(NaN), 'under a minute')
})

test('"2 hours ago" and friends, then the date in the visitor\'s time zone', () => {
  const now = T('2026-10-07T12:00:00Z')
  assert.equal(timeAgo(now - 10 * 1000, now), 'just now')
  assert.equal(timeAgo(now - MIN, now), '1 minute ago')
  assert.equal(timeAgo(now - 5 * MIN, now), '5 minutes ago')
  assert.equal(timeAgo(now - 60 * MIN, now), '1 hour ago')
  assert.equal(timeAgo(now - 120 * MIN, now), '2 hours ago')
  assert.equal(timeAgo(now - 30 * 60 * MIN, now), 'yesterday')
  assert.equal(timeAgo(now - 3 * 24 * 60 * MIN, now), '3 days ago')
  assert.equal(timeAgo(T('2026-08-01T02:00:00Z'), now, 'UTC'), 'on Aug 1, 2026')
  assert.equal(timeAgo(T('2026-08-01T02:00:00Z'), now, 'America/Los_Angeles'), 'on Jul 31, 2026')
  assert.equal(timeAgo(now + MIN, now), 'just now', 'a clock a little ahead is not the future')
})

test('dates, times and visits in the visitor\'s time zone', () => {
  const t = T('2026-10-05T13:05:00Z')
  assert.equal(formatDate(t, 'Europe/Paris'), 'Oct 5, 2026')
  assert.equal(formatTime(t, 'Europe/Paris'), '3:05 PM')
  assert.equal(formatTime(t, 'America/New_York'), '9:05 AM')
  assert.deepEqual(visitLine({ startedAt: t, endedAt: t + 90 * MIN }, 'UTC'), { date: 'Oct 5, 2026', from: '1:05 PM', to: '2:35 PM' })
  assert.deepEqual(visitLine({ startedAt: t, endedAt: null }, 'UTC').to, 'still here')
})

test('the time zone cookie, room ids, titles, initials, avatars and owners', () => {
  assert.equal(tzFrom('Europe/Paris'), 'Europe/Paris')
  for (const bad of [undefined, '', 'Mars/Olympus', 'x'.repeat(65)]) assert.equal(tzFrom(bad), 'UTC')
  assert.equal(isRoom('aB3_-x'), true)
  for (const bad of ['', 'a/b', 'x'.repeat(65), null]) assert.equal(isRoom(bad), false)
  assert.equal(sessionTitle('quilt-site'), 'quilt-site')
  assert.equal(sessionTitle(''), 'Untitled session')
  assert.equal(initialsOf('Dana Carmichael'), 'DC')
  assert.equal(initialsOf('larry'), 'L')
  assert.equal(initialsOf(''), '?')
  const people = Array.from({ length: 7 }, (_, i) => ({ account: `person:${i}`, name: `P${i}` }))
  assert.deepEqual(avatarList(people).shown.map((p) => p.name), ['P0', 'P1', 'P2', 'P3', 'P4'])
  assert.equal(avatarList(people).more, 2)
  assert.deepEqual(avatarList(undefined), { shown: [], more: 0 })
  assert.equal(ownerLine({ mine: true, owner: { name: 'Me' } }), 'Owned by you')
  assert.equal(ownerLine({ mine: false, owner: { name: 'Dana' } }), 'Owned by Dana')
  assert.equal(ownerLine({ mine: false, owner: { name: '' } }), 'Owned by someone')
  assert.equal(EMPTY_SESSIONS, 'No sessions yet. Start one in the Quilt app and it shows up here.')
})
```

In `web/test/routes.test.js`, make the page-manifest test include the session page:

```js
test('Computers, Agents and each session have their own pages under the dashboard', () => {
  const pages = Object.keys(JSON.parse(readFileSync(new URL('../.next/server/app-paths-manifest.json', import.meta.url))))
  for (const page of ['/dashboard/page', '/dashboard/computers/page', '/dashboard/agents/page', '/dashboard/sessions/[room]/page']) assert.ok(pages.includes(page), page)
})
```

and add `'/dashboard/sessions/room-abc'` to the list in `private pages send signed-out people to sign in, and come back after`, after `'/dashboard/agents'`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && npm test`
Expected: FAIL: `activity-view.test.js` with `ERR_MODULE_NOT_FOUND` for `lib/activity-view.js`, and the manifest test with `/dashboard/sessions/[room]/page`.

- [ ] **Step 3: Write the helpers and components**

Create `web/lib/activity-view.js`:

```js
// Words and times for your sessions on the dashboard. Pure, no Next imports, so it's
// unit-tested directly. Times are epoch ms from the API.

export const TZ_COOKIE = 'quilt_tz'
export const EMPTY_SESSIONS = 'No sessions yet. Start one in the Quilt app and it shows up here.'
export const UNTITLED = 'Untitled session'
export const MAX_AVATARS = 5
const ROOM = /^[A-Za-z0-9_-]{1,64}$/
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Whether `s` could be a session's room id (anything else is a 404 without asking the API). */
export const isRoom = (s) => ROOM.test(String(s || ''))

/** The visitor's time zone from the cookie their browser set, or UTC until it has. */
export function tzFrom (value) {
  if (typeof value !== 'string' || !value || value.length > 64) return 'UTC'
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return value } catch { return 'UTC' }
}

/** "under a minute", "45m", "3h", "3h 20m". */
export function formatDuration (ms) {
  if (!Number.isFinite(ms) || ms < MIN) return 'under a minute'
  const mins = Math.floor(ms / MIN)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'} ago`

/** "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago", or the date. */
export function timeAgo (t, now, tz = 'UTC') {
  const d = Math.max(0, now - t)
  if (d < MIN) return 'just now'
  if (d < HOUR) return plural(Math.floor(d / MIN), 'minute')
  if (d < DAY) return plural(Math.floor(d / HOUR), 'hour')
  if (d < 2 * DAY) return 'yesterday'
  if (d < 30 * DAY) return plural(Math.floor(d / DAY), 'day')
  return `on ${formatDate(t, tz)}`
}

/** "Oct 5, 2026" in the visitor's time zone. */
export function formatDate (t, tz = 'UTC') {
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz })
}

/** "9:05 AM" in the visitor's time zone. */
export function formatTime (t, tz = 'UTC') {
  return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
}

/** One of my visits: its date, and from and to ("still here" while it's open). */
export function visitLine (v, tz = 'UTC') {
  return { date: formatDate(v.startedAt, tz), from: formatTime(v.startedAt, tz), to: v.endedAt == null ? 'still here' : formatTime(v.endedAt, tz) }
}

export const sessionTitle = (name) => (typeof name === 'string' && name.trim() ? name : UNTITLED)

/** Initials for an avatar: the first letters of the first and last words. */
export function initialsOf (name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  return (Array.from(words[0])[0] + (words.length > 1 ? Array.from(words[words.length - 1])[0] : '')).toUpperCase()
}

/** The avatars a session row shows: up to `max`, and how many more there are. */
export function avatarList (people, max = MAX_AVATARS) {
  const list = Array.isArray(people) ? people : []
  return { shown: list.slice(0, max), more: Math.max(0, list.length - max) }
}

/** "Owned by you", "Owned by Dana", or "Owned by someone" when the name is unknown. */
export function ownerLine (session) {
  if (session.mine) return 'Owned by you'
  return `Owned by ${session.owner?.name || 'someone'}`
}
```

Create `web/components/TimeZoneCookie.js`:

```js
'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { TZ_COOKIE } from '@/lib/activity-view.js'

// Times on the dashboard are in the visitor's own time zone. Pages render on the server,
// so the browser tells it the zone once, in a cookie, and the page refreshes with it.
// `current` is the cookie as the server read it.
export default function TimeZoneCookie ({ current }) {
  const router = useRouter()
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!tz || tz === current) return
    // IANA names are cookie-safe as they are (letters, digits, / _ + -).
    document.cookie = `${TZ_COOKIE}=${tz}; path=/; max-age=31536000; samesite=lax`
    router.refresh()
  }, [current, router])
  return null
}
```

Create `web/components/Avatars.js`:

```js
import { avatarList, initialsOf } from '@/lib/activity-view.js'

// Faces for the people and agents in a session (at most `max`, then "+N"). Agents wear the agent badge.
export default function Avatars ({ people, max }) {
  const { shown, more } = avatarList(people, max)
  return (
    <span className='avatars'>
      {shown.map((p) => (
        <span key={p.account} className={`avatar${p.kind === 'agent' ? ' agent' : ''}`} title={p.kind === 'agent' ? `${p.name} (agent)` : p.name}>
          <span aria-hidden='true'>{initialsOf(p.name)}</span>
          <span className='sr-only'>{p.kind === 'agent' ? `${p.name} (agent)` : p.name}</span>
          {p.kind === 'agent' && (
            <span className='avatar-badge' aria-hidden='true'>
              <svg viewBox='0 0 12 12' width='9' height='9'><rect x='2' y='3.5' width='8' height='6' rx='1.5' fill='none' stroke='currentColor' strokeWidth='1.3' /><path d='M6 1.5v2' stroke='currentColor' strokeWidth='1.3' /><circle cx='4.5' cy='6.5' r='.8' fill='currentColor' /><circle cx='7.5' cy='6.5' r='.8' fill='currentColor' /></svg>
            </span>)}
        </span>))}
      {more > 0 && <span className='avatar more'>+{more}</span>}
    </span>
  )
}
```

Create `web/components/SessionName.js`:

```js
'use client'
import { useActionState, useEffect, useState } from 'react'
import Link from 'next/link'
import { sessionTitle } from '@/lib/activity-view.js'

/** A session's name. Its owner gets a pencil that renames it in place, for everyone. */
export default function SessionName ({ room, name, canRename, action, href }) {
  const [editing, setEditing] = useState(false)
  const [state, formAction, pending] = useActionState(action, null)
  const current = state?.name ?? name
  // A successful rename closes the form; an error keeps it open, with the message.
  useEffect(() => { if (state?.name) setEditing(false) }, [state])
  if (editing) {
    return (
      <form action={formAction} className='rename-form'>
        <input type='hidden' name='room' value={room} />
        <input className='input' name='name' defaultValue={current} maxLength={80} required aria-label='Session name' autoFocus />
        <button className='btn' disabled={pending}>Save</button>
        <button type='button' className='btn ghost' onClick={() => setEditing(false)}>Cancel</button>
        {state?.error && <span className='notice bad'>{state.error}</span>}
      </form>
    )
  }
  const title = sessionTitle(current)
  return (
    <span className='session-name'>
      {href ? <Link href={href}>{title}</Link> : <span>{title}</span>}
      {canRename && (
        <button type='button' className='btn ghost icon-btn' onClick={() => setEditing(true)} aria-label={`Rename ${title}`} title='Rename'>
          <svg viewBox='0 0 16 16' width='14' height='14' aria-hidden='true'><path d='M11.5 2.5l2 2L6 12l-3 1 1-3z' fill='none' stroke='currentColor' strokeWidth='1.5' strokeLinejoin='round' /></svg>
        </button>)}
    </span>
  )
}
```

- [ ] **Step 4: The rename action**

In `web/app/dashboard/actions.js`, add the import after `import { isSlug } from '@/lib/space.js'`:

```js
import { isRoom } from '@/lib/activity-view.js'
```

and before the comment `// An org sign-up carries its org's name in the account until the org exists.` add:

```js
// Renaming a session you own, from the dashboard or its page (the API checks you own it).
// Returns the new name, or an error for the form to show.
export async function renameSession (prev, formData) {
  const user = await requireUser('/dashboard')
  const room = String(formData.get('room') || '')
  if (!isRoom(room)) return { error: 'That session wasn’t found.' }
  const r = await apiCall(user, 'PUT', `/v1/me/sessions/${room}`, { name: String(formData.get('name') || '') })
  if (!r.ok) return { error: r.data?.error || 'Couldn’t rename the session. Try again.' }
  revalidatePath('/dashboard')
  revalidatePath(`/dashboard/sessions/${room}`)
  return { name: r.data.session.name }
}

```

- [ ] **Step 5: The overview and the session page**

In `web/app/dashboard/page.js`:

- After `import FirstOrg from '@/components/FirstOrg.js'` add:

  ```js
  import Avatars from '@/components/Avatars.js'
  import SessionName from '@/components/SessionName.js'
  import TimeZoneCookie from '@/components/TimeZoneCookie.js'
  ```

- Replace the last two imports (`countLabel` and `./actions.js`) with:

  ```js
  import { countLabel } from '@/lib/dashboard-view.js'
  import { TZ_COOKIE, tzFrom, formatDuration, timeAgo, EMPTY_SESSIONS } from '@/lib/activity-view.js'
  import { askToJoin, renameSession } from './actions.js'
  ```

- Replace

  ```js
  const home = spaceHome((await cookies()).get(SPACE_COOKIE)?.value, orgs)
  if (home !== '/dashboard') redirect(home)
  ```

  with

  ```js
  const jar = await cookies()
  const home = spaceHome(jar.get(SPACE_COOKIE)?.value, orgs)
  if (home !== '/dashboard') redirect(home)
  // Times are in the visitor's time zone, which their browser puts in a cookie (TimeZoneCookie).
  const rawTz = jar.get(TZ_COOKIE)?.value || ''
  const tz = tzFrom(rawTz)
  ```

- Make the `Promise.all` also fetch the sessions: its destructuring becomes `const [{ count: computers }, agentsRes, discover, { data: profile }, activity] = await Promise.all([`, and after the `profiles` query (add a comma after it) add:

  ```js
    // Your sessions, your time in them and who you worked with (the relay reports who was where).
    apiCall(user, 'GET', `/v1/me/sessions?tz=${encodeURIComponent(tz)}`)
  ```

- After `const joinable = discover.data?.orgs || []` add:

  ```js
  const totals = activity.data?.totals || { collaboratingThisWeek: 0, topCollaborators: [] }
  const sessions = activity.data?.sessions || []
  const now = Date.now()
  ```

- Just before `<div className='overview-grid'>`, add:

```jsx
        <TimeZoneCookie current={rawTz} />
        {!activity.ok && <p className='notice bad'>Could not load your sessions right now.</p>}
        {activity.ok && (
          <section className='card summary-grid'>
            <div className='stack' style={{ gap: 4 }}>
              <span className='muted'>Time collaborating this week</span>
              <b className='big-number'>{formatDuration(totals.collaboratingThisWeek)}</b>
            </div>
            <div className='stack' style={{ gap: 8 }}>
              <span className='muted'>Worked with most this month</span>
              {totals.topCollaborators.length
                ? (
                  <div className='row'>
                    {totals.topCollaborators.map((c) => (
                      <span key={c.account} className='row' style={{ gap: 8 }}>
                        <Avatars people={[c]} max={1} />
                        <span><b>{c.name}</b>{c.kind === 'agent' && <> <span className='pill'>Agent</span></>}<br /><span className='muted'>{formatDuration(c.ms)}</span></span>
                      </span>))}
                  </div>)
                : <span className='muted'>Nobody yet this month.</span>}
            </div>
          </section>)}
        {activity.ok && (
          <section className='card stack'>
            <h2>Your sessions</h2>
            {!sessions.length && <p className='muted'>{EMPTY_SESSIONS}</p>}
            <div>
              {sessions.map((s) => (
                <div key={s.room} className='list-row'>
                  <span className='stack' style={{ gap: 2 }}>
                    <SessionName room={s.room} name={s.name} canRename={s.mine} action={renameSession} href={`/dashboard/sessions/${s.room}`} />
                    <span className='muted'>Active {timeAgo(s.lastActiveAt, now, tz)} · {formatDuration(s.myTotalMs)} for you</span>
                  </span>
                  <Avatars people={s.people} />
                </div>))}
            </div>
          </section>)}
```

Create `web/app/dashboard/sessions/[room]/page.js`:

```js
import { cookies } from 'next/headers'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import AppHeader from '@/components/AppHeader.js'
import Avatars from '@/components/Avatars.js'
import SessionName from '@/components/SessionName.js'
import TimeZoneCookie from '@/components/TimeZoneCookie.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { TZ_COOKIE, tzFrom, isRoom, formatDuration, timeAgo, formatDate, visitLine, ownerLine } from '@/lib/activity-view.js'
import { renameSession } from '../../actions.js'

export const metadata = { title: 'Session' }

// One session you were in: who owns it, your time, who was there with you, and your visits.
export default async function SessionPage ({ params }) {
  const { room } = await params
  if (!isRoom(room)) notFound()
  const user = await requireUser(`/dashboard/sessions/${room}`)
  const rawTz = (await cookies()).get(TZ_COOKIE)?.value || ''
  const tz = tzFrom(rawTz)
  const res = await apiCall(user, 'GET', `/v1/me/sessions/${room}`)
  if (res.status === 404) notFound()
  const s = res.ok ? res.data?.session : null
  const now = Date.now()
  return (
    <>
      <AppHeader user={user} space='personal' />
      <main className='wrap page stack'>
        <TimeZoneCookie current={rawTz} />
        <p><Link href='/dashboard'>Back to your dashboard</Link></p>
        {!s
          ? <p className='notice bad'>Could not load this session right now.</p>
          : (
            <>
              <h1 style={{ fontSize: 32 }}><SessionName room={s.room} name={s.name} canRename={s.mine} action={renameSession} /></h1>
              <section className='card stack'>
                <p className='muted'>{ownerLine(s)}</p>
                <div className='summary-grid'>
                  <div><span className='muted'>Started</span><br /><b>{formatDate(s.createdAt, tz)}</b></div>
                  <div><span className='muted'>Last active</span><br /><b>{timeAgo(s.lastActiveAt, now, tz)}</b></div>
                  <div><span className='muted'>Your time</span><br /><b>{formatDuration(s.myTotalMs)}</b></div>
                </div>
              </section>
              <section className='card stack'>
                <h2>People and agents</h2>
                {!s.people.length && <p className='muted'>Nobody else was here while you were.</p>}
                {s.people.map((p) => (
                  <div key={p.account} className='list-row'>
                    <span className='row' style={{ gap: 10 }}>
                      <Avatars people={[p]} max={1} />
                      <span><b>{p.name}</b>{p.kind === 'agent' && <> <span className='pill'>Agent</span></>}</span>
                    </span>
                    <span className='muted'>{formatDuration(p.togetherMs)} together · last together {timeAgo(p.lastTogetherAt, now, tz)}</span>
                  </div>))}
              </section>
              <section className='card stack'>
                <h2>Your recent visits</h2>
                {s.visits.map((v, i) => {
                  const line = visitLine(v, tz)
                  return (
                    <div key={`${v.startedAt}-${i}`} className='list-row'>
                      <b>{line.date}</b>
                      <span className='muted'>{line.from} to {line.to}</span>
                    </div>
                  )
                })}
              </section>
            </>)}
      </main>
    </>
  )
}
```

In `web/app/globals.css`, before `.fields-narrow`, add:

```css
/* ---- Dashboard: your sessions (overview and /dashboard/sessions/<room>) ---- */
.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; }
.big-number { font-size: 28px; font-weight: 600; }
.session-name { display: inline-flex; align-items: center; gap: 4px; font-weight: 600; }
.session-name a { color: var(--text); text-decoration: none; }
.session-name a:hover { text-decoration: underline; }
.icon-btn { height: 28px; width: 28px; padding: 0; }
.rename-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 15px; }
.avatars { display: inline-flex; align-items: center; }
.avatar { position: relative; width: 30px; height: 30px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 12px; font-weight: 600; background: var(--qm-c); border: 2px solid var(--panel); margin-left: -6px; }
.avatars .avatar:first-child { margin-left: 0; }
.avatar.agent { background: var(--qm-d); }
.avatar.more { background: var(--panel-2); color: var(--muted); }
.avatar-badge { position: absolute; right: -4px; bottom: -4px; width: 15px; height: 15px; border-radius: 50%; background: var(--text); color: var(--bg); display: grid; place-items: center; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd web && npm test`
Expected: PASS (it builds the site, so the new page compiles; the em-dash scan covers the new copy).

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/lib/activity-view.js web/test/activity-view.test.js web/components/Avatars.js web/components/SessionName.js web/components/TimeZoneCookie.js "web/app/dashboard/sessions/[room]/page.js" web/app/dashboard/page.js web/app/dashboard/actions.js web/app/globals.css web/test/routes.test.js
git commit -m "Show your sessions, your time and who you worked with on the dashboard"
```

---

### Task 10: The shared secret script, release notes and version

**Files:**
- Create: `scripts/relay-api-secret.mjs`, `test/relay-api-secret-script.test.js`
- Modify: `fly.api.toml` (setup comment), `RELEASES.md`, `package.json`, `package-lock.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `node scripts/relay-api-secret.mjs` (stages `RELAY_API_SECRET` on `quilt-api` and `cowove-relay`; `FLY_BIN` overrides `fly`); version `0.3.2`.

- [ ] **Step 1: Write the failing test**

Create `test/relay-api-secret-script.test.js`:

```js
// scripts/relay-api-secret.mjs: one new secret, the same for both Fly apps, never printed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const script = new URL('../scripts/relay-api-secret.mjs', import.meta.url).pathname

/** A stand-in for fly that records its arguments and stdin, and exits with `code` for `failApp`. */
function fakeFly (failApp = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-fakefly-'))
  const bin = path.join(dir, 'fly')
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs')
const input = fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n')
process.exit(process.argv.includes(${JSON.stringify(failApp)}) ? 1 : 0)
`, { mode: 0o755 })
  const calls = () => fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  return { bin, calls }
}

test('stages one fresh secret on both apps and never prints it', () => {
  const fly = fakeFly()
  const r = spawnSync(process.execPath, [script], { env: { ...process.env, FLY_BIN: fly.bin }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const calls = fly.calls()
  assert.deepEqual(calls.map((c) => c.args), [['secrets', 'import', '--app', 'quilt-api', '--stage'], ['secrets', 'import', '--app', 'cowove-relay', '--stage']])
  const [a, b] = calls.map((c) => c.input)
  assert.match(a, /^RELAY_API_SECRET=[A-Za-z0-9_-]{43}\n$/)
  assert.equal(a, b, 'the same secret on both')
  const secret = a.trim().split('=')[1]
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), 'never printed')
  assert.match(r.stdout, /staged on quilt-api and cowove-relay/)
  const again = fakeFly()
  spawnSync(process.execPath, [script], { env: { ...process.env, FLY_BIN: again.bin } })
  assert.notEqual(again.calls()[0].input, a, 'a new secret every run')
})

test('a failed import stops with a non-zero exit and says to run it again', () => {
  const fly = fakeFly('quilt-api')
  const r = spawnSync(process.execPath, [script], { env: { ...process.env, FLY_BIN: fly.bin }, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /failed for quilt-api\. Run this again/)
  assert.equal(fly.calls().length, 1, 'the relay is not given a secret the API does not have')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/relay-api-secret-script.test.js`
Expected: FAIL: node can't find `scripts/relay-api-secret.mjs` (`r.status` is 1, not 0).

- [ ] **Step 3: Implement**

Create `scripts/relay-api-secret.mjs`:

```js
// Makes RELAY_API_SECRET, the secret the relay signs its presence reports with, and
// hands the same value to both Fly apps without it ever reaching a screen or a file:
//   node scripts/relay-api-secret.mjs
// Each app gets it staged (`fly secrets import --stage`), so it applies on that app's
// next deploy. If either import fails, run it again: it makes a new secret for both.
// FLY_BIN points it at another fly command (tests use a stand-in).
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const APPS = ['quilt-api', 'cowove-relay']
const fly = process.env.FLY_BIN || 'fly'
const secret = crypto.randomBytes(32).toString('base64url')

for (const app of APPS) {
  const r = spawnSync(fly, ['secrets', 'import', '--app', app, '--stage'], { input: `RELAY_API_SECRET=${secret}\n`, stdio: ['pipe', 'inherit', 'inherit'] })
  if (r.status !== 0) {
    process.stderr.write(`fly secrets import failed for ${app}. Run this again: it makes a new secret for both apps.\n`)
    process.exit(1)
  }
}
process.stdout.write(`RELAY_API_SECRET is staged on ${APPS.join(' and ')}; it applies when each is next deployed.\n`)
```

In `fly.api.toml`, after the `pass-keys.mjs` setup line add:

```toml
#   node scripts/relay-api-secret.mjs   # RELAY_API_SECRET on this app and cowove-relay, never printed
```

Bump the version: `npm version 0.3.2 --no-git-tag-version` (updates `package.json` and `package-lock.json`).

In `RELEASES.md`, add this section above the `## 0.3.1` section (a hyphen in the heading, so no em dash; the parser accepts both):

```markdown
## 0.3.2 - 2026-10-02

Sessions have names, and heyquilt.com shows where you've been.

- **Sessions are named.** A new session takes its folder's name. Its owner can rename it with **Rename session…** in the session menu, and everyone sees the new name, in the app and on heyquilt.com.
- **Your sessions on heyquilt.com.** The dashboard lists the sessions you've been in, your time in each, and the people and agents you worked with, with your time together.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/relay-api-secret-script.test.js test/releases.test.js`
Expected: PASS.

Run: `npm test && (cd web && npm test)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/relay-api-secret.mjs test/relay-api-secret-script.test.js fly.api.toml RELEASES.md package.json package-lock.json
git commit -m "Add the relay API secret script, and release notes for 0.3.2"
```

---

## Deploy

For the controller, once every task above is merged to `main`. Steps marked **(user)** need Daniel. Never print, log or paste `RELAY_API_SECRET` (or any other secret); it moves only by pipe into `fly secrets import`.

0. **A clean clone, never a worktree or the shared main checkout.** Fly uploads the working tree, and Netlify needs a real clone to package the proxy edge function.

   ```bash
   D="$(mktemp -d)/deploy-clone"
   git clone https://github.com/DanielCarmichaelGit/heyquilt.git "$D" && cd "$D" && git checkout main && git log -1 --oneline
   npm ci
   ```

   Check `git log -1` is the merge with these tasks.

1. **`RELAY_API_SECRET`, once, straight into both Fly apps.** From the clone:

   ```bash
   node scripts/relay-api-secret.mjs
   ```

   It prints only `RELAY_API_SECRET is staged on quilt-api and cowove-relay; …`. Check both have it without showing it: `fly secrets list --app quilt-api` and `fly secrets list --app cowove-relay` each list `RELAY_API_SECRET` (a digest, never the value). If the script failed part-way, run it again: it makes a new secret for both.

2. **The migration, on Supabase `pwebomewzuezaxoowykk`.** With the Supabase MCP:
   - `apply_migration` with `project_id: pwebomewzuezaxoowykk`, `name: session_activity`, and `query` = the full contents of `supabase/migrations/20261002000000_session_activity.sql`.
   - Check with `list_tables` (schema `public`) that `relay_sessions`, `session_visits` and `relay_events_seen` exist with RLS enabled, and with `execute_sql`: `select proname from pg_proc where proname in ('ingest_presence','account_sessions','visits_in_rooms','prune_activity','delete_account_activity');` returns five rows.
   - `get_advisors` (type `security`): the only new notices should be "RLS enabled, no policy" for the three tables, which is intended (only the API's service role reads them, like `agent_keys`).

3. **The API.** From the clone:

   ```bash
   fly deploy --config fly.api.toml --app quilt-api --remote-only --ha=false
   ```

   Check:
   - `curl -s https://api.heyquilt.com/healthz` is `{"ok":true}`.
   - `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.heyquilt.com/v1/relay/presence -H 'content-type: application/json' -d '{"events":[]}'` prints `401` (a `503` means the secret didn't reach the API: check step 1).
   - `curl -s -o /dev/null -w '%{http_code}\n' https://api.heyquilt.com/v1/me/sessions` prints `401`.
   - `QUILT_API=https://api.heyquilt.com node scripts/api-smoke.mjs` passes.

4. **The relay.** From the clone (`fly.toml` now sets `QUILT_API_URL`, and the staged secret applies on this deploy):

   ```bash
   fly deploy --app cowove-relay --remote-only --ha=false
   ```

   Check:
   - `curl -s https://relay.heyquilt.com/healthz` is OK.
   - `fly logs --app cowove-relay --no-tail | grep 'dashboard:'` shows `dashboard: reports who is in which session to https://api.heyquilt.com`.
   - Open sessions reconnect on their own after the restart.

5. **The website.** From the clone's `web/`:

   ```bash
   cd "$D/web" && npm ci && NETLIFY_SITE_ID=b9131760-8605-44f7-b9e1-3b347fc212b0 netlify deploy --build --prod
   ```

   Check the output says `Packaging Edge Functions`, then `curl -sI https://heyquilt.com/dashboard` and `curl -sI https://heyquilt.com/dashboard/sessions/room-abc` are both `307` to `/signin`.

6. **The desktop release 0.3.2.** **(user: publishing a release is public; confirm before it goes out.)** From the clean clone on `main`: `npm run release` (it builds, tags `v0.3.2`, pushes and publishes the GitHub release with the `RELEASES.md` section). Check `curl -sIL https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/quilt-mac-arm64.dmg` ends in `200`.

7. **Live check.** Two accounts spend a few minutes in one session:
   - **(user)** With Quilt 0.3.2 signed in as account A, start a session on a new folder named `live-check`. The session menu shows **Rename session…**.
   - **(user)** Join it as account B, from another computer or from a terminal on the Mac: `export HOME="$(mktemp -d)"`, `node bin/quilt.js login` (approve as B in a private browser window), `node bin/quilt.js join <invite link>`. A lets B in.
   - Wait at least 3 minutes, then B leaves (Ctrl-C), and wait 2 more minutes (the relay reports every minute).
   - With the Supabase MCP `execute_sql`: `select room, name, owner_account, last_active_at from relay_sessions order by last_active_at desc limit 3;` shows the room named `live-check`, and `select account, account_name, started_at, ended_at from session_visits order by started_at desc limit 4;` shows both accounts, B's visit ended.
   - **(user)** On heyquilt.com, A's dashboard lists `live-check` with B's avatar and "Time collaborating this week" of about 3 minutes; the session page shows B with about 3 minutes together. B's dashboard shows the same session, owned by A, with A.
   - **(user)** A renames it on the website (the pencil); B's dashboard and A's app tab show the new name after a refresh.

## Self-review notes

Spec coverage, section by section:

- Recording presence on the relay (visit start on `enter`, end on leave, separate connections, queue file with batched fsync, 60 s sends, 500 per request, 2xx drops, backoff to 10 minutes, cap of 100,000 with a log, ending open visits on startup, owner-only `name` op with its rules, `name` event, on only with both settings and only for passes): Task 6 (queue) and Task 7 (relay), tested in `test/presence.test.js` and `test/relay-presence.test.js`.
- In the accounts API (`POST /v1/relay/presence`, constant-time relay auth, idempotent per event id, the three tables with RLS and no client policies, the owner rule, account deletion, daily 12-month cleanup): Task 2 (tables, memory store), Task 3 (Supabase), Task 4 (route), tested in `test/api-migration-activity.test.js`, `test/api-store-activity.test.js`, `test/api-supabase-activity.test.js`, `test/api-presence.test.js`.
- Reading it (totals, sessions with people, overlap rules, week start in `tz`, open visits, one session with visits and 404, owner-only rename that the relay never overwrites): Task 1 (maths) and Task 5 (routes), tested in `test/activity.test.js` and `test/api-sessions.test.js`. `GET /v1/me/collaborators` for the access-types spec: Task 5.
- Website (summary, "Your sessions" with rename, last active, total, five avatars and "+N", agent badge, empty state, the session page, times in the visitor's zone, no em dashes): Task 9.
- Desktop app (folder name on create once let in as owner, Rename for the owner through the API with the computer token and the relay): Task 8, with the API accepting `qd_` in Task 5.
- Security (secret on both Fly apps, constant time, never logged; only names and times; only your sessions and overlapping people): Tasks 4, 6, 10 and the Deploy section.
- Live check and deploy order: the Deploy section.
