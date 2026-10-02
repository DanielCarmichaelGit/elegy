# Claim before edit: design

Date: 2026-10-02
Status: decided; built in the same session

## Goal

No AI edits a shared file without holding a claim on it, and claims go away when the
AI is done. When an AI is refused because someone else holds the file, it asks that
person's AI for help instead of fighting, and that AI sees the request.

Today claims exist and are enforced after the fact: Quilt reverts edits to a file
someone else claimed. What's missing is the gate in front of the edit, automatic
release, and the conversation between the two AIs.

## Decisions

| Question | Decision |
|---|---|
| Where the gate lives | Claude Code hooks (`PreToolUse` on Edit, Write, MultiEdit, NotebookEdit) running `quilt hook`. Other tools keep the existing revert enforcement and the written guidance. |
| Claim first: block or auto-claim? | Auto-claim the file for this person when nobody holds it; refuse the edit when someone else does. Nobody has to remember to call `quilt_claim`. |
| Release | Claims the hooks made are released when Claude finishes its turn (`Stop`) and when the session ends (`SessionEnd`). Claims made explicitly with `quilt_claim` / `quilt claim` are never touched. |
| When refused | The refusal tells the AI who holds the file and why, and to send them a direct message with `quilt_message` saying what it wanted to change and asking for help, then carry on with other work. |
| The holder's AI sees it | Unread direct messages are handed to the holder's Claude as extra context after its next edit, and if it tries to finish with an unanswered one, the `Stop` hook asks it to reply first (once). |
| Installing the hooks | Written into the project's `.claude/settings.json` when a session starts and by `quilt setup`. The file is shared, so everyone in the session gets the same rule. |
| Stale claims | Hook claims are also released when a session for the folder starts (leftovers from a crashed Claude). People can always release from the app's file menu or `quilt release '*'`. |

## Pieces

### `quilt hook` (`src/hooks.js`)

Reads Claude Code's hook JSON from stdin and acts on `hook_event_name`. It finds the
running session with `findDaemon(cwd)`; with no session it does nothing (exit 0), so
the hooks are harmless outside Quilt. Every daemon call has a 5 second timeout.

- **SessionStart:** `additionalContext` naming the room, who is online, and the rule
  (files are claimed as you edit them and released when you finish; a refusal means
  message the holder).
- **PreToolUse:** resolve `tool_input.file_path` (or `notebook_path`) against the
  project folder. Outside the project or not a shared path: allow. Claimed by me:
  allow. Claimed by someone else: deny with the holder, their note, and the
  instructions above. Unclaimed: claim the exact path (note: `editing`, or
  `editing: <focus>` when a focus is set), remember it in the hook state, allow. A
  claim the relay refuses (a race, or an overlapping glob) is reported like a claim by
  someone else.
- **PostToolUse:** unread direct messages to me that this Claude session hasn't seen go
  into `additionalContext`, with a one-line hint on how to answer (help, hand over the
  file with `quilt_release`, or say when you'll be done).
- **Stop:** with unseen direct messages and `stop_hook_active` false: block, listing
  them, and ask Claude to reply before finishing. Otherwise release this session's hook
  claims and exit 0.
- **SessionEnd:** release this session's hook claims and delete its state file.

Hook state: `.quilt/hooks/<session_id>.json` as `{ claims: [patterns], seen: [message ids] }`.
Messages are not marked read for the person; "seen" is per Claude session, so the app
still shows them as unread for the human.

### Daemon routes (`src/control.js`)

- `POST /claim-for { path }` → `{ path, shared, claim: { by, pattern, note } | null, mine, me, focus }`
  using `Session.claimFor`, so the hook and the sync code agree on who owns a glob.
- `POST /messages` gains `markRead` (default true; the hooks send false).

### Installing (`src/setup.js`, `src/runner.js`)

`installHooks(root)` upserts Quilt's entries into `.claude/settings.json` under
`hooks`, replacing any earlier Quilt entries (recognised by their command starting
with `quilt hook`) and leaving other hooks alone. `setup()` calls it; `runSession`
calls it after the session starts, logging once when it changed anything, and releases
leftover hook claims from `.quilt/hooks/*.json`.

The agent guide text says that in Claude Code claims happen automatically, and
describes the ask-for-help step.

## Testing

`test/hooks.test.js`: a relay, two sessions (dana with a control daemon, sam), and
the real `quilt hook` run with stdin JSON in dana's folder:

- an edit to an unclaimed file is allowed and dana now holds the claim;
- an edit to sam's claimed file is denied, naming sam and telling Claude to message him;
- sam's direct message is delivered once after an edit and not again;
- Stop blocks once over an unseen message, then releases the hook claims;
- SessionEnd releases; a file outside the project or an ignored path is allowed without a claim;
- `installHooks` keeps other hooks, replaces Quilt's, and is idempotent.

## Out of scope

Cursor hooks (Cursor can only observe edits after the fact; the revert still protects
claimed files there), hooks for hosted agents (they have no file tools yet), and a
setting to turn the gate off.
