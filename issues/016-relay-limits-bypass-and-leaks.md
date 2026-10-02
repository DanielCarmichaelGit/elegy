# 016: Relay limits can be bypassed and idle sessions pinned in memory (several related gaps)

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** relay from main (98eb68b); production has `QUILT_TRUST_PROXY=1`

## What happens
1. **Spoofable client address.** With `QUILT_TRUST_PROXY=1` the relay uses the
   *leftmost* `X-Forwarded-For` entry (`src/server.js:772-778`). Fly appends
   the real peer to a client-supplied header, so each connection can claim a
   different address and `QUILT_MAX_CONNS_PER_IP` and (with sign-in off, see
   010) `QUILT_MAX_NEW_ROOMS_PER_HOUR` do not apply. The API already knows
   this and uses `Fly-Client-IP` (`src/api/server.js:46`). Reproduced: six
   connections with `x-forwarded-for: 10.0.0.<i>, …` all joined under
   `maxConnsPerIp: 2`.
2. **Sessions pinned in memory.** `GET`/`POST /files/<room>/…` loads a room
   and never schedules the idle unload (the `/blobs` routes do); a GET for a
   room that does not exist even creates and persists it. A WebSocket that
   passes the upgrade but closes before answering the challenge clears the
   unload timer (`admit`, `:513`) and never re-arms it. Loaded rooms are never
   swept by the 30-day TTL, so memory and the room count grow for good.
3. **Guests stranded.** Pending connections live in `room.pending`, not
   `conns`, so when the owner leaves the room unloads under them. When the
   owner comes back, the new `Room` has an empty pending list: the owner
   cannot approve the guest, and the guest waits forever (approve reply:
   `nobody with that key is waiting`).
4. **File quotas by declared size.** With Supabase Storage,
   `meta.blobs[id].size` is whatever the client sends in the upload request
   (`src/blobstore.js:53-56`, `src/server.js:932-940`); the real object size
   is never read, and ids per room are unbounded, so `QUILT_MAX_ROOM_FILES_MB`
   does not bound Supabase usage. Chat-file uploads check the quota before any
   bytes land, so N concurrent uploads can exceed it by N × 100 MB
   (reproduced: quota 1000 bytes, 1800 on disk).
5. **Small ones.** Presence (awareness) state is only bounded by `maxPayload`
   (32 MB) and is kept and re-sent to every joiner (8 MB state → 29 MB heap);
   with sign-in off a name containing CR/LF is echoed into the raw HTTP status
   line of the "name taken" rejection (header injection); stored-file garbage
   collection only runs on idle unload, so a session that always has someone
   online never frees replaced large files; `src/relay-mcp.js` keeps claims in
   `doc.getMap('claims')` while everything else uses `room.meta.claims`, so
   claims made via `/mcp/<token>` are invisible to `quilt status`.

## What should happen
Limits apply to the real peer; every path that loads a room re-arms the
unload; pending guests keep the room loaded or are closed with a reconnect
code; quotas count real bytes including in-flight uploads; presence has a
small cap; client input never reaches a status line.

## Next steps
1. `clientIp`: prefer `fly-client-ip`, else the last `X-Forwarded-For` entry; update docs/hosting.md.
2. Call `room.onEmpty()` at the end of the `/files` handlers and in `admit`'s close handler when the socket was neither admitted nor pending; do not create rooms on GET.
3. Treat `room.pending.size` like `conns.size` in the unload timer.
4. After an upload completes, read the object's real size from Supabase (`bucket.list` metadata) and fix `meta.blobs[id].size`; keep a per-room reserved counter for in-flight chat uploads; cap ids per room.
5. Reject awareness updates over ~64 KB; reject names with control characters; run `collectStored` from the save timer; make relay-mcp use `room.claimRequest` or remove it.

## Log
- 2026-10-01: found by the audit; items 1-4 reproduced with scripts under the audit scratchpad (`xff-spoof.mjs`, `files-pin.mjs`, `pin-noauth.mjs`, `pending-unload2.mjs`, `upload-race2.mjs`, `awareness-size.mjs`, `crlf2.mjs`).
