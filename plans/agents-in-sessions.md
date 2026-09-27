# Agents as first-class participants

## Goal

Any AI agent, local or in the cloud, can join a session, see what's going on,
coordinate, edit the shared project, and have its own conversation show up in
everyone's feed, the same way a person's does.

## What exists today

- `elegy mcp` (stdio) gives local agents tools: `elegy_join_session`,
  `elegy_start_session`, status, partner feed, claims, messages, files.
- Joining as an agent runs a normal sync session with `kind: 'agent'`, and
  shares the agent's own Claude Code / Cursor chat through the feed readers.
  Since this change, the reader follows the folder the agent was *started in*
  (`chatDir`), not only the synced folder, so an agent that synced into an
  `elegy-<room>` subfolder still shares its chat.

## Three kinds of agents

1. **Local agents** (Claude Code, Cursor, Codex CLI on someone's machine):
   stdio MCP, as today.
2. **Cloud agents with a container** (Claude Code on the web, Codex cloud,
   Cursor background agents, CI): they have a disk, so they run the normal
   daemon. What they need:
   - elegy installable without a global install: `npx` in `.mcp.json`
     (needs the npm package, see [hosted-website.md](hosted-website.md)).
   - The relay host allowed by the environment's network policy.
   - An invite, given as an environment secret (`ELEGY_INVITE`) or pasted
     into the prompt, and a SessionStart hook or the MCP tool to join.
3. **Agents without a disk** (claude.ai, ChatGPT, other hosted assistants via
   MCP connectors): a **remote MCP endpoint** on the hosted service
   (Streamable HTTP, `https://elegy.dev/mcp`, OAuth). The server works on the
   room's Y.Doc directly, so it can offer `list_files`, `read_file`,
   `write_file` (applied as a CRDT edit, so it merges with everyone else),
   plus the existing status / feed / claim / message tools.

## Identity and safety

- Every agent has an owner (the person who invited it) shown in the UI:
  "Claude (Dan's agent)".
- Agent tokens are scoped to one session, can be read-only, expire, and are
  revocable from the session page.
- Rate limits and a per-agent write budget so a runaway agent can't flood the
  room. Claims are respected by the remote MCP `write_file` (refuse writes to
  files someone else claimed unless forced).
- The agent's feed marks it as an agent so summaries and filters can treat it
  differently.

## Cloud agents today (before the website)

Until the npm package exists, a Claude Code cloud environment can join like
this:

1. Allow the relay host in the environment's network settings.
2. Setup script: `npm i -g github:DanielCarmichaelGit/elegy`.
3. Keep `.mcp.json` registering `elegy mcp`, and ask the agent to call
   `elegy_join_session` with the invite (or start `elegy join <invite>` in the
   background from a SessionStart hook).

The agent's chat is read from the container's own `~/.claude/projects`, which
is why a chat from a cloud session can never be seen by an `elegy join`
running on your laptop: the transcript isn't on your laptop.
