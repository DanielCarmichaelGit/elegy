# Agent feed workspace: design

Date: 2026-09-26
Status: draft, awaiting review

## Goal

Let collaborators watch each other's AI coding conversations live, and see
and claim the project's files, from the `elegy ui` session screen. elegy stays
tool-agnostic for syncing; the feed is best-effort per tool, starting with
Claude Code and Cursor.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Main area | Read-only live feed of a partner's AI conversation |
| Tools first | Claude Code, Cursor |
| Consent | Shared by default once you join, with a visible Pause/Resume |
| Detail level | Prompts and replies in full; one-line actions ("Edited src/app.ts", "Ran npm test"); never command output, file contents, or hidden reasoning |
| Transport | Stored in the shared Yjs doc like chat, capped per person |
| Layout | Layout A: file tree left, main area center, chat right |
| Main area modes | A switch, **AI** or **Files**, never mixed. AI tabs are people; Files tabs are open files |
| File tree | Visible in both modes |
| File tabs | Read-only |

## Architecture

```
  your machine                                         partner's machine
  ~/.claude/projects/…/*.jsonl ─┐
  Cursor state.vscdb ───────────┤ agent readers          elegy ui
                                ▼ (src/agents/)            ▲ feed, tree, file view
                           Session.agentFeed  ──Yjs──►  Session.agentFeed
                           awareness.agent    ──────►   awareness.agent
```

### 1. Agent readers (`src/agents/`)

Each reader runs inside the process that syncs a folder (`elegy join` or
`elegy ui`), watches only its own user's tool, and emits normalized entries.

```js
// src/agents/index.js
startAgentReaders({ dir, onEntries, onState, onLog }) -> { stop() }
// entry:  { id, tool, conv, kind: 'prompt'|'reply'|'action', text, ts }
// state:  { tool, status: 'working'|'idle'|'unavailable', reason? }
```

- `id` is stable across restarts (Claude Code line `uuid`, Cursor `bubbleId`)
  so re-reading never duplicates entries.
- `conv` is the conversation id, used to draw "new conversation" dividers.
- Startup backfill: conversations updated in the last hour, at most the last
  50 entries each. After that, live only.
- `text` is capped at 8,000 characters with "…(truncated)".

**Claude Code** (`src/agents/claude-code.js`)

- Transcripts live in `~/.claude/projects/<slug>/<sessionId>.jsonl`, where
  `<slug>` is the absolute folder path with every non-alphanumeric character
  replaced by `-`. Scan every project dir whose slug starts with the synced
  folder's slug (covers subfolders), and keep only lines whose `cwd` is the
  synced folder or inside it.
- Watch those dirs with the existing `chokidar` dependency; read each file
  from the last byte offset. A trailing line without a newline is buffered and
  retried; lines that fail to parse are skipped.
- Mapping:
  - `type: 'user'` with string content or `text` blocks, not `isMeta`, not
    `isSidechain` → `prompt`. `tool_result` blocks are ignored.
  - `type: 'assistant'` `text` blocks → `reply`. `thinking` blocks ignored.
  - `tool_use` blocks → `action` via `describeAction` (below).
  - Sidechain (subagent) lines are ignored.
- Status: `working` after any new line; `idle` after an assistant message with
  `stop_reason: 'end_turn'`, or after 2 minutes with no new lines.

**Cursor** (`src/agents/cursor.js`)

Verified against Cursor's storage on this machine (composerData `_v: 3`):

- Find the workspace: `~/Library/Application Support/Cursor/User/workspaceStorage/*/workspace.json`
  whose `folder` (`file://` URI) is the synced folder. (Linux:
  `~/.config/Cursor/User/…`; Windows: `%APPDATA%\Cursor\User\…`.)
- That workspace's `state.vscdb`, table `ItemTable`, key
  `composer.composerData` → `allComposers[].composerId`.
