# Issues

Problems found while using elegy, one file per issue, worked through in order.
Each file says what's wrong, what we know, the likely causes, and what's
needed to close it. Keep the file after it's fixed and mark it **Fixed** with
the commit, so the history stays in one place.

| # | Issue | Status |
|---|---|---|
| [001](001-cursor-messages-missing.md) | Cursor messages still don't show up | Needs info from a Cursor machine (`elegy doctor --watch 30`) |
| [002](002-cloud-sessions-dont-share.md) | Cloud sessions (Claude Code / Cursor cloud) share nothing | Diagnosed; fix needs a public relay (deploy) |

## Adding an issue

Copy this into `NNN-short-name.md`:

```
# NNN: <what's wrong, in a sentence>

**Status:** Open · **Reported:** YYYY-MM-DD · **Seen on:** <tool, OS, how elegy was run>

## What happens
## What should happen
## What we know
## Likely causes
## Next steps
```

Statuses: **Open** (not looked at), **Investigating**, **Needs info**, **Blocked** (on something named), **Fixed** (commit), **Won't fix** (why).
