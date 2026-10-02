# 010: The production relay has sign-in off, so 0.3.1 clients cannot start sessions and names are not checked

**Status:** **Fixed** (deploy, 2026-10-02 01:31 UTC) · **Reported:** 2026-10-01 (audit) · **Seen on:** relay.heyquilt.com (Fly app cowove-relay), app and CLI from main (0.3.1)

## What happens
- Starting a new session fails. The relay answers the WebSocket upgrade with
  `403 Relay key required to create rooms`. Rejoining existing sessions works.
- Nobody is signed in as far as the relay is concerned: it takes names from
  the `name` query parameter, ignores passes, and rate-limits new sessions per
  IP rather than per account. README and docs/hosting.md say the opposite.

## What should happen
The relay verifies every connection's 10-minute pass with the accounts API's
public key, names come from the pass, and any signed-in app can start a session.

## What we know
- `fly secrets list --app cowove-relay` → `COWOVE_RELAY_KEY`, `QUILT_STORAGE_KEY`.
  No `QUILT_PASS_PUBLIC_KEY`. The step in docs/hosting.md §2
  (`node scripts/relay-pass-key.mjs | fly secrets import --app cowove-relay`) was never run.
- Startup log 2026-10-01T18:07:07Z: `sign-in: off (set QUILT_PASS_PUBLIC_KEY to
  require it)` and `new sessions: need the relay key`. `/healthz` → `requiresKey: true`.
- Commit 8cdf412 removed every relay-key setting from the client
  (`src/settings.js` lists `relayKey` under RETIRED). `src/connection.js:51`
  only sends `relayKey` when one is passed in, and nothing passes one.
  `Room.authorize` (`src/server.js:152`) returns `need-key` for a new room when
  `cfg.relayKey` is set and the key does not match.
- Live probe: `wss://relay.heyquilt.com/audit-probe-…?secret=x&name=probe&key=AAAA`
  → HTTP 403. A Fly proxy log from 03:38 UTC shows an older client still
  sending `relayKey=…`, which is how sessions were started before 0.3.1.
- `scripts/relay-pass-key.mjs` run read-only against api.heyquilt.com returns a
  valid Ed25519 key line, so the API side is ready.

## Likely causes
The deploy checklist ended at `fly deploy`; the pass key import was skipped.

## Next steps
1. `node scripts/relay-pass-key.mjs | fly secrets import --app cowove-relay` (one restart).
2. Confirm `/healthz` reports `requiresKey: false`, that an unsigned client is refused with "Update Quilt and sign in to continue", and that a signed-in 0.3.1 app can start a session.
3. `fly secrets unset COWOVE_RELAY_KEY --app cowove-relay` (ignored once passes are on; it also leaked into a proxy log, see 011).
4. Add the pass key to `/healthz` output (e.g. `signIn: true`) and to a deploy check so this cannot silently regress.

## Log
- 2026-10-01: found by the audit.
- 2026-10-02: `QUILT_PASS_PUBLIC_KEY` imported and `COWOVE_RELAY_KEY` removed on cowove-relay, then deployed with 4637800. Startup log: "sign-in: a pass from the accounts API is required"; healthz `requiresKey: false`; a connection without a pass gets 401 instead of 403. Still to confirm from a signed-in app: starting a brand-new session.
