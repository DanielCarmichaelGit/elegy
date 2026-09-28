# 001: Cursor messages still don't show up in the feed

**Status:** Needs info · **Reported:** 2026-09-28 (first seen 2026-09-27) · **Seen on:** partner using Cursor; person watching uses Claude Code

## What happens
The person using Claude Code sees few or none of their Cursor partner's AI
messages. The Cursor user sees all of the Claude Code user's messages.

## What should happen
Each Cursor prompt, reply and action appears in partners' feeds within a few
seconds.

## What we know
- Claude Code → Cursor works, so the relay, sessions and the feed UI work.
  The problem is on the Cursor user's machine: reading Cursor's chat history.
- cowove reads Cursor's history from its SQLite files
  (`~/Library/Application Support/Cursor/User/...` on macOS). This only works
  when cowove runs on the **same machine** as Cursor, via `cowove join` or
  `cowove ui` (the terminal/local app), **not** the website.
- Commit `4f60322` (2026-09-27) fixed two bugs that matched the first report
  (the reader stopped for good on "database is locked"; it missed most of
  each reply). That fix is only on branch `claude/cursor-deployment-chat-gul7ad`,
  **not on `main`**. A Cursor user who installed from `main` still has the old reader.
- On the website, Cursor messages only appear after **Connect your AI → Add to
  Cursor**, which needs the site deployed at a public `https://` address.
  It isn't deployed yet.
- None of this could be tested against a real Cursor install (none in the
  dev environment). The reader is tested against recreated Cursor databases.

## Likely causes, most likely first
1. **Running old code.** The partner's cowove doesn't include `4f60322`.
2. **Node.js older than 22.13.** The Cursor reader needs `node:sqlite`.
   Without it the feed reports "unavailable" and shares nothing from Cursor.
3. **Folder mismatch.** Cursor has the project open at a different path
   (parent folder, symlink, other drive or case) than the folder cowove syncs,
   so cowove finds no Cursor workspace for it.
4. **Cursor changed its storage layout** in a version we haven't seen
   (e.g. chat text moved out of `text`). The reader then sees messages but
   finds no text to share.
5. Using the website without "Connect your AI" (not possible to use yet).

## Next steps
1. On the Cursor machine, update to the branch with the fix:
   `git fetch && git checkout claude/cursor-deployment-chat-gul7ad && npm install`.
2. In the synced project folder, run:
   ```
   cowove doctor --watch 30
   ```
   and send a message in Cursor while it runs. It prints counts and lengths
   only, never chat text, so the output is safe to paste into this issue.
3. Read the report:
   - `✗ node:sqlite is missing` → install Node 22.13+ (cause 2).
   - `✗ Cursor has never opened this exact folder` → it lists the folders
     Cursor has opened; open the synced folder itself in Cursor (cause 3).
   - Conversations found, but messages show `0 chars` or `richText only` →
     layout change (cause 4). Paste the report here; the reader needs updating.
   - `✓ N entries would have been shared` but partners still don't see them →
     the problem is past the reader (session or relay); investigate there next.

## Log
- 2026-09-27: first report; fixed lock and polling bugs (`4f60322`).
- 2026-09-28: still seen. Added `cowove doctor` to diagnose on the Cursor machine.
