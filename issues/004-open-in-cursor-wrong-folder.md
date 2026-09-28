# 004: "Open in Cursor" opens Cursor but not the session's folder

**Status:** Fixed (748a583) · **Reported:** 2026-09-28 · **Seen on:** Cursor; "Open in Cursor" button in the session header (`909bca3`)

## What happens
Clicking "Open in Cursor" brings Cursor up, but Cursor doesn't open the
session's synced folder. It stays on whatever window or folder it had, so the
AI isn't working where the files sync and its chats don't reach the feed.

## What should happen
Cursor opens (or focuses) a window on the session's synced folder.

## What we know
- The button calls `POST /api/sessions/:id/open-in` (`src/ui-server.js`),
  which runs `openIn('cursor', session.root)` in `src/editors.js`.
- On macOS that runs `open -a /Applications/Cursor.app <folder>`. On Windows
  it runs `Cursor.exe <folder>`. Cursor gets no URL, only the folder.
- Cursor did launch, so detection and the command ran. The folder hand-off
  is what failed.
- Not reproduced yet; we don't know the OS or whether Cursor was already open.

## Likely causes, most likely first
1. **Cursor was already running.** With `open -a`, a running VS Code-based app
   is handed the folder through a macOS "open document" event, which it can
   ignore or route to the existing window instead of opening the folder.
   The reliable path is Cursor's own CLI (`cursor <folder>`, or
   `Cursor.app/Contents/Resources/app/bin/cursor`), which tells the running
   instance to open a window on it.
2. **Wrong or missing folder.** `session.root` isn't the path we expect
   (relative, not created yet, or a symlink), so Cursor gets a path it
   can't open and silently does nothing.
3. **Cursor restores its last window instead.** On a cold start Cursor
   reopens its previous workspace and may drop the folder argument.
4. **Windows:** launching `Cursor.exe <folder>` directly can start a new
   process that hands off to the running one and loses the argument.

## Next steps
1. Ask the reporter: OS, whether Cursor was already open, and what window
   it showed afterwards.
2. Reproduce on macOS with Cursor open and closed; log the exact command
   and `session.root` from `openIn`.
3. Switch VS Code-based apps (Cursor, Windsurf, VS Code) to their CLI:
   `<App>.app/Contents/Resources/app/bin/<cli> --new-window <folder>` on macOS,
   `<install>\bin\<cli>.cmd` on Windows; fall back to `open -a` if missing.
4. Check that `session.root` is absolute and exists before opening, and show
   an error if not.
5. Add cases to `test/editors.test.js` for the CLI command per platform.

## Log
- 2026-09-28: reported.

## Fix

Cursor 3 opens folders into its "Cursor Agents" window, whose chats stay on
the last project used. The button now runs Cursor's own launcher with
`--classic --new-window <folder>`, which opens a normal window on the folder
with the agent chat docked beside it (748a583).
