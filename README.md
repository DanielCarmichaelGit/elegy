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
- **Agents coordinate.** An MCP server gives each agent tools to see who's
  online, what they're working on, which files they touched recently, to
  *claim* files, and to message each other. Tools without MCP can use the
  `elegy` CLI or read `.elegy/STATUS.md`.

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
| `elegy claim 'src/auth/**' "rewriting login"` | Soft-lock files/folders/globs |
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
| `elegy_status` | Collaborators, their focus, recently edited files, claims, messages |
| `elegy_set_focus` | Announce the current task |
| `elegy_claim` / `elegy_release` | Claim or release files before and after larger changes |
| `elegy_message` | Message everyone, or one person with `to` |
| `elegy_read_messages` | Read unread (or recent) messages, including received files |
| `elegy_send_file` | Send a project file through chat (secrets and paths outside the project are refused) |
| `elegy_get_file` | Download a shared file (again) |

Any MCP-capable tool works: Claude Code, Cursor, Windsurf, Codex, Zed, and so on.
Point its MCP config at the command `elegy` with args `["mcp"]`.

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
