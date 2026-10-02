# 015: A disk error while saving a session stops the relay, and a half-written session file is deleted on the next start

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** relay from main (98eb68b)

## What happens
- `saveMeta()` (`src/server.js:487`, `writeFileSync`) runs synchronously from
  the `upgrade` handler, from message handlers and from the save timer. An
  `ENOSPC` or `EACCES` there is uncaught and the process exits (every session drops).
- The write is not atomic. A truncated `<room>.json` makes the `Room`
  constructor throw `SyntaxError` (`:98`, also uncaught, from `upgrade`), and
  on the next start the sweep (`:1061-1064`, `catch {}` then `removeRoomData`)
  deletes that session's `.json`, `.ydoc` and shared files for good.
- There is no relay-wide disk cap. The per-session file quota is 2048 MB on a
  3 GB Fly volume, so a full disk is reachable in normal use.

## What should happen
Save failures are logged and the session goes read-only. Metadata is written
tmp+rename like the ydoc. Unreadable metadata refuses the session, it does not
delete it.

## What we know
- Reproduced: data dir `chmod 500` then a connect to a new room → exit 1,
  `EACCES … writeFileSync`; a truncated `r3.json` then a connect → exit 1,
  `SyntaxError: Unterminated string in JSON`; after restart `r3.json`, `r3.ydoc`
  and `files/r3` are gone (`scratchpad/relay/crash.mjs`).

## Next steps
1. try/catch around `saveMeta`/`save`: log, set `room.full = true`, keep serving.
2. Write meta via tmp file + `renameSync`.
3. Sweep: skip and log files it cannot parse; never delete them.
4. Add a global free-space check (refuse new uploads below a high-water mark).

## Log
- 2026-10-01: found by the audit.
