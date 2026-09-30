# 007: Nothing syncs: the relay crashes when a session holds a build folder

**Status:** Fixed (uncommitted at time of writing; deployed to cowove-relay 2026-09-30) · **Reported:** 2026-09-30 · **Seen on:** desktop app, hosted relay cowove-relay.fly.dev

## What happens

A partner joins, is let in, and nothing reaches them: no files, no chat, no
presence ([006](006-approved-member-not-shown-as-present.md) was this).

## Cause

- The session's stored doc on the relay was 99 MB, 95 MB of it `web/.next`
  (Next.js build output and turbopack cache).
- `web/.gitignore` lists `.next/`, but `loadIgnore` only read the
  `.gitignore` / `.quiltignore` in the session's top folder.
- The relay (512 MB machine) loads a room's whole doc into memory; 99 MB of
  Yjs update grew past 400 MB, so it was OOM-killed within a second of anyone
  connecting, restarted, and Fly stopped it after 10 restarts. Every session
  on the relay was down. Another room (`room-7bf561fe`, 102 MB) had the same problem.

## Fix

- `.gitignore` / `.quiltignore` files in subfolders now apply to their
  subfolder, like git (`scopeIgnore` in `src/pathrules.js`, `loadIgnore` in
  `src/fsutil.js`). Tests: `test/ignore.test.js`.
- Build caches (`.next`, `.turbo`, `.nuxt`, `.svelte-kit`, `.parcel-cache`,
  `.vercel`) are never synced.
- Relay: default session limit 256 MB → 32 MB; a stored room over twice the
  limit is refused (413, "over the size limit") instead of loaded; a single
  message can't exceed the limit. Test in `test/relay.test.js`.
- Both oversized rooms were deleted from the relay; start a new session.

## Log
- 2026-09-30: diagnosed from Fly logs (OOM loop), fixed, relay deployed, rooms deleted.
