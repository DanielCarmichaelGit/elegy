# 032: One file that cannot be written drops the rest of a remote update, and the stale local copy is then pushed back over the partner's edit

**Status:** **Fixed** (26262b4) · **Reported:** 2026-10-01 (audit) · **Seen on:** sync client from main, reproduced locally

## What happens
`observeDeep` (`src/session.js:246-255`) writes each changed path with no
per-path try/catch. Bob has `locked.txt` chmod 444. Alice changes `a.txt`,
`locked.txt`, `b.txt`, `c.txt` in one update. Bob's loop throws `EACCES` at
`locked.txt`; Yjs rethrows after the transaction, the socket handler logs it
at debug level, and `b.txt`/`c.txt` are never written and never get
`lastKnown`. Nothing retries them. The chmod changed ctime, so `scanDisk`
queues `locked.txt`, `ingest` reads the old content and pushes it: Alice's
edit is reverted everywhere, with only a "bob just changed locked.txt"
notice. `b.txt`/`c.txt` get the same re-push at Bob's next restart via
`reconcileOffline`. Other triggers: a local file where the room has a folder
(EEXIST), a dangling symlink parent, a path component over 255 bytes
(`isSafeRelPath` only caps the whole path at 1024), Windows reserved names
(`aux.txt`, `nul`) and names ending in `.` or space on a Windows member.

Related first-join failures: a local folder with the name of a shared file
→ `start()` throws `ENOTSUP … copyfile`; a local file with the name of a
shared folder → `EEXIST … mkdir`. The person cannot join and sees a raw
Node error (`src/session.js:385-393`, `:637-640`).

## What should happen
One unwritable file never blocks the others; a file the client could not
write is never treated as a local edit; name collisions on first join go to
`.quilt/conflicts/` like content conflicts do.

## What we know
Reproduced: `scratchpad/sync/t2b-readonly-revert.mjs`
(`alice after bob reacted: locked.txt = "v1\n"`), `t3-firstjoin-dir.mjs`.

## Next steps
1. try/catch per `fromRemote(p)`; log normally; record the path in a `writeFailed` map that `retryFailed` re-attempts; `ingest` skips paths in `writeFailed`; on EACCES `chmod u+w` or move aside before writing.
2. In `reconcileOffline`, only ingest a path whose disk content differs from both the shared content and a persisted `lastKnown` hash.
3. `reconcileFirstJoin`: when `disk.skip`, rename the directory/symlink into the backup folder and proceed; `writeOut`: move aside a file that sits where a folder must go.
4. `isSafeRelPath`: reject Windows device names, trailing `.`/space, components over 255 bytes.

## Log
- 2026-10-01: found by the audit.
- 2026-10-02: fixed in 26262b4. Remote updates are applied path by path (`applyRemote`): a failed write is logged, kept in `writeFailed`, retried on reconnect and every retry tick, and `ingest` skips it, so a stale copy is never pushed back; a read-only file is made writable or moved into `.quilt/conflicts`. `state.json` keeps a sha1 of `lastKnown` per path, and `reconcileOffline` writes (rather than pushes or deletes) a path whose disk content is still what we last wrote, or that was never written. First join moves a colliding folder or file into `.quilt/conflicts/<time>/`. `isSafeRelPath` rejects Windows device names, trailing dots and spaces, and names over 255 bytes. Six tests in test/sync.test.js; the audit script now ends with every file at `v2` on both sides.
