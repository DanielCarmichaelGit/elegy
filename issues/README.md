# Issues

Problems found while using Quilt, one file per issue, worked through in order.
Each file says what's wrong, what we know, the likely causes, and what's
needed to close it. Keep the file after it's fixed and mark it **Fixed** with
the commit, so the history stays in one place.

| # | Issue | Status |
|---|---|---|
| [001](001-cursor-messages-missing.md) | Cursor messages still don't show up | Needs info from a Cursor machine (`quilt doctor --watch 30`) |
| [002](002-cloud-sessions-dont-share.md) | Cloud sessions (Claude Code / Cursor cloud) share nothing | Diagnosed; fix needs a public relay (deploy) |
| [003](003-claude-code-not-offered.md) | "Open in Claude Code" missing when Claude Code is installed | Open; detection only finds the desktop app |
| [004](004-open-in-cursor-wrong-folder.md) | "Open in Cursor" opens Cursor but not the session folder | **Fixed** (748a583): opens a classic Cursor window on the folder |
| [005](005-website-needs-signed-identities.md) | The website and relay-hosted AI tools can't join since identities became signed | Won't fix: browser version shelved; relay-hosted AI moves to 002 |
| [006](006-approved-member-not-shown-as-present.md) | Someone let into a session only shows in Access, not in the people bubble | Likely caused by 007; recheck in a fresh session |
| [007](007-relay-crashes-on-oversized-session.md) | Nothing syncs: the relay crashes when a session holds a build folder | **Fixed**: nested ignore files, relay size guard |

Feature ideas (not bugs) go in [unlocks.md](unlocks.md).

## Adding an issue

Copy this into `NNN-short-name.md`:

```
# NNN: <what's wrong, in a sentence>

**Status:** Open · **Reported:** YYYY-MM-DD · **Seen on:** <tool, OS, how quilt was run>

## What happens
## What should happen
## What we know
## Likely causes
## Next steps
```

Statuses: **Open** (not looked at), **Investigating**, **Needs info**, **Blocked** (on something named), **Fixed** (commit), **Won't fix** (why).
