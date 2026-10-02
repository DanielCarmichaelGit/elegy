# Issue tracking: record what goes wrong (and how long things take)

**Date:** 2026-10-01 · **Status:** Approved

Quilt has no record of what breaks for people. A 404 on heyquilt.com, an API
error, a button in the app that fails or hangs: none of it is kept anywhere.
This adds one pipeline that every surface reports into, stored in the accounts
Supabase project, so problems can be found and counted without anyone filing
them.

## Goals

- Every surface (desktop app, accounts API, website) records errors, 404s and
  crashes in one place.
- Actions in the app (e.g. the Open in Cursor button) record every outcome:
  ok, slow or error, with how long they took.
- Repeats of the same problem are grouped, with a count and first/last seen.
- Nothing personal beyond what the account already holds: no file contents,
  chat text, invite links, tokens or full file paths.
- Reporting never breaks or slows the thing it reports on.

## Non-goals

- A website page for browsing issues (the Supabase dashboard is enough for
  now; a page can come later and read the same tables).
- Session sync and relay telemetry. The relay has its own activity dashboard
  design; this covers the app shell, the API and the website.
- Recording every ok API request. The app polls the API every few seconds;
  only the API's failures and slow requests are kept.

## Data model

Migration `supabase/migrations/20261001000000_issues.sql` in the accounts
project. Both tables are the API's only: row-level security on, no grants to
`anon` or `authenticated`, `service_role` has all.

### `events`: one row per recorded outcome

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| surface | text | `app`, `api`, `web` |
| kind | text | `action` (something someone did), `error` (unhandled, nothing done), `http404`, `crash` |
| name | text ≤ 80 | what: `open-in`, `POST /v1/orgs/:id/members`, `/pricing/old` |
| outcome | text | `ok`, `slow`, `error` |
| status | int null | an HTTP status when there is one |
| duration_ms | int null | |
| message | text ≤ 500 | the error message, or empty |
| app_version | text ≤ 40 | the app's or site's version |
| platform | text ≤ 40 | `darwin`, `win32`, a browser's short UA family, or empty |
| user_id | uuid null | references `auth.users`, on delete set null |
| device_id | uuid null | references `devices`, on delete set null |
| context | jsonb | small, flat, scrubbed: `{ app: 'cursor' }`, `{ path: '/foo' }` |
| issue_id | uuid null | references `issues`, set for non-ok events |
| occurred_at | timestamptz | from the reporter, clamped to within a day of now |
| created_at | timestamptz | |

Indexes: `(occurred_at)`, `(issue_id)`, `(user_id)`, `(surface, name, occurred_at)`.

### `issues`: one row per distinct problem

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| fingerprint | text unique | sha256 of `surface|kind|name|normalized message` |
| surface, kind, name | text | as on events |
| message | text | the first message seen, un-normalized |
| count | int | occurrences |
| first_seen_at, last_seen_at | timestamptz | |
| resolved_at | timestamptz null | set by hand; a later event clears it |

Normalizing a message for the fingerprint: lower-case; replace uuids, hex
strings of 8+ characters, numbers, quoted strings, and anything that looks like
a path with placeholders; collapse whitespace; cut to 200 characters.

### `record_events(jsonb)` SQL function

Takes an array of events, inserts them, and for each non-ok event upserts its
issue (`on conflict (fingerprint) do update set count = count + 1, last_seen_at
= greatest(...), resolved_at = null`), returning the ids. One round trip per
batch, atomic. The memory store mirrors it in JavaScript and is the tested
reference, as with every other table.

### Retention

The API deletes events older than 30 days once an hour (`store.pruneEvents`).
Issues are kept.

## Accounts API

### `POST /v1/issues`

