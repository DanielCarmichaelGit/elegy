# 035: Sync edge cases that lose or corrupt data

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** sync client from main

1. **Case-only path collisions corrupt both files on macOS/Windows and the
   corruption syncs back to everyone** (`src/session.js:609-655`, `:449-528`).
   The room holds `Readme.md` and `readme.md` (a Linux member, or two people
   creating it differently). Both `writeOut`s hit one inode; the watcher
   reports the change under one name; `ingest` diffs the other entry's content
   into it; both shared entries end up merged garbage
   (`t11-case.mjs`: `"lowerlower\n"` on every member including the Linux one).
   Keep a lower-cased index of shared paths and refuse the second mapping.
2. **A delete that races an edit discards the edit with no conflict copy**
   (`src/session.js:624-630`). Alice saves a paragraph; Bob deletes the file
   before seeing it. Alice's `writeOut` sees `shared === undefined` with
   `disk.key === lastKnown` and removes the file; no `.quilt/conflicts/` copy
   (`t13-delete-race.mjs`). Before `rmSync`, if `myEdits.get(rel)` is within
   `RECENT_MS`, `keepConflict` first and say where it went.
3. **`quilt_commit` can commit `.quilt/`** (room secret in `config.json`,
   `state.bin`, `claims.json`, inbox) when the folder became a git repo after
   the session started: `ensureGitExclude` runs once at start and returns
   early without `.git` (`src/runner.js:153-163`); `commit` uses `git add -A`
   (`src/git.js:244`). Call `ensureGitExclude` inside `commit()`/`status()`
   and add `':(exclude).quilt'`. Trace only.
4. **The 1 s full-tree re-scan costs ~75-95 ms per 20 000 files, forever**
   (`RECONCILE_MS = 1000`, `scanDisk` lstat's every file). On a 100k-file
   monorepo this burns a large share of a core on every member's machine
   (`t6-scan-cost.mjs`). Back off to 5-10 s or only scan for a few seconds
   after a watch is added, and skip it off macOS.
5. **`quilt_send_file` refuses `.env` by the given name, not the real file**
   (`src/mcp.js:387-400`): a symlink to `.env` passes; `.quilt/config.json`,
   `.npmrc`, `.netrc` are sendable. Test the realpath's basename, refuse
   symlinks and `.quilt/**`. Trace only.
6. **`quilt setup` replaces an unparsable `.mcp.json` / `.cursor/mcp.json`
   with just the quilt entry** (`src/setup.js:42-54`): a trailing comma loses
   every other MCP server. Stop with a message instead. Trace only.
7. **One malformed JSON row in Cursor's database switches the Cursor feed
   off until restart** (`src/agents/cursor.js:157-173`). Skip the row; only
   fail when the tables are missing. Trace only.

## What is fine (checked)
Path validation refuses `..`, absolute, drive letters, backslashes, NUL,
`.git`/`.quilt` (case-insensitive); live remote writes through symlinks are
refused; binary/text detection and the 2 MB / 8 MB / 256 KB / 100 MB limits;
UTF-16 diffing; offline merge idempotence; claim enforcement including
rename-around-a-claim and offline claims; atomic-save temp files and bursts;
nested `.gitignore`/`.quiltignore` semantics; DM visibility; the Claude Code
reader never shares thinking, tool results, command arguments, paths or
URLs, and a counts-only scan of the real transcripts on this machine found no
leaked system text; the Cursor readers are read-only; MCP `quilt_get_file`
keeps `dest` inside the project; every async path has a rejection handler;
the watcher never descends into `node_modules`, `.git` or build caches.

## Log
- 2026-10-01: found by the audit.
