<p align="center"><img src="assets/logo.svg" width="96" alt="cowove logo"></p>

<h1 align="center">cowove</h1>

<p align="center">Real-time pair vibe coding that doesn't care which AI tool you use.</p>

You use Claude Code, your friend uses Cursor, someone else uses Codex or plain
vim. Everyone works in their own copy of the project, on their own machine,
anywhere in the world, and every change shows up on everyone else's disk
within milliseconds. Your agents can also see what the other agents are doing.

```
  you + Claude Code                                friend + Cursor
  ~/my-app  <-->  cowove join                cowove join  <-->  ~/my-app
                       \                        /
                        +--> cowove relay <-----+
                             (WebSocket)

  each agent  --MCP-->  cowove_status / cowove_claim / cowove_message
```

## How it works

- **Tool-agnostic by design.** Every AI coding tool eventually reads and writes
  files, so cowove syncs files and nothing else. It watches your project folder and
  mirrors changes into a shared [Yjs](https://yjs.dev) CRDT document. Remote
  changes are written back to disk. Your editor or agent just sees files change.
- **Real merges, not overwrites.** Text files are synced character by character.
  If your agent edits the top of `app.ts` while theirs edits the bottom, both
  edits land. Binary files (images, etc.) sync as whole files.
- **Works apart.** A small relay server connects everyone over WebSockets
  (host it anywhere, or tunnel it from your laptop). If your connection drops,
  keep working: cowove keeps a local copy of the shared state and merges your
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
  use the `cowove` CLI or read `.cowove/STATUS.md`.

## The website (no install)

Any relay started with `cowove serve` also serves the cowove website. Open it
in Chrome, Edge, Brave or Arc, type your name, click **Share a folder**, and
send the invite link it gives you. Whoever opens the link picks a folder, and
the project appears there and stays in sync. Keep the tab open while you
work. People using the website and people using `cowove join` can be in the
same session, and `cowove join` accepts the website's invite links.

In a session, the **Connect your AI** card links your AI tool to cowove with
one click for Cursor ("Add to Cursor") or one command for Claude Code. It uses
an MCP server the relay hosts, so nothing is installed, and you set it up once
for every session. Your AI then shares what it's working on, sees what others
are doing, and can message and claim files.

To run it from a checkout, build the site once: `npm install && npm run build && cowove serve`.

## Quick start

Requires Node.js 20+.

```bash
git clone <this repo> && cd cowove && npm install && npm link   # puts `cowove` on your PATH
```

### The easy way: the app

```bash
cowove ui
```

This opens cowove in your browser, where you can:

- **Start a session:** pick your project folder, then either host the relay on
  your computer with one click or point at a hosted relay. You get an invite code to send.
- **Join a session:** paste an invite code and pick where the project should go.
- **Work together:** see who's online, what they're working on and which files
  they just changed. Chat, send direct messages, and drag and drop files to share
  them. You can also claim files, and rejoin recent sessions later.

The app only listens on `127.0.0.1` and needs the secret link `cowove ui` prints.

### The terminal way

**1. Run a relay** that both of you can reach (see [Hosting the relay](#hosting-the-relay)):

```bash
cowove serve                      # listens on :4321
```

**2. Start a session** in your project folder:

```bash
cd ~/code/my-app
cowove join --server wss://your-relay.example.com --name you --tool claude
```

It prints an invite code. Send it to your friend.

**3. Your friend joins** from an empty folder (or their own clone of the same repo):

```bash
mkdir my-app && cd my-app
cowove join <invite-code> --name friend --tool cursor
```

Keep `cowove join` running in a terminal while you work. It logs who joined,
what they're touching, claims, and messages.

**4. Connect your AI tools** (once per project, by either of you; it syncs):

```bash
cowove setup
```

This registers the `cowove` MCP server in `.mcp.json` (Claude Code) and
`.cursor/mcp.json` (Cursor), and adds pairing etiquette to `CLAUDE.md` and
`AGENTS.md` ("check what your partner is doing before you start; don't edit
claimed files; re-read files before editing"). Restart or reload your tool to
pick up the MCP server.

## Commands

| Command | What it does |
|---|---|
| `cowove ui` | Open the app (start, join, chat, files) |
| `cowove serve [--port 4321] [--data ./cowove-data]` | Run a relay |
| `cowove relay set <url> [--key <key>]` | Use your hosted relay by default |
| `cowove relay` / `cowove relay check <url>` / `cowove relay clear` | Show and test the default relay, test any relay, or forget it |
| `cowove join` / `cowove join --server <url>` | Start a new session for this folder (on your default relay, or the one given) |
| `cowove join <invite>` | Join a session |
| `cowove join` | Rejoin this folder's last session (merges offline edits) |
| `cowove invite` | Print the invite code again |
| `cowove status` | Who's online, focus, recent edits, claims, messages |
| `cowove focus "adding auth"` | Tell others what you're working on |
| `cowove claim 'src/auth/**' "rewriting login"` | Soft-lock files/folders/globs |
| `cowove release <pattern>` / `cowove release` | Release one claim / all of yours |
| `cowove chat` | Interactive chat in your terminal (live messages, DMs, files) |
| `cowove say "pushing a schema change"` / `cowove say @bob "got a sec?"` | Message everyone / one person |
| `cowove send design.png @bob "new mockup"` | Send a file (to everyone, or one person) |
| `cowove messages` / `cowove messages --all` / `--with bob` | Unread messages / history / one conversation |
| `cowove get <message-id> [dest]` | Download a shared file again |
| `cowove setup` | Wire up MCP + agent instructions |
| `cowove mcp` | The MCP server itself (your AI tool launches this) |
| `cowove doctor [--watch 30]` | Check what cowove can see of your Claude Code / Cursor chats (safe to share: no chat text) |

### MCP tools for agents

| Tool | Purpose |
|---|---|
| `cowove_join_session` | Join a session from an invite code, as an agent (no human needed) |
| `cowove_start_session` | Start a new session for a folder and get an invite code |
| `cowove_leave_session` / `cowove_session_info` | Leave; or see the folder, your name, who's online, and the invite |
| `cowove_status` | Collaborators, their focus, recently edited files, claims, messages |
| `cowove_partner_feed` | Read what a collaborator's AI is doing (prompts, replies, actions) |
| `cowove_list_files` | Shared files with recent editors and claims |
| `cowove_set_focus` | Announce the current task |
| `cowove_claim` / `cowove_release` | Claim or release files before and after larger changes |
| `cowove_message` | Message everyone, or one person with `to` |
| `cowove_read_messages` | Read unread (or recent) messages, including received files |
| `cowove_send_file` | Send a project file through chat (secrets and paths outside the project are refused) |
| `cowove_get_file` | Download a shared file (again) |

Any MCP-capable tool works: Claude Code, Cursor, Windsurf, Codex, Zed, and so on.
Point its MCP config at the command `cowove` with args `["mcp"]`.

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

Sharing is on when you join. Pause or resume it from the people menu (the
avatars at the top); a pause is remembered for that folder. cowove reads Claude
Code transcripts from `~/.claude/projects` and Cursor's local chat database
(read-only, needs Node.js 22.13+). Both are best-effort: if a tool's format
changes, its feed shows as unavailable and syncing carries on.

## Agents as participants

An AI agent can be a full member of a session, with no human running cowove for
it. Give the agent an invite code and it calls `cowove_join_session`. The project
syncs into its folder, and everyone sees it in the session with an agent badge.
It can then read partners' AI feeds, claim files, chat, and edit files that
sync to everyone. It can also start a session with `cowove_start_session` and
hand out the invite. The session lasts as long as the agent's MCP server runs.

Agents that prefer the shell can run `cowove join <invite> --agent` instead.

## Messaging and file sharing

Chat lives alongside the code. Messages go to everyone by default, or to one
person with `@name`. Messages are kept in the room, so anyone offline sees
them when they reconnect, and `cowove status` shows your unread count.

Files you **send** (screenshots, logs, exports, a PDF spec) go through the relay
as attachments. They are *not* added to the shared project folder. Recipients
get them automatically in `.cowove/inbox/`, including files sent while they
were offline. The limit is 100 MB per file.

Direct messages and files are only shown to the sender and recipient, but they
travel through the shared room, so they're private from other collaborators'
screens, not from the relay operator.

## Hosting the relay

Host a relay once, and starting a session becomes one click: no tunnels, and
friends just paste an invite code. The relay is a single small process. It
comes ready to deploy with a Fly.io config (`fly.toml`, about $2–5/month), a
Render blueprint (`render.yaml`), a docker-compose file with automatic HTTPS
for any server (`deploy/`), and a prebuilt image published by CI
(`ghcr.io/danielcarmichaelgit/cowove-relay`).

**[docs/hosting.md](docs/hosting.md)** walks through each option. Once it's
running:

```bash
cowove relay set wss://your-relay.example.com --key <relay key>
```

From then on, `cowove join`, the app and agents start sessions there by default.
The relay key stops strangers from starting sessions on your relay. People you
invite never need it.

Hosted relays are built for the public internet:

- Each session has its own secret, and starting sessions can require a key.
- Sessions have size quotas and shared-file quotas, and there's a
  connection limit per address.
- Idle sessions are unloaded from memory, and sessions nobody opens for 30
  days are deleted.
- It serves a health check at `/healthz` and a status page at `/`.

No server handy? `cowove ui` → **Host relay here** runs one on your computer.
Use `cloudflared tunnel --url http://localhost:4321` for partners who aren't
on your network.

## What syncs (and what doesn't)

- Everything in the folder **except**: `.git/`, `node_modules/`, `.cowove/`,
  `.env` / `.env.*` (secrets stay local), editor swap files, anything in your
  `.gitignore`, and anything in an optional `.cowoveignore` (same syntax).
- Text files up to 2 MB and binary files up to 8 MB.
- Symlinks are not synced.
- On first join, if a file differs between your folder and the session, the
  session's version wins and yours is copied to `.cowove/conflicts/<time>/`.
  Use `--prefer local` to push your versions instead.

**Git:** the working tree is shared, but `.git` isn't. The simplest workflow
is that one person commits and pushes. Avoid `git checkout`, `reset`, `stash`
and `rebase` during a session unless you've agreed on it: they rewrite files,
and the changes sync to everyone.

## Security

- Each room has a secret (inside the invite code). The first client to open a
  room sets it, and everyone else must match. Treat invite codes like passwords.
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
`bin/cowove.js` (CLI).
