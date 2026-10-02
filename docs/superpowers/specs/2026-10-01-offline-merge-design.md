# Merging offline work: design

Date: 2026-10-01
Status: decided

## Goal

When someone leaves a session, keeps working in the folder, and comes back, their
offline changes and what the others did meanwhile are combined without anyone's work
silently overwriting or scrambling the other's. Non-overlapping changes merge on their
own. Overlapping changes are given to the returning person's AI to combine without
changing behaviour. Changes that truly cannot be combined become a merge conflict that
anyone in the session can resolve by hand or hand to their coding tool
("Send to Claude Code / Cursor / Codex…").

## What happens today

The session is a Yjs CRDT. On rejoin, `reconcileOffline` diffs each file on disk
against the stale local doc (`.quilt/state.bin`) and pushes the result as character
edits before the relay has synced. The CRDT then interleaves them with everyone else's
edits, character by character, with no notion of a conflict. Two people editing the
same function produce a file nobody wrote. A file deleted offline drops the whole
`Y.Text`, taking the others' edits with it. Edits to a file someone else had claimed are
dumped in `.quilt/rejected/` with only a log line.

The three versions a real merge needs are all present at rejoin: **base** (the stale
local doc), **ours** (the disk), and **theirs** (the doc once the relay has synced).

## Decisions

| Question | Decision |
|---|---|
| Merge unit | Line-based three-way merge per text file (diff3 semantics via `node-diff3`), the same model git uses, so results are predictable and the AI step only sees real overlaps. |
| Order on rejoin | Capture base and ours for every changed file **before** connecting, do not push anything, wait for the relay to sync, then merge against theirs. The watcher starts only after the merge. |
| Clean merge | Written to the shared doc and the disk. Logged as `merged <path> with <who>'s changes`. Not a conflict. |
| Overlapping hunks | Given to a headless AI first (`merge-ai.js`), with base, ours and theirs, told to keep both sides' intent and change no behaviour, and to refuse when the two sides are at odds. An accepted result is applied like a clean merge, logged as `merged <path> (AI)`, and listed in the merge bar as "review" for a while so people can look. A refusal, a missing CLI, a timeout or a bad answer becomes a conflict. |
| Which AI | The returning person's own tool, headless, in this order: `claude -p`, `codex exec`, `cursor-agent -p`; `QUILT_MERGE_CMD` overrides (tests and other tools). Files over 200 KB, binaries and files with more than 20 overlapping hunks skip the AI. 90 s timeout per file, at most 2 files at a time. |
| Conflict | A shared record in a new `merges` Y.Map, visible to everyone: the path, who returned, who else changed it, base, ours, the theirs hash, status. **The shared file keeps theirs** (the session's version), so nobody's build breaks and the person in the session is not interrupted. Ours is kept inside the record and in `.quilt/merges/<id>/`. Nobody's change is accepted as the answer: the record is open until someone acts. |
| Modify/delete | Deleted offline but changed in the session: a conflict (ours = deleted). Changed offline but deleted in the session: a conflict (theirs = deleted), and ours is restored to disk only when someone chooses it. |
| Added on both sides | Same path created on both sides with different content: three-way merge with an empty base (so it usually overlaps → AI → conflict). |
| Binary files | Changed on both sides: conflict straight away, no AI. |
| Claimed files | Changed offline while someone else holds a claim on it: no automatic merge, the record is opened as a conflict with the holder's name. The same actions apply; the holder's claim still gates the write, so "Send to…" ends with the agent asking the holder, as the claim design already says. |
| Resolving by hand | Four actions on a conflict: **Keep mine**, **Keep theirs**, **Edit by hand** (writes git-style `<<<<<<< / ======= / >>>>>>>` markers into the file; the record closes when the file next syncs without markers), **Send to <tool>**. |
| Send to <tool> | Writes `base`, `ours`, `theirs` and `PROMPT.md` to `.quilt/merges/<id>/`. Claude Code: a session is made with the prompt (`claude -p <prompt> --session-id`) and opened with `claude://resume`, as `openInClaude` already does. Other tools: the folder is opened and the prompt is put on the clipboard, with a toast saying to paste it. The prompt tells the agent to write the merged file to the path and then call `quilt_resolve_merge` (or the person clicks **Resolved**). |
| Who can act | Anyone in the session who can edit; the record stores who resolved it and how. Viewers see it, cannot act. |
| First join | Unchanged: there is no base, so the existing backup to `.quilt/conflicts/` stays. |
| Default | On for everyone. The old `.quilt/rejected` and `.quilt/conflicts` behaviour stays for the cases this does not cover (relay refusals, first join, large-file downloads). |

## Pieces

### `src/merge3.js` — three-way merge of text

Pure functions, no I/O.

- `merge3(base, ours, theirs) → { text, conflicts: [{ ours: lines, theirs: lines, base: lines }] }`
  line-based, using `node-diff3`'s `diff3Merge`. `conflicts` empty means clean. Keeps
  the file's line ending (`\n` or `\r\n`) and trailing-newline state.
- `withMarkers(base, ours, theirs, { mine, theirs: name }) → string` the git-style
  marked-up file for **Edit by hand**.
- `hasMarkers(text) → boolean` recognises Quilt's own markers (labelled
  `<<<<<<< mine (bob)` / `>>>>>>> session (alice)`), not any seven `<` in a file.

