# 002: Cloud sessions (Claude Code cloud, Cursor cloud agents) share nothing

**Status:** Blocked on a public relay (deploy) · **Reported:** 2026-09-28 · **Seen on:** Claude Code on the web; Cursor cloud agents

## What happens
When the AI runs in the cloud (Claude Code on the web, Cursor background/cloud
agents), nothing it does shows up in the session: no feed, no presence.

## What should happen
A cloud AI session shows up like a local one: its prompts, replies and actions
appear in the feed, and it can coordinate through Quilt's tools.

## What we know
- A cloud session runs in its own container. Its chat history lives **only in
  that container** (`~/.claude/projects/...`). An `quilt join` or website tab
  on your own computer can never see it.
- Quilt's reader works in a cloud container. `quilt doctor --watch` run inside
  a Claude Code cloud session on 2026-09-28 found the conversation and produced
  50 feed entries. Reading isn't the problem.
- Nothing starts Quilt inside the container. The repo's `.mcp.json` runs the
  `quilt` command, which isn't installed there, and nobody runs `quilt join`.
- Even when started, the container must reach the relay. A relay on someone's
  laptop (`quilt serve`, `ws://localhost...`) is unreachable from the cloud,
  and cloud environments often only allow approved network hosts.
- Commit `4f60322` fixed one part: an agent that joins with
  `quilt_join_session` into a subfolder now shares its own chat.

## Likely causes
1. Quilt isn't installed or started inside the cloud container.
2. No relay the cloud can reach (not deployed publicly yet), or the cloud
   environment's network policy blocks it.

## Fix options (need a public relay first)
- **A. Hosted MCP (preferred, nothing to install).** The deployed site already
  hosts an MCP server (`/mcp/<token>`). Point the cloud AI at it:
  - Claude Code on the web: add the server to the repo's `.mcp.json` with the
    personal token from an environment secret, e.g.
    `{"mcpServers":{"quilt":{"type":"http","url":"https://<site>/mcp/${QUILT_TOKEN}?tool=Claude%20Code"}}}`,
    and allow `<site>` in the environment's network settings.
  - Cursor cloud agents: the same address in `.cursor/mcp.json` (check
    whether Cursor expands environment variables there).
  - The AI then shares through `quilt_share`, like "Connect your AI" in the browser.
  - Open question: the token links to the session the person's **browser tab**
    is in. A cloud session with no tab open needs a way to pick the session:
    an `quilt_join` tool taking an invite link, or a token bound to one session.
- **B. Run Quilt in the container.** A SessionStart hook that installs Quilt
  (`npm i -g github:DanielCarmichaelGit/elegy`) and runs
  `quilt join "$QUILT_INVITE"` in the background, with the invite as an
  environment secret. The full chat reader works, and the container's files
  sync too. Heavier, and it needs network access to the relay and to GitHub/npm.

## Next steps
1. Deploy the site/relay at a public `https://` address (see `docs/hosting.md`).
2. Build option A with an invite-based `quilt_join` tool so it doesn't need a
   browser tab; document the per-tool setup; test from a real cloud session.
3. Keep option B documented for people who want full chat history.

## Log
- 2026-09-27: partly addressed (`4f60322`: agents syncing into a subfolder share their chat).
- 2026-09-28: diagnosed with `quilt doctor` inside a cloud session; blocked on deploy.
