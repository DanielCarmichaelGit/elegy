# 003: "Open in Claude Code" isn't offered when Claude Code is installed

**Status:** Open · **Reported:** 2026-09-28 · **Seen on:** Claude Code installed on the person's machine; "Open in <app>" button in the session header (`909bca3`)

## What happens
Someone with Claude Code installed opens a session, and neither the
"Open in <app>" button nor its menu offers Claude Code.

## What should happen
If Claude Code is installed in any form, "Open in Claude Code" is offered
(first, if it's the AI tool in their profile) and opens a Claude Code
session on the synced folder.

## What we know
- The list of apps comes from `installedEditors()` in `src/editors.js`,
  run by the local Quilt server (`src/ui-server.js`, `defaults.editors`).
  The UI only shows apps in that list.
- Claude Code is detected **only** by the Claude desktop app:
  `/Applications/Claude.app` or `~/Applications/Claude.app` on macOS, or
  `%LOCALAPPDATA%\AnthropicClaude\claude.exe` on Windows.
- The Claude Code **CLI** (`claude` on the PATH, from npm, the native
  installer in `~/.local/bin`, or Homebrew) is never checked.
- On Linux `locate()` always returns null, so no app is ever offered there.
- Opening uses `claude://code/new?folder=...`, which only the desktop app
  handles. A CLI-only install has nothing registered for that link.

## Likely causes, most likely first
1. **CLI-only install.** They use Claude Code in a terminal and don't have
   the Claude desktop app, so nothing is detected.
2. **Desktop app somewhere else**: a different install folder or app name
   (e.g. a Windows install outside `%LOCALAPPDATA%\AnthropicClaude`, or the
   app renamed/moved on macOS).
3. **Linux**, where detection isn't implemented.
4. **Using the website**, where the button runs on the server, not the
   person's computer, so it can't see what they have installed.

## Next steps
1. Ask the reporter: OS, and whether they have the Claude desktop app, the
   `claude` CLI, or both (`which claude`, `ls /Applications | grep -i claude`).
2. Detect the CLI too: look for `claude` on the PATH and in the usual install
   spots (`~/.local/bin/claude`, `~/.claude/local/claude`, npm global bin,
   Homebrew).
3. For a CLI-only install, open a terminal in the folder running `claude`
   (Terminal.app via `open -a Terminal` / `osascript` on macOS, `wt`/`cmd`
   on Windows, `x-terminal-emulator` on Linux), or at least offer
   "Copy command" with `cd <folder> && claude`.
4. Add Linux detection for the apps that ship there (CLI on PATH, Cursor,
   VS Code, Windsurf, Zed).
5. Tests in `test/editors.test.js` for CLI-only, desktop-only, both, and Linux.

## Log
- 2026-09-28: reported.