### `src/merge-ai.js` — one AI attempt per file

- `findMergeCli() → [cmd, args] | null` honours `QUILT_MERGE_CMD`, else the first of
  `claude`, `codex`, `cursor-agent` found with `claudeCli()` / `which`-style lookup.
- `aiMerge({ path, base, ours, theirs, mine, theirsBy, run }) → Promise<{ text } | { refused: reason }>`
  builds the prompt (the three versions in fenced blocks, the rule "keep every change
  from both sides; change no behaviour; if they cannot both be true, answer exactly
  `CONFLICT: <why>`"), runs the CLI with the same `runCli` shape as `summarize.js`
  (stdin prompt, temp cwd, timeout), and parses the answer: a fenced block with the
  whole file, or `CONFLICT:`. Anything else is a refusal. A result is also refused
  when it drops any line both ours and theirs kept from base (a cheap sanity check:
  the merge may not lose text neither side touched).

### `src/merges.js` — shared merge records

Same shape as `tasks.js`: plain objects in `doc.getMap('merges')`, validated on read.

```
{ id, path, by, byId, others: [names], ts,
  kind: 'conflict' | 'ai' | 'claimed',
  state: 'open' | 'editing' | 'done',
  ours: text | null, base: text | null, theirsHash, binary: bool,
  claimedBy?, resolvedBy?, how?: 'mine'|'theirs'|'hand'|'agent'|'review', doneTs? }
```

`ours` and `base` are capped at 200 KB each; over that they are kept only in
`.quilt/merges/<id>/` on the returning person's machine and the record says
`local: true`. Done records are dropped after 24 h or when more than 50 exist.

Exports: `readMerges`, `openMerge`, `updateMerge`, `pruneMerges`, `publicMerge`.

### `src/session.js` — the rejoin flow

`start()`'s `hadState` branch becomes:

1. `const offline = this.captureOffline()` — for every path on disk or in the stale doc:
   `{ rel, base: stale text | null, ours: disk text | null, binary }` where ours ≠ base.
   Nothing is pushed. Large-file downloads and `take` cases keep their current logic.
2. Connect; `await this.conn.waitForSync()` (with the same pending/timeout handling the
   first-join branch has).
3. `await this.mergeOffline(offline)` — per entry, with `theirs` read from the doc now:
   - `theirs === base` → push ours (`ingest`), as today.
   - `ours === theirs` → nothing but `lastKnown`.
   - claimed by someone else → open a `claimed` record; theirs stays on disk.
   - binary, or ours/theirs is a delete → conflict record; theirs written to disk.
   - `merge3` clean → write result to doc (`applyTextDiff`, origin `LOCAL`) and disk.
   - overlap → `aiMerge`; accepted → write like clean plus an `ai` record for review;
     refused → conflict record; theirs written to disk, ours saved to `.quilt/merges/<id>/`.
4. `goLive()`, then `startWatcher()`.

New methods: `mergeList()`, `resolveMerge(id, { how, text? })` (writes the chosen text
to doc and disk, or markers for `hand`, and updates the record), `prepareMergeSend(id)`
(writes the three versions and `PROMPT.md`, returns the prompt). An `ingest` of a file
whose open record is `editing` and whose disk text has no markers closes the record.

`status()` gains `merges: this.mergeList()` so the UI and MCP see them; the `merges`
map is observed for `scheduleStatusWrite` like tasks.

### Relay (`src/server.js`)

`merges` is a new top-level map. `checkChange` already ignores maps other than
`files`, `blobs` and `fileKeys`, so no guard change is needed; viewers cannot write
files anyway, which is where the resolution lands.

### Daemon and MCP (`src/control.js`, `src/mcp.js`, `src/ui-server.js`)

- `GET /merges` → `{ merges }`.
- `POST /merges/resolve { id, how, text? }`.
- `POST /merges/send { id, app }` → runs `prepareMergeSend`, then `openIn(app, root, { prompt })`.
- MCP tools `quilt_merges` and `quilt_resolve_merge { id, how: 'agent' }` (the agent
  writes the file itself first).
- UI server routes mirror these under `/api/sessions/:id/merges…`.

`editors.js`: `openIn(id, dir, { prompt })` — Claude: the prompt becomes the new
session's first message; others: open the folder and copy the prompt to the clipboard
(`pbcopy` / `clip`), returning `{ copied: true }` so the UI can say so.

### UI (`src/ui/`)

- **Merge bar** (`src/ui/merges.js`), rendered into a new `#merges` div under
  `#requests`, from `status.merges`. One row per open record: path, "you changed this
  offline, alice changed it in the session" (or "merged by AI, have a look"), and the
  buttons **Keep mine · Keep theirs · Edit by hand · Send to ▾ (installed editors)**,
  plus **Resolved** while `editing`, and **Looks fine** for `ai` rows.
- Clicking the path opens a **merge view** in the main pane (a new tab kind,
  `merge:<id>`, in `fileview.js` style): ours and theirs side by side, each diffed
  against base with changed lines highlighted; the same buttons at the top.
- A toast and a log line when a rejoin opens conflicts: "2 files need merging".

### Hooks (`src/hooks.js`)

`SessionStart` context mentions open merge conflicts in this folder and that
`quilt_merges` lists them. Nothing else changes; `PreToolUse` claims still gate the
agent's write when it resolves a conflict.

## Error handling

- Relay never syncs (offline rejoin): after the existing timeout the session starts
  as today with the captured list held; the merge runs on the first `synced` event.
  Local edits meanwhile are watched normally; a path edited again before the merge
  re-reads ours from disk at merge time.
- AI CLI missing or not signed in: logged once per session ("merges go straight to
  conflicts: claude isn't installed"), no retry storm.
- A `merges` record whose shape is not what `publicMerge` expects is ignored.
- Resolving an already-done record returns an error; two people resolving at once:
  last write wins on the record, and the file holds the last resolver's text, which is
  the same outcome as any two concurrent edits.

## Testing

`test/merge3.test.js`: clean merges on separate regions, adjacent regions, overlap →
conflicts, CRLF, missing trailing newline, markers round-trip, `hasMarkers`.

`test/merge-ai.test.js`: with `QUILT_MERGE_CMD` pointing at a small script: returns
a file → accepted; returns `CONFLICT:` → refused; drops an untouched line → refused;
times out → refused.

`test/sync.test.js` (real relay, alice + bob, bob leaves and returns), with
`QUILT_MERGE_CMD` set to a script that always answers `CONFLICT:` unless the test says
otherwise:
- separate regions merge cleanly and both folders agree (today's test, kept)
- same lines → conflict record open for both, alice's version on both disks, bob's in
  `.quilt/merges/<id>/ours`
- AI script returns a merge → applied on both sides, an `ai` record for review
- bob deleted, alice edited → conflict; keep theirs restores it, keep mine deletes it
- binary changed on both → conflict
- file claimed by alice → `claimed` record, alice's version kept
- `resolveMerge` with `mine`, `theirs`, `hand` (markers appear, saving without markers
  closes it), and `agent`
- records prune after `done`

`test/hooks.test.js`: SessionStart mentions an open merge.

UI: checked by hand in the app with two folders (no UI test harness exists).