- Global `globalStorage/state.vscdb`, table `cursorDiskKV`:
  - `composerData:<id>` → `fullConversationHeadersOnly: [{ bubbleId, type }]`
    gives message order.
  - `bubbleId:<id>:<bubbleId>` → `{ type: 1|2, text, toolFormerData? }`.
    `type 1` → `prompt`; `type 2` with `text` → `reply`; `toolFormerData.name`
    → `action`.
- Open both databases read-only with `node:sqlite`
  (`new DatabaseSync(path, { readOnly: true })`) and poll every 2 seconds for
  composers whose `lastUpdatedAt` changed.
- `node:sqlite` needs Node 22.13+. If it is missing, or the layout doesn't
  match (missing table/keys, JSON parse errors), the reader reports
  `unavailable` with a reason, logs once, and stops. Syncing is unaffected.
- Status: `working` while the newest bubble changed in the last 10 seconds,
  otherwise `idle`.

**`describeAction(tool, input, dir)`** (`src/agents/actions.js`), shared by
both readers. Paths are shown relative to the synced folder.

| Tool (Claude Code / Cursor) | Line |
|---|---|
| Edit, MultiEdit, Write, NotebookEdit / edit_file, search_replace | `Edited <path>` (`Created <path>` for Write of a new file) |
| Read / read_file | `Read <path>` |
| Grep, Glob / grep_search, file_search, codebase_search | `Searched the code` |
| Bash / run_terminal_cmd | `Ran <program> [<subcommand>]` |
| anything else | `Used <tool name>` |

`Ran …` strips leading `VAR=value` assignments and keeps the program name plus
at most one following word that matches `/^[a-z][\w:.-]*$/` (e.g. `npm test`,
`git status`, `pytest`). Everything else on the command line is dropped, so
flags, tokens, URLs and paths are never shared.

### 2. Shared state (`src/session.js`)

- New `this.agentFeed = this.doc.getArray('agentFeed')`, entries
  `{ id, by, tool, conv, kind, text, ts }`.
- `pushAgentEntries(entries)`: skips ids already present for this user, pushes
  in one transaction, then trims so each person keeps their newest 300
  entries.
- `setAgentSharing(on)`: when turned off, new entries are dropped and one
  `{ kind: 'paused' }` entry is pushed; turning it back on pushes
  `{ kind: 'resumed' }`. The choice is saved in `.elegy/config.json`
  (`shareAgent: false`) so it survives restarts.
- Awareness gains `agent: { tool, status, sharing, reason? }` for the live
  "working…" indicator and the people menu.
- `agentFeedFor(name, { limit })` returns that person's entries, oldest first.
- New `file-changed` event `{ path, by }` when a file changes from either
  side, so open file tabs refresh.

The session starts the readers in `runSession` (`src/runner.js`) and stops
them in `run.stop()`, so `elegy join` and `elegy ui` behave the same.

### 3. Local app API (`src/ui-server.js`)

| Route | Returns |
|---|---|
| `GET /api/sessions/:id/feed?who=<name>` | `{ entries }` for that person |
| `GET /api/sessions/:id/tree` | All synced paths (`files` + `blobs` keys) with `edited: { by, ts }` from recent activity and presence, and the claim covering each path |
| `GET /api/sessions/:id/file?path=` | `{ path, text }` for text; `{ path, binary: true, size }` for binary; `404` if not in the session. Read from the shared doc, not disk. Paths are normalized and must be a key in the doc, so nothing outside the project can be read |
| `POST /api/sessions/:id/sharing` | `{ on }` → `setAgentSharing` |
| existing `claim` / `release` | Claiming a folder sends its path (e.g. `src/auth`); `globMatcher` already treats a plain path as the folder and everything inside it |

SSE gains `feed` (`{ id, entries }`, new entries only) and `file-changed`
events. Presence changes already trigger `session` events.

### 4. Session screen (`src/ui/`)

`app.js` (~790 lines) keeps boot, home, and shared helpers. The session
screen moves to native ES modules, served by adding them to `STATIC`:

- `session.js`: layout, top bar, people menu, mode switch, tabs, chat sidebar
  (the existing chat, DMs and file sharing, moved unchanged)
