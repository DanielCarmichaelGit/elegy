# Claims follow edits, in every tool: design

Date: 2026-10-02
Status: decided; built in the same session

## Goal

Two AIs must not overwrite each other's work, whatever tool each runs in. The Claude Code
hooks (see the claim-before-edit design) gate edits before they happen, but only in Claude
Code. Cursor, Codex, Windsurf, terminal agents and hosted agents had only the written rule
("claim before larger changes") and the after-the-fact revert, and nobody remembered to claim.

## Where the gate can live

The only thing every agent passes through is Quilt's own sync: a local tool writes to disk,
the session's watcher sees it; a hosted agent writes through `quilt_write_file`. So claims
are made there, automatically, and the existing enforcement (a change to a file someone else
holds is undone and never shared) becomes the gate for everyone.

## Decisions

| Question | Decision |
|---|---|
| When a local edit claims | The watcher sees a change of ours to a shared file that nobody holds (or that we already auto-hold), after the initial sync, and our AI may be the one editing. The session claims the exact path with note `editing` or `editing: <focus>`. |
| "Our AI may be editing" | True for an agent session (`kind: 'agent'`), and for a person unless the agent readers say their AI is `idle`. A person typing by hand while their AI sits idle keeps editing live with everyone; when Quilt can't read the tool (no reader, or `unavailable`), the safe side is taken and the edit is claimed. |
| Release | When the AI goes from `working` to not working (the readers' turn end), when the file has been quiet for `autoClaimQuietMs` (5 minutes; a timer checks), and at `stop()` (2 s budget). Claims made on purpose (`quilt_claim`, the app's menu, `quilt claim`) are never touched; claiming by hand a path Quilt auto-claimed makes it a hand claim. |
| Losing the race | Two people edit an unclaimed file at once: both ask; the relay grants one. The loser logs it and drops the path from its auto-claims; the winner's session reverts the partner's change as for any claimed file. |
| Telling the losing AI | `rejectClaimed` queues a notice on the session ("Your change to X was undone: it is claimed by Y (note). Do not retry… send Y a direct message with quilt_message…"). The daemon's `POST /notices` hands them over once; the local MCP server prepends pending notices to its next tool answer, whatever the tool. Claude Code additionally has the hooks' pre-edit refusal. |
| Hosted agents | `quilt_write_file` to an unclaimed file claims it for the agent (`editing`), says so once in the reply, and a per-path timer releases it after 10 quiet minutes unless `quilt_claim`ed by hand; `quilt_release` clears the timer. Writes to someone else's file are refused with the same advice. |
| Guidance | AGENTS.md / CLAUDE.md (`src/setup.js`), the local MCP instructions and the hosted ones say claims follow edits, to claim ahead only for larger multi-file changes, and what a refused or undone edit means. |

## Pieces

- `src/session.js`: `autoClaims` (path → last edit), `autoClaim(rel)`, `releaseAutoClaims(only)`,
  `releaseQuietAutoClaims()` on a timer, `aiMayBeEditing()`, the hook in `ingest`, release on the
  `working → idle` transition in `setAgentState` and in `stop()`; `notices`, `notice(text)`,
  `takeNotices()`; `claim()` forgets the auto-claim for a pattern claimed by hand.
- `src/control.js`: `POST /notices`.
- `src/mcp.js`: `withDaemon` prepends pending notices.
- `src/relay-mcp.js`: `autoHeld` timers; `quilt_write_file`, `quilt_claim`, `quilt_release`.

## Testing

`test/auto-claim.test.js` (two sessions and a relay): a change claims the file with the focus
as note; a change to a partner's file is undone and queues one notice; the daemon hands notices
over once; idle releases auto-claims and leaves hand claims; a hand claim over an auto-claim is
kept; the quiet timer releases; `stop()` releases only auto-claims; a person whose AI is idle is
not claimed for while an unknown tool is; unsynced paths are never claimed. `test/sync.test.js`
and the hosted test mark their people as typing by hand (`idle`) where edits are meant to merge.
`test/relay-hosted-mcp.test.js`: a hosted write claims the file, says so once, the owner's hand
edit is undone with a notice, and `quilt_release` frees it.

## Out of scope

Pre-edit refusal for tools without hooks (Cursor's hooks run after an edit; the revert stays),
and a per-session switch to turn automatic claims off.
