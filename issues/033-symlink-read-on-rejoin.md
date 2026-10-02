# 033: On rejoin, a shared path under a local symlinked folder is read through the symlink and a file outside the project is pushed into the room

**Status:** **Fixed** (83e39bf) · **Reported:** 2026-10-01 (audit) · **Seen on:** sync client from main, reproduced locally

## What happens
Bob's project contains `link -> /somewhere/outside`. A partner (or a modified
client) shares `link/private.txt`. Live, Bob logs "refusing to write outside
project" (`resolveInside` in `writeOut`), but the entry stays in the room.
When Bob stops and rejoins, `reconcileOffline` (`src/session.js:343-368`)
finds `link/private.txt` in `sharedPaths()` but not in `walk()` (walk skips
symlinks), calls `ingest`, and `readDisk` (`:414-429`, `path.join`, `lstat`
only on the final component) follows the symlinked parent, reads
`/somewhere/outside/private.txt` and publishes it to everyone. The same
read-through-symlink path is reachable from `reclaim` (a claimed glob
covering the path) and the `unlinkDir` handler.

## What should happen
README "Security": a path whose real location is outside the folder is
never read or written.

## What we know
Reproduced (`scratchpad/sync/t5-symlink-ingest.mjs`):
`after bob rejoin: shared link/private.txt = "bob-private-data\n" ; alice disk = "bob-private-data\n"`.

## Next steps
1. `readDisk`/`ingest` go through `resolveInside` (realpath of the parent compared with the real root) and skip when the parent is not a real directory inside the project.
2. `reconcileOffline`: leave alone (or delete from the doc) shared paths that `resolveInside` refuses, instead of ingesting them.
3. Test with a symlinked parent on rejoin.

## Log
- 2026-10-01: found by the audit.
- 2026-10-02: fixed in 83e39bf. `readDisk` resolves through `resolveInside` first and answers `{ skip, outside }` when a parent is a link leading out of the project (or dangling), so `ingest`, and with it `reconcileOffline`, `reclaim` and the `unlinkDir` handler, never read the outside file; the shared entry is left alone, live and on rejoin. `resolveInside` now walks each parent component with `lstat` instead of trusting the deepest existing ancestor. Test in test/sync.test.js covers the live write, the claimer's revert and the rejoin.
