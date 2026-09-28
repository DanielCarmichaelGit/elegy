# The elegy website

**Status: prototype built** (served by the relay at `/`). This plan is the
target experience and what's left.

## Decisions

- **Website first.** A desktop app may come later; it is not being built now.
- **No terminal, no install.** The browser syncs the folder itself, using the
  File System Access API.
- **No accounts, fully anonymous.** A session *is* its invite link. Whoever
  has the link can join and edit.
- **Chrome-family browsers only** (Chrome, Edge, Brave, Arc) for people who
  edit. Safari and Firefox can't give a website a folder.
- **The tab stays open** while you work. It's what syncs your folder. Closing
  it pauses syncing; reopening catches up and merges both sides.

## What a new user does

**Starting**
1. Open the website. Type your name, pick what you code with.
2. Click **Share a folder**, pick the project, click **Allow** when the browser asks.
3. A dialog shows the invite link. Copy it and send it.

**Joining**
1. Open the link. Type your name.
2. Click **Choose a folder for the project**, pick (or create) an empty folder,
   click **Allow**. The files appear and stay in sync.

Then everyone opens that folder in Claude Code, Cursor or anything else, as usual.

**Coming back**
The home page lists your sessions. Click **Open**; the browser may ask for
permission once more. Offline edits on both sides are merged.

## How it works

```
  Chrome tab (you)                     relay (server.js)             Chrome tab (friend)
  folder ⇄ WebSession  ── wss ──▶  one Y.Doc per room  ◀── wss ──  WebSession ⇄ folder
                                           ▲
                                      elegy join (CLI users, agents)
```

- `src/web/engine.js` (`WebSession`) is a port of the CLI's `Session`. It uses
  the **same document layout**, so browser users, `elegy join` users and
  agents can all be in one session.
- A web page can't watch the disk, so the engine **polls** the folder every
  second (size + modified time) and skips `node_modules`, `.git`, `.env` and
  anything in `.gitignore` / `.elegyignore`.
- All disk reads and writes go through one queue. If you and a partner change
  the same file within the same second, their version is kept and yours is
  saved to `.elegy/conflicts/` (the CLI does the same in its smaller window).
- The engine saves its state to `.elegy/state.bin` in the folder, like the
  CLI, so reopening the tab merges what changed while it was closed.
- Invite links are `https://<site>/#<code>`. The code (relay, room, room
  secret) sits after `#`, so it never reaches the server's logs. The CLI
  accepts these links too: `elegy join https://<site>/#<code>`.
- The relay serves the site (`/`, `/app.js`, `/app.css`); the old status page
  moved to `/status`. `npm run build` bundles the site with esbuild (the
  Docker image does this itself).

## Limits of the prototype

- **AI sharing from the browser goes through the AI itself.** A web page
  can't read `~/.claude` or Cursor's database, so browser users connect their
  AI instead (see "Connect your AI" below). The AI reports what it's doing
  with a tool call, which is less complete than reading the whole chat the
  way the CLI does: it depends on the AI following the instructions.
- Polling costs grow with folder size. Fine for normal projects; very large
  folders (tens of thousands of files) will feel slow.
- No file sending in chat from the browser yet (receiving shows the name).
- No claims UI yet (claims made by CLI users and agents are respected in the
  data but not shown).

## Connect your AI (built)

The session page has a **Connect your AI** card:

- **Add to Cursor**: a `cursor://anysphere.cursor-deeplink/mcp/install` link
  that installs a remote MCP server named "elegy". One click, no install.
- **Claude Code**: one command to paste once in any terminal
  (`claude mcp add --transport http --scope user elegy "<address>"`).
  Claude Code has no one-click install links.
- **Other tools**: the address, for any MCP client with Streamable HTTP.

How it works:

- The relay hosts the MCP server at `/mcp/<token>` (`src/relay-mcp.js`,
  stateless Streamable HTTP). Nothing runs on the person's computer.
- Each browser makes one private token (kept in localStorage). While a
  session is open, the tab tells the relay every 20 seconds which session and
  name the token means (`POST /agent/link`, which needs the room secret).
  So the AI is set up **once** and follows the person into every session.
- Tools: `elegy_share` (post the request, plan and result into the feed),
  `elegy_status`, `elegy_partner_feed`, `elegy_message`,
  `elegy_read_messages`, `elegy_list_files`, `elegy_claim`, `elegy_release`.
  The server's instructions and tool descriptions tell the AI to share when
  it starts and finishes each request.
- When the AI shares something, the person shows as "Cursor working" to
  everyone, and the card switches to "Cursor is connected".
- Before the person is in a session, every tool replies with how to join one.
- If their tab looks closed (no check-in for 3 minutes), tools warn the AI
  that files aren't syncing.

Not yet: the token is a bearer secret in the AI tool's config (anyone with it
can post as that person). Revoking means clearing site data to get a new one;
a "reset my AI link" button would be better.

## Anonymous hosting: what to watch

With no accounts, anyone can create rooms on the hosted relay. Keep it safe
with what the relay already has, tuned for public use:

- Run the relay **without** `ELEGY_RELAY_KEY` so the website can create rooms.
  (With a key set, the site shows a "server key" field when starting.)
- Room size quotas (`ELEGY_MAX_ROOM_MB`), per-IP connection limits,
  and room expiry (`ELEGY_ROOM_TTL_DAYS`) are already there.
- Add later: a per-IP room-creation rate limit, and abuse reporting.
- Whoever runs the relay can read room contents. End-to-end encryption (a key
  in the link's `#` part, never sent to the server) is the fix, and fits
  naturally with anonymous links.

## Next

1. **Fuller AI feeds for browser users** (optional): let people also pick
   their chat-history folder (`~/.claude/projects`) so the existing reader can
   run in the browser, instead of relying on the AI to report.
2. **Faster change detection** with `FileSystemObserver` where the browser
   supports it, keeping polling as the fallback.
3. Claims, file sending, and a read-only "watch" mode for Safari/Firefox.
4. Deploy: one Fly.io machine (see `docs/hosting.md`), a domain, HTTPS.
5. End-to-end encryption.
6. Summaries of partners' AI chats ([chat-summaries.md](chat-summaries.md)).
7. Later, maybe: a desktop app for other browsers and syncing without a tab.
