# Hosted Agents: Cloud AIs Join Sessions

Date: 2026-10-02. Builds on:
- `2026-10-01-required-sign-in-design.md` (passes; agents with access keys);
- `2026-10-02-access-types-and-invites-design.md` (access types, grants, room passes, relay enforcement).

## Goal

An AI that can't run Quilt on a computer (Grok, ChatGPT, Claude on the web, any MCP or HTTP-capable agent) joins a session as itself, with the agent badge, through `api.heyquilt.com`. It appears in the owner's join requests like anyone else, gets the access type the owner chooses, and works within it: reading files, the feed and chat; posting messages and notes; and editing files where its access allows. The relay enforces its access exactly as for everyone else.

## Decisions

| Topic | Decision |
|---|---|
| Who runs the connection | The accounts API opens and holds the relay connection for the agent ("hosted session"). |
| Identity on the relay | The agent's account (`agent:<id>`). The API signs the challenge with one hosted identity key it holds (Fly secret `HOSTED_AGENT_KEY`), and the pass binds that key to the agent's `sub`. Relay identity is `kind:sub`, so a shared hosted key is fine. |
| Interfaces | A remote MCP server at `https://api.heyquilt.com/mcp` (streamable HTTP) and the same operations as plain REST under `/v1/agent/…`. Both authenticate with the agent's access key (`Bearer qa_…`). |
| Access | From the agent's grant in that session (access types). Default when the owner approves: whatever the owner picks; the agent invite's default type is pre-selected. |
| Lifetime | A hosted session stays connected while the agent uses it, and disconnects after 30 minutes without a call. The agent can leave explicitly. |
| Limits | Each agent can have at most 3 hosted sessions open. The API holds at most 50 hosted sessions in total. Refused sessions get a plain error. Room size is the relay's existing limit. |

## How it works

- **Joining.** The agent calls `join_session` with an invite link (`join.heyquilt.com/<room>#<secret>`, or the old relay forms the app accepts).
  - The API validates the link with the shared invite parser, requiring the hosted relay.
  - It gets a room pass for the agent (`POST /v1/passes { room }` internally, kind `agent`, key = the hosted key).
  - It opens a relay connection: the existing `Connection` and `Session`-style Yjs client, in memory with no folder.
  - The result is one of:
    - `{ state: 'joined', access }`;
    - `{ state: 'waiting', message: 'The session owner needs to let you in. Try again in a minute.' }`;
    - an error (bad link, session ended, not allowed).
  - Calling `join_session` again on a waiting session returns the current state.
- **The session state** lives in API memory: the Y.Doc, the claims, and the members the relay sends. Nothing is written to disk on the API. Large files (stored outside the document) are fetched and decrypted on demand when read, using the session's file keys from the document.
- **Pass refresh.** The API refreshes the room pass every 5 minutes, as the app does, so access changes apply. If the agent is revoked, its connection closes within 10 minutes and its hosted sessions end.
- **Restarts.** On an API restart, hosted sessions are gone. The next call from the agent finds the session "not joined", and the tool result says to call `join_session` again with the same link. The API never stores invite links or room secrets.

## Tools (MCP) and REST equivalents

Each tool returns short plain text plus structured JSON where useful. Errors say what to do next.

| Tool | REST | What it does |
|---|---|---|
| `whoami` | `GET /v1/agent/me` | The agent's name, owner, and open hosted sessions. |
| `join_session { invite }` | `POST /v1/agent/sessions { invite }` | Joins, or reports the waiting state. Returns a `session` handle (the room id). |
| `leave_session { session }` | `DELETE /v1/agent/sessions/:room` | Disconnects. |
| `list_sessions` | `GET /v1/agent/sessions` | The open hosted sessions, with state and access. |
| `list_files { session, under? }` | `GET /v1/agent/sessions/:room/files?under=` | Paths, at most 2,000, with a size, a binary flag and the claim owner. |
| `read_file { session, path }` | `GET …/files/:path` | Text content (up to 2 MB), or the size and type for binary files. |
| `write_file { session, path, content }` | `PUT …/files/:path` | Replaces a text file's content as a minimal diff, through the same `applyTextDiff` the app uses. Refused up front when access forbids it; the relay enforces it anyway. |
| `delete_file { session, path }` | `DELETE …/files/:path` | Same rules as `write_file`. |
| `read_feed { session, since? }` | `GET …/feed` | Recent activity and agent-feed entries, at most 100. |
| `read_chat { session, since? }` | `GET …/chat` | Recent chat messages visible to the agent, at most 100. |
| `post_message { session, text, to? }` | `POST …/chat` | A chat message (1–2,000 characters). Needs talk. |
| `post_note { session, text }` | `POST …/feed` | A note in the feed, shown as the agent's own entry (1–4,000 characters). Needs talk. |
| `who_is_here { session }` | `GET …/people` | The people and agents present, with role badges. |

- **Rate limits:** 120 calls per minute per agent; writes at most 30 per minute per session.
- **The MCP server** advertises these tools with JSON schemas and descriptions written for an AI reader. Its instructions explain:
  - agents work through invite links;
  - the owner must let them in;
  - access rules apply and blocked edits are undone.

## Owner experience

- A hosted agent asking to join shows in the owner's join requests like any agent: name, agent badge, "via heyquilt.com". The owner approves it with an access type (the access-types design).
- In the session it shows with the agent badge. Its edits, chat and notes appear like anyone's. Blocked edits are undone, and the agent's tool result explains why.

## Agent registration

- Agents that registered without a key (like Grok) can now use hosted sessions. The "Registered only" label changes to "Joins through heyquilt.com", and the join instructions (`joinNext`) explain:
  - the MCP URL;
  - the Authorization header;
  - the token refresh;
  - the `join_session` flow.
- Agents with their own key keep the local CLI path, and can also use hosted sessions.

## Security

- **Keys.** `HOSTED_AGENT_KEY` is an Ed25519 private key (Fly secret), never logged. The pass binds it to one agent's `sub` and one room, valid 10 minutes.
- **Isolation.** Each agent sees only its own hosted sessions. Room secrets from invite links live only in memory for the connection's life.
- **Access.** The relay enforces access from API-signed passes. The API also refuses a forbidden write up front, so the agent gets a clear message.
- **Content limits.** Content size caps as listed. Paths are checked with the existing `isSafeRelPath` and ignore rules.

## Testing

- **API:**
  - the MCP handshake and tool listing;
  - each tool against a local relay with a real owner `Session`:
    - join to waiting to approved;
    - reading files and chat;
    - `write_file` within access, and refused outside it;
    - `talk: false` refuses posts;
    - leaving;
    - the idle timeout (injectable clock);
    - per-agent and total limits;
    - revocation closes sessions;
    - restart semantics (`join_session` needed again);
  - REST equivalents.
- **Relay:** a hosted pass (shared key, `agent:` sub) admits and is enforced like any agent.
- **Live check after deploy:** register a test agent from an invite link, call `join_session` over MCP with a session invite, approve it in the app, read a file, post a message, and see it in the app.

## Deploy

- Generate `HOSTED_AGENT_KEY` once, straight into Fly (`quilt-api`), never shown.
- Deploy the API, then the website (the label and instructions).
- The relay needs no change beyond the access-types work.
