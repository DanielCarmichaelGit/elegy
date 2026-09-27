# Hosted website + npm package

## Problem

Today, using elegy means cloning the repo, `npm install && npm link`, then
either hosting a relay or tunnelling one from a laptop, and passing a relay
key around. That's fine for the people who built it and a wall for everyone
else.

## Options considered

| | Website + npm CLI | Electron app |
|---|---|---|
| First run for a new person | Click an invite link, run one `npx` line | Download ~100 MB, install, OS warnings |
| Syncs to the real project folder | Yes, via the small local CLI | Yes |
| Release burden | `npm publish` + deploy the site | Code signing (Apple $99/yr, Windows cert), notarization, auto-update, 3 OS builds |
| Works for cloud agents / CI / SSH boxes | Yes, same CLI | No (needs a desktop) |
| Accounts, invites, dashboards | Natural | Still needs a backend |

**Recommendation: website + npm package.** It matches the stated preference,
and Electron doesn't remove the hard part (a backend for accounts and the
relay); it only adds packaging work. If a tray app is wanted later, a thin
Tauri wrapper around the same local UI is a small add-on.

### Why the website can't be *only* a website

elegy's whole point is that each person's own AI tool (Claude Code, Cursor,
vim) edits a **real folder on their disk**. A browser tab can't reliably do
that: the File System Access API is Chromium-only, needs the tab to stay open,
and the agents can't see a browser's sandbox. So every person who edits code
still runs a small local process. The website removes everything *around* it:
hosting, tunnels, keys, invites, and viewing.

## Shape

```
  elegy.dev (hosted)                                   each person's machine
  ┌───────────────────────────────┐                    ┌──────────────────────┐
  │ website: sign in, sessions,   │  invite link        │ npx elegy join <code>│
  │ invite links, live read-only  │ ─────────────────▶  │  = file sync daemon  │
  │ view (feed, files, chat)      │                     │  + local app (ui)    │
  │                               │  wss (outbound)     │  + MCP for agents    │
  │ relay (existing server.js,    │ ◀────────────────── │                      │
  │ multi-tenant)                 │                     └──────────────────────┘
  │ remote MCP endpoint (agents)  │ ◀── cloud agents without a disk daemon
  └───────────────────────────────┘
```

- **No tunnelling at all.** Every client connects *out* to the hosted relay
  over `wss://`, which works behind any NAT or firewall. "Host the relay on my
  laptop" stays as an advanced/offline option.
- **No shared tokens.** Replace the relay key with accounts:
  - Sign in with GitHub (or email magic link) on the website.
  - `elegy login` uses a device-code flow (like `gh auth login`): the CLI
    shows a code, you approve it in the browser, the CLI stores a token.
  - Invites become links: `https://elegy.dev/j/<code>`, with expiry and a
    role (edit / view). The page shows the exact one-liner to run and a
    "copy" button. Joining needs only the link, never someone else's token.
  - Agent tokens are per session, scoped, and revocable (see
    [agents-in-sessions.md](agents-in-sessions.md)).
- **Live view in the browser.** The relay already speaks the y-websocket
  protocol, so the site can open the session's Y.Doc directly and render the
  agent feed, file tree, chat and read-only file views without any new server
  API. Viewers (a PM, a reviewer) don't need to install anything.

## npm package

- Publish the CLI to npm. The bare name `elegy` may be taken; fall back to a
  scope (`@elegy/cli`) with the binary still called `elegy`.
- `package.json`: add `files` (bin, src, assets), `repository`, `keywords`;
  raise `engines` to `>=22.13` (the Cursor feed needs `node:sqlite`) or keep 20
  and let the Cursor feed report itself unavailable, as it does today.
- `elegy setup` writes `"command": "elegy"` into `.mcp.json`. Once published,
  switch it to `npx -y <package> mcp` so the MCP server works on machines
  (and cloud containers) where elegy isn't installed globally.
- The library stays usable without the website: `elegy serve` keeps working
  for self-hosters, and the hosted relay is just the default.

## Phases

1. **Publish to npm**, `npx` in `.mcp.json`, invite codes that default to the
   hosted relay. (Small; unblocks cloud agents immediately.)
2. **Multi-tenant hosted relay** with accounts: auth on room create/join, per
   account quotas, device-code login, invite links with expiry/roles.
3. **Website**: landing, sign in, "new session", session page with the live
   read-only view, member and agent management, revoke.
4. **Remote MCP endpoint** for agents that can't run the daemon.
5. **End-to-end encryption** of room contents (the relay only sees
   ciphertext). Worth doing before strangers' code sits on our servers; Yjs
   updates can be encrypted per room with a key carried in the invite
   fragment (`#key`), which never reaches the server.

## Stack suggestion

- Keep the relay as the existing Node `server.js` (one always-on instance with
  a disk, e.g. Fly.io). Add a small auth layer in front of room upgrade.
- Website: a static/SSR site (e.g. Next.js or Astro) on Netlify/Vercel, with
  Supabase (Postgres + auth) for accounts, sessions, invites and agent tokens.
  The relay verifies Supabase-issued JWTs on connect.
- Browser live view: `yjs` + `y-websocket` client in the site, reusing the UI
  code in `src/ui/` where possible.

## Open questions

- Pricing / limits for the hosted relay (free tier size, retention).
- Is E2EE required for launch, or a fast follow?
- Should editing be possible from the browser (a small in-browser editor for
  quick fixes), or is the web view read-only?