- `feed.js`: AI thread rendering and auto-scroll
- `tree.js`: file tree, badges, ⋯ menu
- `fileview.js`: read-only file tab with line highlights

**Top bar:** project name, connection dot, 👥 people button with stacked
avatars and a count. The people menu opens on hover, click, or keyboard focus
and closes on Escape. Rows: avatar, name, tool, focus, file being edited, AI
status. Clicking a person opens or selects their tab in AI mode. Your own row
shows "Sharing your AI chat" with Pause/Resume, or the reader's
`unavailable` reason.

**Mode switch:** `🤖 AI | 📄 Files` above the tabs. Each mode keeps its own
tab list and selected tab; switching modes never closes tabs. Opening a person
switches to AI; opening a file switches to Files. Open tabs and mode are
remembered per session in `localStorage`.

**AI tab:** prompt bubbles, reply text (rendered as simple Markdown: code,
bold, lists, links), action lines in monospace, dividers between
conversations and at pause/resume. "sam's AI is working…" while their status
is `working`. Auto-scrolls when at the bottom; otherwise a "New activity ↓"
button. Empty states: "No AI activity from sam yet", "sam paused sharing",
"sam's Cursor feed isn't available".

**Files tab:** banner ("Edited by sam 4s ago", claim status, Claim/Release
button), line-numbered read-only text. On `file-changed` it refetches, diffs
the old and new text by line, and highlights changed lines for 4 seconds.
Binary files, files over the sync size limit, and deleted files show a short
note.

**File tree:** collapsible folders (top-level expanded by default). Orange
"name · 4s" badge for files edited in the last 2 minutes; a dot on collapsed
folders containing one. Purple "name" badge on claimed files or folders.
Click a file to open it. ⋯ on hover (or right-click) offers Claim (with an
optional note) or Release. Claims by others are shown but only releasable by
their owner.

**Chat sidebar:** existing chat UI, narrowed. Unread badges unchanged.

At widths under 900px the tree and chat collapse into toggle buttons in the
top bar.

## Error handling

- Tool not installed or no matching conversations: reader stays idle; people
  menu shows "No AI activity found yet".
- Cursor layout mismatch or `node:sqlite` missing: reader reports
  `unavailable` with a reason, logs once, stops.
- Partial or malformed transcript lines: buffered or skipped, never fatal.
- Reader exceptions are caught at the reader boundary and never reach the
  sync loop.
- Oversized entries truncated at 8,000 characters.
- File view: deleted → "File was deleted"; not in the session → 404 message.

## Testing

`node --test`, in the style of `test/sync.test.js` and `test/ui.test.js`.

- `test/agents-claude.test.js`: fixture transcripts in a temp `HOME`;
  prompts/replies/actions mapped, thinking and tool results dropped,
  sidechains ignored, other folders' conversations ignored, subfolder
  conversations included, partial trailing line handled, live append picked up.
- `test/agents-cursor.test.js`: builds both SQLite databases in a temp dir with
  the verified layout; picks only this folder's composers; maps bubbles;
  a broken layout reports `unavailable`. Skipped when `node:sqlite` is missing.
- `test/actions.test.js`: `describeAction`, especially that `Ran …` drops
  flags, env vars, URLs and tokens.
- `test/sync.test.js` additions: two sessions over a relay; entries arrive on
  the other side, dedupe by id, per-person cap of 300, pause stops entries
  and records a marker.
- `test/ui.test.js` additions: `/tree`, `/file` (text, binary, rejected
  `../` and unknown paths), folder claim via the existing route, `/sharing`,
  `/feed`.
- Manual: two `elegy ui` sessions on this machine, one driven by a real
  Claude Code conversation, checked in the browser.

## Out of scope

- Sending messages to a partner's AI.
- Editing files in the app.
- Tools other than Claude Code and Cursor (the reader interface makes adding
  Codex later a single new file).
- Hiding the feed from the relay operator: like chat, it travels through the
  shared room.