Body: `{ events: [ { kind, name, outcome, status, durationMs, message, context, occurredAt } ] }`,
1 to 20 events. `surface`, `appVersion` and `platform` come once at the top
level. The route cleans every field (`cleanName`-style: invisible characters
stripped, lengths cut), rejects unknown `kind`/`outcome`/`surface` with a 400,
and turns `context` into at most 2 KB of string/number/boolean values with ≤ 16
keys. A bad batch is a 400; it never crashes the API (issue 009's lesson).

Who may report:

- **A linked computer** (`Authorization: Bearer qd_…`): `surface` must be
  `app`; `user_id` and `device_id` come from the token.
- **The website** (`x-quilt-report-key: <QUILT_REPORT_KEY>`): `surface` must be
  `web`; `user_id` may be given in the body (the site knows who is signed in).
- **Nobody** (no token, no key): only `surface: app`, for errors before
  sign-in. Rate-limited to 10 batches a minute per IP (the existing limiter,
  Fly-Client-IP aware), `user_id` null.

Replies `{ ok: true, recorded: n }`. Nothing about issue ids leaves the API.

### The API reporting on itself

In the request handler in `src/api/server.js`: every request's duration is
measured. A 404 (no route), a 5xx, or any request over 2 s is recorded straight
through `store.recordEvents` (no HTTP), surface `api`, name = `METHOD
/path-with-ids-replaced` (uuids and tokens in the path become `:id` so names
group), kind `http404` for the 404, `action` otherwise. The 4xx a route throws
on purpose (401, 409, …) is not recorded: it's the API working. A deliberate
4xx that was slow is recorded with outcome `slow`, never `error`.

Recording is fire-and-forget (`.catch(log)`); a store failure never delays or
fails the request.

## Desktop app

### `src/report.js`: the reporter

```js
const reporter = createReporter({ token: () => readAccount()?.token, enabled: () => getSettings().report !== false, fetch, apiUrl, version, platform })
reporter.record({ kind, name, outcome, durationMs, status, message, context })
```

- Buffers events; sends a batch when 20 are waiting or 10 s after the first,
  whichever is first. At most 50 wait; older ones are dropped.
- Sends with the account token when signed in, otherwise with no auth.
- One try per batch; a failure drops the batch and backs off 60 s. The
  reporter never throws and never logs more than one line about itself.
- `flush()` for shutdown, bounded by a 2 s timeout.
- Scrubbing (`scrub(text)`, exported and tested): absolute paths (`/Users/…`,
  `/home/…`, `C:\…`, `~/…`) become their basename; anything matching Quilt's
  token prefixes (`qd_`, `qa_`, `qr_`, `dc_`) or an invite link is replaced
  with `[secret]`. Messages and every context value go through it.

### `src/ui-server.js`

- Every handler in the `api` table runs through `measured(name, fn)`: it
  records `{ kind: 'action', name, outcome, durationMs, status, message,
  context }` where `name` is the route key with the session id replaced
  (`POST /api/sessions/:id/open-in`) and `context` holds the few body fields
  worth keeping per route (`POST /api/sessions/:id/open-in`: `{ app }`;
  `POST /api/sessions`: `{ mode, tool, prefer }`; nothing else by default).
  Over 3 s is `slow`. A thrown error is `error` with its message; the error
  still reaches the UI exactly as today. An `ok` outcome is only kept for
  non-GET routes — a successful read (every `GET`) is not recorded, since the
  renderer polls and refreshes constantly; `slow` and `error` are kept for
  every route, GET included.
- Unknown routes record `http404`.
- `POST /api/report` (open before sign-in): the renderer's own errors, body
  `{ name, message, context }`, recorded as kind `error`.
- The UI server installs no process-level handlers. `desktop/main.js` reports
  `start` and `main` crashes through `ui.report` and `ui.flushReports()` before
  showing Electron's error box. A `quilt ui` run in plain Node keeps Node's
  default crash behaviour.
- `startUi` closes the reporter (flush) in `close()`.

### Settings

`report: false` in `~/.quilt/settings.json` turns reporting off. The Settings
screen gets a "Send problem reports to Quilt" toggle (on by default) with one
line saying what is sent. `GET /api/state` includes `profile.report`.

### Renderer (`src/ui/common.js`)

`window.addEventListener('error' | 'unhandledrejection')` posts to
`/api/report` with the message and the current view name. Duplicate messages
within 10 s are sent once. Failures to post are ignored.

### Electron (`desktop/main.js`)

The `whenReady().catch` and an `uncaughtException` handler report a `crash`
through the UI server's reporter when it exists, then show the error box as
today.

## Website

- `web/app/api/report/route.js`: `POST` only, body ≤ 4 KB, forwards to the
  API's `/v1/issues` with `QUILT_REPORT_KEY`, surface `web`, the signed-in
  user's id when there is one, `platform` from the UA family. 2 s timeout;
  always replies 204.
- `web/app/not-found.js`: a styled 404 page (same shell as the rest of the
  site) that renders a small client component which posts `{ kind: 'http404',
  name: location.pathname }` once. Query strings and fragments are never sent
  (invite links carry secrets in the fragment).
- `web/app/error.js`: the Next error boundary; posts `{ kind: 'error', name:
  pathname, message }` once and shows a short retry page.
- `web/lib/api.js` `apiCall`: reports calls that fail (no answer, a 404 or a
  5xx) or take over 3 s, through a shared `web/lib/report.js` (same forwarder
  the route uses), name `METHOD path-with-ids-replaced`. The report is
  fire-and-forget.

Netlify gets `QUILT_REPORT_KEY`; Fly's `quilt-api` gets the same value.

## Testing

- `test/api-issues.test.js`: the route over the memory store: auth cases (device
  token, report key, anonymous and its limit), field cleaning and limits,
  grouping (two batches, same message with different ids → one issue, count 2),
  `resolved_at` cleared by a new event, the API's self-recording of a 404, a
  thrown 500 and a slow request (fake `now`), and that a store failure doesn't
  fail the request.
- `test/api-store.test.js` additions and `test/api-supabase-store.test.js`
  additions with the stand-in client for `recordEvents` and `pruneEvents`.
- `test/report.test.js`: fingerprint normalization, `scrub`, batching and
  back-off with a fake fetch and fake timers, drop at 50, `flush` timeout.
- `test/ui-server-report.test.js` (or additions to an existing UI server
  test): a handler that throws records `error`; a slow handler records `slow`;
  an unknown route records `http404`; `report: false` records nothing.
- `web/test/report.test.js`: the forwarder strips query and fragment, sets the
  key header, and swallows failures.
- The Supabase migration is applied to the accounts project and checked with
  one real batch from a dev build before release.

## Rollout

1. Migration applied; `QUILT_REPORT_KEY` set on Fly and Netlify.
2. API deployed (from a clean clone), then the website.
3. RELEASES.md entry; the app release carries the toggle and the reporter.
