# Session Activity on the Dashboard

Date: 2026-10-01. Builds on `2026-10-01-required-sign-in-design.md`: passes identify everyone on the relay by account (`kind:sub`).

## Goal

A signed-in person's dashboard on heyquilt.com shows the Quilt sessions they've been in, their time in each, and who they worked with (people and agents) and for how long.

## Decisions

| Topic | Decision |
|---|---|
| Source of truth | The relay reports presence (join and leave, by account from the pass) to the accounts API. Apps don't self-report. |
| What's shown | Essentials: each session's name, when it was last active, your total time, and who else was there with time together. A summary of time collaborating this week and your top collaborators this month. |
| Session names | The folder name by default, sent by the owner's app. The owner can rename it, and the rename shows for everyone. |
| Agents | Count as collaborators, shown with their agent badge. |
| Privacy | Only the session name and presence times. No paths, files or chat. You see only sessions you were in, and only people who were there at the same time as you. |
| Retention | Visits older than 12 months are deleted. Deleting an account deletes its visits and the sessions it owns. |
| Scope | The personal dashboard only. Org dashboards come later. |

## Recording presence

### On the relay

- When a connection with a valid pass is let into a room (`enter`, not pending), the relay records a **visit start** `{ room, account: 'kind:sub', name, at }`. When that connection leaves (close, removed, ended, pass lapsed), it records a **visit end** `{ room, account, at }`. Two connections from the same account in the same room are tracked separately; the API merges overlapping visits by the same account.
- Events go into an in-memory queue, persisted to `<dataDir>/presence-queue.jsonl`, appending and fsyncing in batches. Every **60 s** (and on shutdown) the relay sends the queued events to `POST <QUILT_API_URL>/v1/relay/presence` with `Authorization: Bearer <RELAY_API_SECRET>`, at most 500 events per request, in order. On a 2xx the sent events are dropped from the queue. On a failure they stay, and sending retries with backoff of up to 10 minutes. The queue is capped at **100,000** events; beyond that the oldest are dropped, with a log line.
- On startup, the relay sends a visit end at "now" for any visit it had started and not ended (they're tracked in the queue file), so a crash or deploy doesn't leave visits open.
- Session names: `meta.name` on the room. The owner's app sends it with a new admin request, `{ op: 'name', name }` (owner only, 1–80 characters, trimmed, no control characters). The relay saves it and includes `name` in a `{ type: 'name', room, name, at }` event.
- **Configuration.** Presence reporting runs only when both `QUILT_API_URL` and `RELAY_API_SECRET` are set on the relay, and only for connections with a pass. Without them, the relay behaves as today.

### In the accounts API

- `POST /v1/relay/presence` (relay auth: a constant-time comparison against `RELAY_API_SECRET`; otherwise 401) takes `{ events: [...] }`. It's idempotent per event: each event carries a relay-generated `id` (uuid), and duplicates are ignored.
- **Data model** (new migration):
  - `relay_sessions`: `room (pk)`, `name`, `owner_account`, `created_at`, `last_active_at`, `renamed_at`.
  - `session_visits`: `id`, `event_start_id (unique)`, `room → relay_sessions`, `account` (`'person:<uuid>'` or `'agent:<uuid>'`), `account_name`, `kind`, `started_at`, `ended_at (nullable)`.
  - `relay_events_seen`: `id (pk)` and `received_at`, for dedupe, pruned after 7 days.
  - RLS on, with no client policies: all access goes through the API.
- **The owner** is the first account recorded for a room whose `start` event says `owner: true`. The relay includes `owner: true` on a visit start from the room's owner.
- **Deleting an account** removes its visits, and the sessions it owns along with their visits.
- **Cleanup:** visits whose `ended_at` is older than 12 months are deleted daily, on the API's existing timer if there is one, otherwise on request.

### Reading it

- `GET /v1/me/sessions` (user auth, the website's Supabase JWT, as other `/v1/me` routes):
  - **Totals:** `collaboratingThisWeek` (ms) and `topCollaborators` (top 3 this month: account, name, kind, ms).
  - **Sessions:** `[ { room, name, owner: { name }, mine: boolean, lastActiveAt, myTotalMs, people: [ { account, name, kind, togetherMs, lastTogetherAt } ] } ]`, most recently active first, at most 100.
  - **Overlap rules:**
    - "Together" means the time your visits and theirs overlap in that room. Your own visits are merged first, then theirs, so two connections never double-count.
    - "Collaborating" this week is time in visits that overlap at least one other account (merged).
    - The week starts Monday 00:00 in the time zone the website passes as `tz` (an IANA name; default UTC).
    - Open visits count up to now.
- `GET /v1/me/sessions/:room`: the same detail for one session, plus `visits: [ { startedAt, endedAt } ]` (my last 20). 404 if I was never in it.
- `PUT /v1/me/sessions/:room { name }`: owner only (403 otherwise). It sets the name and `renamed_at`, and the relay is told nothing: the website and the API hold the name from then on. A later `name` event from the relay doesn't overwrite a rename (`renamed_at` set).

## Website

- **Dashboard overview (`/dashboard`):**
  - **Summary:** "Time collaborating this week" and "Worked with most this month" (three avatars with names and time).
  - **"Your sessions":** a list, most recent first. Each row shows the name, with a pencil (owner) that renames inline; when it was last active ("2 hours ago"); your total time; and up to 5 avatars of people and agents (agents with the badge), with "+N".
  - **Empty state:** "No sessions yet. Start one in the Quilt app and it shows up here."
- **Session page (`/dashboard/sessions/[room]`):**
  - the name (rename for the owner), "Owned by <name>", started, last active and your total time;
  - "People and agents": each with badge, time together and last together;
  - "Your recent visits": date, from and to.
- **Times:** like "3h 20m", or "under a minute", in the visitor's local time zone, sent to the API as `tz`.
- Existing site classes and tokens; no em dashes.

## Desktop app

- When the owner starts a session (create mode), the app sends `{ op: 'name', name: <folder basename> }` once it is let in as owner.
- The session menu gets **Rename** for the owner. It calls the API with the computer token: `PUT /v1/me/sessions/:room`, accepting the computer token (`qd_`) as well as the website JWT on this route. It also sends `{ op: 'name' }` to the relay so others in the app see it.

## Security

- `RELAY_API_SECRET` is a long random secret (Fly secret on both `quilt-api` and `cowove-relay`), compared in constant time. It's never logged.
- Presence events carry account ids and display names only. The room id is already a random identifier.
- People see only sessions they were in, and only people who overlapped with them.

## Testing

- **Relay:**
  - events are queued on enter and leave;
  - a pending person records nothing;
  - send batching, retry with backoff, and the queue file surviving a restart;
  - unfinished visits are ended on startup;
  - the owner-only `name` op, and its validation;
  - no reporting without the configuration.
- **API:**
  - relay auth;
  - duplicate events are ignored;
  - visits open and close;
  - the owner is recorded;
  - overlap maths: partial overlaps, the same account on two connections, open visits, week boundaries in a time zone;
  - only your sessions and overlapping people are returned;
  - owner-only rename;
  - a rename isn't overwritten by a relay name event;
  - the 12-month cleanup;
  - account deletion.
- **Website:** the dashboard and session pages render with data, the empty state, rename by the owner, and the time formatting.
- **Live check after deploy:** two accounts spend a few minutes in one session, and both dashboards show the session, each other and the time together.

## Deploy

1. Generate `RELAY_API_SECRET` once and set it on both Fly apps without showing it (one script pipes it to both `fly secrets import` calls).
2. Deploy the API (with the migration applied to Supabase `pwebomewzuezaxoowykk`), then the relay, then the website, then the desktop app (rename and naming).
