# 024: Desktop app: UX and shell defects found by the audit

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** app UI from main (0.3.1), live at 900x600, 1280x800, 1920x1080

All reproduced live unless marked.

1. **After leaving a session, Home shows no "Your sessions" until you navigate
   again** (`src/ui/app.js:103-104`): `refreshRecent()` is not awaited before
   `render()`, and nothing re-renders when it resolves. Use `refreshRecent().then(render)`.
2. **New-session dialog pre-fills the UI server's `process.cwd()`**
   (`src/ui/home.js:228`, `src/ui-server.js:343`). Run from the repo it shows
   the repo; the packaged app launched from Finder/Dock starts at `/`
   (Windows: `system32`), so one click on "Start session" would try to sync
   the whole disk. Not verified inside Electron, but the field provably mirrors
   the server cwd. Default to `~` or the last used folder; never the root.
3. **Windows has no way to install the `quilt` command** (`desktop/main.js:18-19,
   159, 176-183`): the menu item is macOS-only, the shim is a POSIX script,
   `installCli` symlinks into `/usr/local/bin` and runs `osascript`. README
   tells every platform to use the menu item. Write `quilt.cmd` on win32 and
   put the item under File, or document "macOS only".
4. **Sessions menu is not keyboard-closable and has no arrow navigation**
   (`src/ui/home.js:73-78`): Escape with focus on the trigger does nothing; the
   open menu then eats the click on Settings and opens the Join dialog instead.
5. **Mixed control heights** (`src/ui/app.css:66,67,74,270,460`): people
   button 38 px beside 30 px "Open in Claude Code"/"Invite"/"⋯"; "Copy edit
   link" 42 px beside "Copy view link" 38 px; 38 px Browse icon beside 40 px inputs.
6. **Initial import marks every file "Edited by you · 0s"** (`src/ui/tree.js:60-65`,
   `src/ui/fileview.js:22`): seconds after starting a session on an untouched
   folder every file carries an edit badge, which defeats the badge for two minutes.
7. **Product name casing and stale colours**: "quilt" in `src/ui/home.js:397`,
   `src/ui/session.js:681`, `src/ui/app.js:116,158`, `desktop/main.js:68,102,141`;
   Electron `backgroundColor: '#f4efe6'` (`desktop/main.js:104`) flashes the
   pre-rebrand beige before the `#fff8f3` page paints; `scripts/preview-app.mjs:12`
   uses `#f4efe6`/`#211d18` instead of the brand tokens.
8. **Join dialog shows two error messages for one bad link** (`src/ui/home.js:397,417`).
9. **A second computer on the same account is listed under Others as "(you)"**
   (`src/ui/session.js:45-50,535`): peers are matched by display name; the
   message-to-self button disappears and AI tabs for that peer open your own feed.
10. **`will-navigate`/`setWindowOpenHandler` use `url.startsWith(origin)`**
    (`desktop/main.js:113-122`): `http://127.0.0.1:<port>@evil.com/` passes.
    Compare `new URL(url).origin === origin`.
11. **Clicking the Dock icon in the ~100 ms before the UI server is up throws**
    (`desktop/main.js:220,133`: `showWindow` → `createWindow` → `new URL(ui.url)` with `ui` null).
12. **UI-server token compare is not constant-time** (`src/ui-server.js:431`). Local only; use `timingSafeEqual`.
13. **CLI parse errors print a stack trace** (`bin/quilt.js:489,167`): `quilt join --name x` dumps `ERR_PARSE_ARGS_UNKNOWN_OPTION` with a stack instead of usage.

## What is fine (checked)
Electron: `contextIsolation`, `sandbox`, no node integration, preload exposes
three functions, external links only via `shell.openExternal` for http(s),
`quilt://` parsing, single-instance, tray keeps syncing on close, quit stops
sessions. UI server: 127.0.0.1 only, Host-header guard, token on every API
route, no cookies, allow-listed static files, path checks on join dir and
`/file`, `account.json` 0600 atomic. All other peer strings escaped. No
horizontal overflow at any tested size; sidebar 264 px, page 920 px, workspace
columns 260/340, header 56 px, modals 560 px; Poppins and IBM Plex Mono load
from the bundled fonts; brand colours match brand/README.md; no console errors.

## Log
- 2026-10-01: found by the audit.
