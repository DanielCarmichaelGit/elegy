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

## Quick let-in and auto let-in
**Status:** Idea
**Unlocks:** Owners stop babysitting the approval prompt. They can let
someone in with one click from a notification, or set a session to let
people in automatically, for example anyone signed in with the same email
domain (everyone at `@acme.com`). Teams can share one invite link and just
start working together.
**Rough shape:** Sign-in is required, so every join comes from an account
with a verified email. Add the email (or just its domain) to the session
pass, then add a per-session "Let in automatically" setting:
off (today), same email domain as the owner, or anyone with the link. The
relay checks the pass's email against the rule and skips the approval step
when it matches. Skip public domains like gmail.com for the domain rule.
Quick let-in is an actionable notification ("Sam wants to join. Let in").

## Quitting the app never ends a live session
**Status:** Idea
**Unlocks:** You can quit Quilt (or shut your laptop) while your partners
keep working. The session stays up on the relay with its files on disk, and
when you come back you rejoin where it is now. Nothing anyone else is doing
stops because one person left.
**Rough shape:** Today quitting stops every local run (`desktop/main.js`
`before-quit` → `ui.close()` → `stop(id)` → `run.stop()`), which only
leaves the room; make sure that path never calls `endForEveryone`, and
say so in the UI ("You left. The session keeps running for the others").
On the relay, a room is alive while any member is connected: keep the
Fly machine running with the session files on its disk while that is true.
When the **last** member leaves, empty the room's files from the machine so
it can be reused, and if no room on the machine has anyone in it, stop the
machine (`fly.toml` has `auto_stop_machines = "off"` and
`min_machines_running = 1` today, so this is a relay-driven stop, not
Fly's idle timer). Owner-initiated "End for everyone" stays the only thing
that ends a session for others.

## View-only guests don't get a local folder
**Status:** Idea
**Unlocks:** Someone invited to view can follow the session without the
project ever being written to their computer. Only edit (and above) gets a
synced directory. That keeps read-only truly read-only: nothing to copy,
nothing left behind when they're removed.
**Rough shape:** Viewers read through the relay instead of syncing. The
relay already holds every room's full file tree, and the hosted MCP already
serves file reads from that copy to cloud agents with no folder; a viewer
is the same case with a human UI. The app connects like any member, keeps
room state in memory instead of writing it, and renders a file tree, a
read-only file viewer, the feed and chat in place. It skips the "choose a
folder" step and never starts the sync client. Viewers lose "Open in
Cursor" and running the code, which is what viewing means; promotion to
edit is the moment to ask for a folder. An editor demoted to view keeps
their folder but syncing to it stops, and the app says so. See role
handling in `src/session.js` (`access.role === 'viewer'`).

**Security:** three attackers, two of them beatable.
- *The viewer themself:* anything the app can show, the viewer can take
  (screenshot, camera, or patching the Electron renderer to dump room
  state). Encrypting content "whenever it's not on screen" doesn't change
  that, because the viewer owns the machine doing the decrypting. Don't
  promise "viewers can't leak"; make leaking slow, artifact-free and
  attributable:
  - Nothing on disk, ever: room state in memory only, renderer disk cache
    off for file content, nothing in localStorage or logs.
  - Watermark the view: the viewer's name and email faintly tiled over
    rendered content, so screenshots carry it.
  - Audit per file: the relay records which files each viewer opened; the
    owner can see the list.
  - No bulk path: viewers fetch one file on demand, throttled. No
    download-all or export, so dumping a tree is slow and shows in the log.
  - Scopes for viewers: owners limit a viewer to a folder or two, as edit
    scopes already do.
  - Soft blocks: no text selection, copy or context menu for viewers.
    Easy to bypass; stops the casual case.
- *A removed member or an old link:* rotate the room key on removal so a
  kept secret opens nothing new; view tokens short-lived and tied to a
  signed-in account.
- *The relay, Fly, or a breach of either:* end-to-end encryption, as large
  files already do (per-file keys wrapped under a key from the room
  secret, relay holds ciphertext). Extending it to the text tree makes the
  relay a dumb store with clients doing the merging, and the hosted MCP
  and agents would hold a key like any client. A separate, larger project.

## Toasts stay while hovered, and can be copied
**Status:** Idea
**Unlocks:** A toast with something you need (an error, a path, an invite
link) doesn't vanish while you're reading it, and one click copies its text.
**Rough shape:** `src/ui/common.js` `toast()` hides after a fixed 2.4 s.
Pause that timer on `mouseenter` and restart it on `mouseleave`. Add a small
copy button inside `#toast` that writes the message text to the clipboard
(and briefly confirms "Copied").
