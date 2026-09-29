# Great unlocks

Feature ideas that would make Quilt much better. Not bugs (those get their own
numbered file in this folder). Add new ones at the bottom; move one to
**Shipped** with the commit when it's done.

Each entry: what it unlocks, for whom, and roughly what it takes.

```
## <short name>
**Status:** Idea · Planned · In progress · Shipped (commit) · Dropped (why)
**Unlocks:** <what people can do that they can't today>
**Rough shape:** <how we'd build it, a few lines>
```

Statuses: **Idea** (not scoped), **Planned**, **In progress**, **Shipped** (commit), **Dropped** (why).

---

## Cloud AI sessions join with nothing installed
**Status:** Idea
**Unlocks:** Claude Code on the web and Cursor cloud agents show up in a
session's feed like a local AI, with no install in the container. It also
makes Quilt testable solo: today any meaningful test needs two people. With
a cloud agent that can join and act on its own, one person can start a
session, invite an agent, and see real collaboration (edits syncing, feed
entries, messages back and forth) without finding a second human.
**Rough shape:** Point the cloud AI at the hosted MCP (`/mcp/<token>`) and add
an invite-based `quilt_join` tool so it doesn't need a browser tab open.
An "Invite a test agent" button that spins one up would make solo testing
one click. See [002](002-cloud-sessions-dont-share.md).

## Open in Claude Code from the terminal
**Status:** Idea
**Unlocks:** People who use Claude Code only as a CLI get a one-click way to
start it in the synced folder.
**Rough shape:** Detect `claude` on the PATH; open a terminal in the folder
running `claude`, or offer "Copy command". See [003](003-claude-code-not-offered.md).

## Talk to an AI natively from Quilt
**Status:** Idea
**Unlocks:** Send a prompt to your Claude Code (or other AI) straight from
the Quilt app, and see its reply there, instead of switching to its window.
Quilt becomes the place you drive your AI while collaborating.
**Rough shape:** For Claude Code, start or resume a session in the synced
folder through the Agent SDK / `claude -p --resume` and stream the reply into
the feed. Other tools where they expose a way in (Cursor's is unclear).
Falls back to "Open in <app>" when there's no way to drive it.

## Agents are members, like people
**Status:** Idea
**Unlocks:** An autonomous agent (say "Larry", a bot running on a cron) can be
told "set yourself up with Quilt and join the session", and from then on it
is a member like any person: it shows in presence, its work shows in the
feed, and it talks with the humans and with other people's AIs.
The coolest version of Quilt, even if not the most practical.
- **Thread (center pane):** Larry's conversations with other AIs show up
  there, the same as a person's AI activity does.
- **Chat (right sidebar):** Larry can post messages, like a person chatting.
- **Broadcast thoughts:** Larry can post into the thread the way a person's
  prompt to their AI appears, so everyone sees what it's thinking and doing.
**Rough shape:** Treat agents as entities with the same model as users:
a name, avatar, role (edit/view), and a token. Setup is one instruction the
agent can follow on its own (install, or hosted MCP + invite link). Mark them
as agents in the UI (badge), and let the session owner remove or mute them.
Builds on "Cloud AI sessions join with nothing installed".

## A plain REST API for agents and scripts
**Status:** Idea
**Unlocks:** Bots, scripts and agents that don't speak MCP can join sessions,
read and write files, chat and post to the feed with ordinary HTTP calls.
**Rough shape:** The agent API (on its own Fly machine) already does this work
for its MCP tools; expose the same functions as documented REST endpoints,
using the same agent keys from the dashboard.
