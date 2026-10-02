# Chronology, pickup briefs and evidence before Done: design

Date: 2026-10-02
Status: decided; built in the same session (branch `chronology`)

## Goal

Any AI working a ticket in a Quilt session, whatever tool it runs in, should know
what changed around the files it is about to touch, should be told the project's own
checks when it starts, and should not be able to call a ticket Done without saying what
it ran and what it saw.

The trigger: a connected agent (Cursor) shipped a change that broke the app because a
new UI module was missing from the UI server's static allowlist. Unit tests passed; the
app was never launched. The "grok → plan → build → test" reminder was already in place
and did not help, because "test" meant "the tests you touched", and nothing told the
agent this project's real check. Nothing is specific to that agent: the fixes live in
the shared board's MCP tools, which every AI goes through.

## Decisions

| Question | Decision |
|---|---|
| Where the record of changes lives | A `history` array in the shared doc: `{ id, by, path, kind, ts, from, added, removed, detail, task, diff }`. Everyone, including hosted agents, reads the same record. |
| What a change carries | A unified line diff capped at 6 KB per entry, line counts, and the In-progress task the author was working (the person's, or their AI's when the AI is working). Binaries carry a byte count and no diff. |
| Bursts | Saves to one file by one person within 20 s fold into one entry whose diff spans the burst; a file created then saved again stays "created". |
| Size | 2000 entries and 1.5 MB of diff text, oldest dropped first. |
| Who writes it | The local session's disk-change path (`Session.recordActivity`) and the hosted `quilt_write_file`. The older `activity` log stays as it was. |
| Querying | `quilt_history` on both MCP servers and `quilt history` in the CLI: path (exact, folder prefix ending in `/`, or glob), person, task id, since (`2h`, `3d`, `today`, `yesterday`, a date), diffs on request. Oldest first; `limit` keeps the newest. |
| The project's checks | A `## Verifying a change` section in `AGENTS.md` (or `CLAUDE.md`), outside Quilt's managed block so owners edit it. `quilt setup` scaffolds a template once when neither file has one. Hosted agents read it from the shared files. |
| Pickup brief | Moving a ticket to In progress through an MCP tool answers with: files, the last eight chronology entries for them (or for the project when it lists none), other people's claims touching them, the workflow, and the checks. |
| Done needs evidence | `quilt_move_task` to `done` requires `verified` (12+ characters after trimming) or is refused with the checks quoted. Stored on the task, shown on the board card and in `quilt_tasks`, cleared when the task leaves Done. Moves made in the app's UI are not gated. |
| Allowlist regression | A test asserts every module the UI imports is in `STATIC` in `src/ui-server.js`, so this particular break cannot recur silently. |

## Pieces

- `src/history.js`: `lineDiff`, `HistoryLog` (record, fold, trim), `queryHistory`,
  `parseSince`, `formatHistory`, `currentTask`.
- `src/agent-task-workflow.js`: `TASK_WORKFLOW` (now ends with the Done rule),
  `CHECKLIST_SCAFFOLD`, `extractChecklist`, `pickChecklist`, `pickupBrief`,
  `doneRefusal`, `verifiedEnough`, `verifiedLine`.
- `src/tasks.js`: the `verified` field, cleaned like titles; shown for Done tasks in
  both text renderings.
- `src/session.js`: `history`, `currentTask`, `historyQuery`, `readChecklist`,
  `taskBrief`. `src/control.js`: `POST /history`, `POST /tasks/brief`.
- `src/mcp.js`, `src/relay-mcp.js`: `quilt_history`; `quilt_move_task` with `verified`,
  the brief and the refusal. Instructions mention `quilt_history`.
- `src/setup.js`: `scaffoldChecklist`; the guide block states the Done rule.
- `src/ui/board.js`, `src/ui/app.css`: the evidence line on Done cards.
- `AGENTS.md` in this repo carries Quilt's own checklist.

## Testing

`test/history.test.js`, `test/agent-task-workflow.test.js`, `test/tasks.test.js`
(verified), `test/relay-hosted-mcp.test.js` (chronology across hosted and local edits;
brief contents; Done refused without evidence), `test/board-verified.test.js`,
`test/ui-static-allowlist.test.js`.

## Out of scope

Showing the chronology in the app's UI; a Claude Code `Stop` hook that asks for
evidence; recording a "lesson" into the checklist when a human fixes an agent's break.
