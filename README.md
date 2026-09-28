<p align="center"><img src="assets/logo.svg" width="96" alt="elegy logo"></p>

<h1 align="center">elegy</h1>

<p align="center">Real-time pair vibe coding that doesn't care which AI tool you use.</p>

You use Claude Code, your friend uses Cursor, someone else uses Codex or plain
vim. Everyone works in their own copy of the project, on their own machine,
anywhere in the world, and every change shows up on everyone else's disk
within milliseconds. Your agents can also see what the other agents are doing.

```
  you + Claude Code                                friend + Cursor
  ~/my-app  <-->  elegy join                elegy join  <-->  ~/my-app
                       \                        /
                        +--> elegy relay <-----+
                             (WebSocket)

  each agent  --MCP-->  elegy_status / elegy_claim / elegy_message
```

## How it works

- **Tool-agnostic by design.** Every AI coding tool eventually reads and writes
  files, so elegy syncs files and nothing else. It watches your project folder and
  mirrors changes into a shared [Yjs](https://yjs.dev) CRDT document. Remote
  changes are written back to disk. Your editor or agent just sees files change.
- **Real merges, not overwrites.** Text files are synced character by character.
  If your agent edits the top of `app.ts` while theirs edits the bottom, both
  edits land. Binary files (images, etc.) sync as whole files.
- **Works apart.** A small relay server connects everyone over WebSockets
  (host it anywhere, or tunnel it from your laptop). If your connection drops,
  keep working: elegy keeps a local copy of the shared state and merges your
  offline edits when you reconnect.
- **Watch each other's AI, live.** The app shows your partner's AI conversation
  as it happens: their prompts, the AI's replies, and one-line actions like
  "Edited src/app.ts" or "Ran npm test". This works for Claude Code and Cursor.
  Next to it are a live file tree (who's editing what, what's claimed) and
  read-only file tabs where changed lines light up.
- **Agents coordinate, and can join by themselves.** An MCP server gives each
  agent tools to see who's online, read a partner's AI feed, see where people
  are working, *claim* files and message each other. With an invite code, an
  agent can even join (or start) a session on its own. Tools without MCP can
  use the `elegy` CLI or read `.elegy/STATUS.md`.

## Quick start

Requires Node.js 20+.

```bash
git clone <this repo> && cd elegy && npm install && npm link   # puts `elegy` on your PATH
```

### The easy way: the app

```bash
elegy ui
```

This opens elegy in your browser, where you can:

- **Start a session:** pick your project folder, then either host the relay on
  your computer with one click or point at a hosted relay. You get an invite code to send.
- **Join a session:** paste an invite code and pick where the project should go.
- **Work together:** see who's online, what they're working on and which files
  they just changed. Chat, send direct messages, and drag and drop files to share
  them. You can also claim files, and rejoin recent sessions later.

The app only listens on `127.0.0.1` and needs the secret link `elegy ui` prints.

### The terminal way

**1. Run a relay** that both of you can reach (see [Hosting the relay](#hosting-the-relay)):

```bash
elegy serve                      # listens on :4321
```

**2. Start a session** in your project folder:

```bash
cd ~/code/my-app
elegy join --server wss://your-relay.example.com --name you --tool claude
```

It prints an invite code. Send it to your friend.

**3. Your friend joins** from an empty folder (or their own clone of the same repo):

```bash
mkdir my-app && cd my-app
elegy join <invite-code> --name friend --tool cursor
```

Keep `elegy join` running in a terminal while you work. It logs who joined,
what they're touching, claims, and messages.

**4. Connect your AI tools** (once per project, by either of you; it syncs):

```bash
elegy setup
```

This registers the `elegy` MCP server in `.mcp.json` (Claude Code) and
`.cursor/mcp.json` (Cursor), and adds pairing etiquette to `CLAUDE.md` and
`AGENTS.md` ("check what your partner is doing before you start; don't edit
claimed files; re-read files before editing"). Restart or reload your tool to
pick up the MCP server.

## Commands

| Command | What it does |
|---|---|
| `elegy ui` | Open the app (start, join, chat, files) |
| `elegy serve [--port 4321] [--data ./elegy-data]` | Run a relay |
| `elegy join --server <url>` | Start a new session for this folder |
| `elegy join <invite>` | Join a session |
| `elegy join` | Rejoin this folder's last session (merges offline edits) |
| `elegy invite` | Print the invite code again |
| `elegy status` | Who's online, focus, recent edits, claims, messages |
| `elegy focus "adding auth"` | Tell others what you're working on |
| `elegy claim 'src/auth/**' "rewriting login"` | Lock files/folders/globs so only you can change them |
| `elegy release <pattern>` / `elegy release` | Release one claim / all of yours |
| `elegy chat` | Interactive chat in your terminal (live messages, DMs, files) |
| `elegy say "pushing a schema change"` / `elegy say @bob "got a sec?"` | Message everyone / one person |
| `elegy send design.png @bob "new mockup"` | Send a file (to everyone, or one person) |
| `elegy messages` / `elegy messages --all` / `--with bob` | Unread messages / history / one conversation |
| `elegy get <message-id> [dest]` | Download a shared file again |
| `elegy setup` | Wire up MCP + agent instructions |
| `elegy mcp` | The MCP server itself (your AI tool launches this) |

### MCP tools for agents

| Tool | Purpose |
|---|---|
| `elegy_join_session` | Join a session from an invite code, as an agent (no human needed) |
| `elegy_start_session` | Start a new session for a folder and get an invite code |
| `elegy_leave_session` / `elegy_session_info` | Leave; or see the folder, your name, who's online, and the invite |
| `elegy_status` | Collaborators, their focus, recently edited files, claims, messages |
| `elegy_partner_feed` | Read what a collaborator's AI is doing (prompts, replies, actions) |
| `elegy_list_files` | Shared files with recent editors and claims |
| `elegy_set_focus` | Announce the current task |
| `elegy_claim` / `elegy_release` | Claim or release files before and after larger changes |
| `elegy_message` | Message everyone, or one person with `to` |
| `elegy_read_messages` | Read unread (or recent) messages, including received files |
| `elegy_send_file` | Send a project file through chat (secrets and paths outside the project are refused) |
| `elegy_get_file` | Download a shared file (again) |

Any MCP-capable tool works: Claude Code, Cursor, Windsurf, Codex, Zed, and so on.
Point its MCP config at the command `elegy` with args `["mcp"]`.

## Watching each other's AI

In a session, the app's main area has two modes:

- **AI:** one tab per person, showing their AI conversation live. You see
  prompts and replies in full, plus one-line actions ("Edited src/app.ts",
  "Ran npm test"). Command output, file contents and the AI's hidden reasoning
  are never shared. Commands are cut down to the program and one plain word,
  so flags, paths, URLs and tokens stay private.
- **Files:** read-only tabs for shared files, with who edited each one and
  whether it's claimed. Lines light up as your partner's AI changes them.

The file tree on the left shows orange badges on files edited in the last two
minutes and purple badges on claims. Use a file's or folder's ⋯ menu to claim
or release it.

Claims are enforced in code, not just by asking agents nicely:

- **Your side:** if you change a file someone else has claimed (including
  creating or deleting files in a claimed folder), elegy puts the shared version
  back on your disk, never sends the change, and keeps your version in
  `.elegy/rejected/`.
- **Their side:** if a change to your claimed files still arrives (say, from a
  partner running an older elegy), your elegy reverts it in the shared session
  and keeps their version in your `.elegy/rejected/`.
- **The relay:** claims live on the relay, not in the shared files. It checks
  who is asking (see [Security](#security)), refuses a claim that overlaps
  someone else's, and only lets the person who made a claim release it. So a
  claim can't be faked, stolen or released by anyone else. Claiming needs a
  connection to the relay; claims you already know about stay enforced offline.
- A folder can be claimed before it exists; anything created in it later is
  covered. If two glob claims start overlapping because a new file matches
  both, everyone treats the earliest claim as the owner.

Sharing is on when you join. Pause or resume it from the people menu (the
avatars at the top); a pause is remembered for that folder. elegy reads Claude
Code transcripts from `~/.claude/projects` and Cursor's local chat database
(read-only, needs Node.js 22.13+). Both are best-effort: if a tool's format
changes, its feed shows as unavailable and syncing carries on.

## Agents as participants

An AI agent can be a full member of a session, with no human running elegy for
it. Give the agent an invite code and it calls `elegy_join_session`. The project
syncs into its folder, and everyone sees it in the session with an agent badge.
It can then read partners' AI feeds, claim files, chat, and edit files that
sync to everyone. It can also start a session with `elegy_start_session` and
hand out the invite. The session lasts as long as the agent's MCP server runs.

Agents that prefer the shell can run `elegy join <invite> --agent` instead.

## Messaging and file sharing

Chat lives alongside the code. Messages go to everyone by default, or to one
person with `@name`. Messages are kept in the room, so anyone offline sees
them when they reconnect, and `elegy status` shows your unread count.

Files you **send** (screenshots, logs, exports, a PDF spec) go through the relay
as attachments. They are *not* added to the shared project folder. Recipients
get them automatically in `.elegy/inbox/`, including files sent while they
were offline. The limit is 100 MB per file.

Direct messages and files are only shown to the sender and recipient, but they
travel through the shared room, so they're private from other collaborators'
screens, not from the relay operator.

## Hosting the relay

The relay is one small Node process. It needs to be reachable by both of you.

- **Quickest, from your laptop:** `elegy serve`, then in another terminal
  `cloudflared tunnel --url http://localhost:4321`. Use the printed
  `https://….trycloudflare.com` URL as `wss://….trycloudflare.com`.
  (ngrok or Tailscale work too; with Tailscale use `ws://<tailscale-ip>:4321`.)
- **Always-on:** deploy the included `Dockerfile` to Fly.io, Render, Railway,
  or any VPS. Mount a volume at `/data` so rooms survive restarts, and put it
  behind TLS so you can use `wss://`.

## What syncs (and what doesn't)

- Everything in the folder **except**: `.git/`, `node_modules/`, `.elegy/`,
  `.env` / `.env.*` (secrets stay local), editor swap files, anything in your
  `.gitignore`, and anything in an optional `.elegyignore` (same syntax).
- Text files up to 2 MB and binary files up to 8 MB.
- Symlinks are not synced.
- On first join, if a file differs between your folder and the session, the
  session's version wins and yours is copied to `.elegy/conflicts/<time>/`.
  Use `--prefer local` to push your versions instead.

**Git:** the working tree is shared, but `.git` isn't. The simplest workflow
is that one person commits and pushes. Avoid `git checkout`, `reset`, `stash`
and `rebase` during a session unless you've agreed on it: they rewrite files,
and the changes sync to everyone.

## Security

- Each room has a secret (inside the invite code). The first client to open a
  room sets it, and everyone else must match. Treat invite codes like passwords.
- Each person has a signing key in `~/.elegy/identity.json`, made on first use.
  The first time a name joins a room, the relay ties that name to the key. After
  that, only that key can use the name: the relay checks a signature on every
  connect, and drops presence updates that use anyone else's name. Copy the file
  to use your name from another computer. If you lose it, the relay's host can
  free the name by removing it from `identities` in the room's `.json` file in
  the relay's data folder.
- Paths from peers are validated. Nothing can be written outside the project
  folder, into `.git/` (no sneaky hooks), or into files you ignore locally.
- The relay can read project contents. Host your own relay and use `wss://`.
  End-to-end encryption is a natural next step.
- Remember that you're syncing code your partner's agent wrote, and your tools
  may run it. Only pair with people you trust.

## Development

```bash
npm test     # end-to-end tests: real relay, two clients, temp folders
```

Layout: `src/ui/` + `src/ui-server.js` (the app), `src/runner.js` (start/stop a session), `src/server.js` (relay), `src/connection.js` (client protocol +
reconnect), `src/session.js` (folder ⇄ CRDT sync, presence, claims, chat),
`src/control.js` (local API for CLI/MCP), `src/mcp.js`, `src/setup.js`,
`bin/elegy.js` (CLI).
