# Offline Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When someone rejoins a session after editing offline, their changes are three-way merged with the session's; overlaps go to their AI; true conflicts become shared merge records anyone can resolve by hand or send to a coding tool.

**Architecture:** On rejoin, `Session` captures base (stale doc) and ours (disk) per changed file, keeps those paths out of normal sync (`this.merging`), lets the relay sync, then merges each against theirs. Clean merges and AI merges are written to the doc and disk. Everything else opens a record in a new `merges` Y.Map, read by the UI (merge bar + compare view), the daemon routes, and MCP tools. "Send to <tool>" writes the three versions and a prompt into `.quilt/merges/<id>/` and launches the editor.

**Tech Stack:** Node 22 ESM, Yjs, `node-diff3` (new dependency), `node:test`, Claude Code CLI (`claude -p`) with `QUILT_MERGE_CMD` override, plain ES-module UI in `src/ui/`.

**Spec:** `docs/superpowers/specs/2026-10-01-offline-merge-design.md`

## Global Constraints

- Node `>=22`, ESM, no bundler: UI files in `src/ui/` must run as plain browser modules (no npm imports there).
- Tests run with `node --test test/*.test.js`; a single file runs with `node --test test/<file>`.
- Record text caps: `ours` and `base` ≤ 200 KB each inside a shared record; above that `local: true`.
- AI step limits: skip files > 200 KB, binaries, or > 20 overlapping hunks; 90 s timeout per file; at most 2 files at once.
- Done records pruned after 24 h or when more than 50 records exist.
- Conflict markers are labelled `<<<<<<< mine (<name>)`, `=======`, `>>>>>>> session (<name>)`.
- Log lines use the existing emoji style (`⚠️`, `🔒`, `✅`); copy is plain English, no jargon.
- First join (`reconcileFirstJoin`) and `.quilt/rejected` / `.quilt/conflicts` behaviour are unchanged.
- `src/hooks.js` is not on this branch (it lives on `claim-before-edit`); the spec's SessionStart note is **out of scope here** and is listed at the end as follow-up.
- This branch is a worktree at `.claude/worktrees/offline-merge`; commit after every task.

---

## File map

| File | Responsibility |
|---|---|
| `src/merge3.js` (new) | Pure three-way text merge, conflict markers, marker detection |
| `src/merge-ai.js` (new) | One headless AI merge attempt per file; CLI discovery; result checks |
| `src/merges.js` (new) | Shared merge records in the Y.Map `merges`: validate, open, update, prune |
| `src/session.js` | Rejoin flow (`captureOffline`, `mergeOffline`, `mergeOne`), `applyMerged`, `openMerge`, `resolveMerge`, `prepareMergeSend`, `mergeList`, status |
| `src/control.js` | `GET /merges`, `POST /merges/resolve`, `POST /merges/send` |
| `src/mcp.js` | `quilt_merges`, `quilt_resolve_merge` |
| `src/status.js` | "Merges" section in the status markdown |
| `src/editors.js` | `openIn(id, dir, { prompt })` |
| `src/ui-server.js` | `/api/sessions/:id/merges`, `…/merges/resolve`, `…/merges/send` |
| `src/ui/merges.js` (new) | Merge bar and compare view |
| `src/ui/session.js`, `src/ui/app.css` | Mount the bar, the `merge` main-pane mode, styles |
| `RELEASES.md` | Release note bullet |
| `test/merge3.test.js`, `test/merge-ai.test.js`, `test/merges.test.js` (new), `test/sync.test.js`, `test/mcp.test.js`, `test/editors.test.js` | Tests |

---

### Task 1: Three-way merge module

**Files:**
- Create: `src/merge3.js`
- Test: `test/merge3.test.js`
- Modify: `package.json` (add `node-diff3`)

**Interfaces:**
- Produces: `merge3(base, ours, theirs) → { text: string, conflicts: Array<{ base: string[], ours: string[], theirs: string[] }> }`; `withMarkers(base, ours, theirs, { mine, theirs: name }) → string`; `hasMarkers(text) → boolean`; `MARK = { start: '<<<<<<< mine', mid: '=======', end: '>>>>>>> session' }`.

- [ ] **Step 1: Install the dependency**

```bash
cd /Users/danielcarmichael/elegy/.claude/worktrees/offline-merge && npm install node-diff3@^3.2.1 --no-audit --no-fund
```

`node_modules` is a symlink to the main checkout's, so the package lands there too; that is fine. Confirm `package.json` now lists `"node-diff3": "^3.2.1"` under `dependencies`.

- [ ] **Step 2: Write the failing tests**

`test/merge3.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { merge3, withMarkers, hasMarkers } from '../src/merge3.js'

const base = 'top\nmiddle\nbottom\n'

test('changes to different lines merge cleanly', () => {
  const r = merge3(base, 'top (bob)\nmiddle\nbottom\n', 'top\nmiddle\nbottom (alice)\n')
  assert.equal(r.text, 'top (bob)\nmiddle\nbottom (alice)\n')
  assert.deepEqual(r.conflicts, [])
})

test('one side unchanged takes the other side whole', () => {
  assert.equal(merge3(base, base, 'x\n').text, 'x\n')
  assert.equal(merge3(base, 'y\n', base).text, 'y\n')
})

test('both sides changing the same line is a conflict', () => {
  const r = merge3(base, 'top\nmiddle (bob)\nbottom\n', 'top\nmiddle (alice)\nbottom\n')
  assert.equal(r.conflicts.length, 1)
  assert.deepEqual(r.conflicts[0], { base: ['middle'], ours: ['middle (bob)'], theirs: ['middle (alice)'] })
})

test('both sides making the same change is not a conflict', () => {
  const same = 'top\nmiddle!\nbottom\n'
  const r = merge3(base, same, same)
  assert.equal(r.text, same)
  assert.deepEqual(r.conflicts, [])
})

test('an empty base (both sides created the file) conflicts unless identical', () => {
  assert.equal(merge3('', 'a\n', 'a\n').conflicts.length, 0)
  assert.equal(merge3('', 'a\n', 'b\n').conflicts.length, 1)
})

test('CRLF files keep their line endings', () => {
  const b = 'top\r\nmiddle\r\nbottom\r\n'
  const r = merge3(b, 'top (bob)\r\nmiddle\r\nbottom\r\n', 'top\r\nmiddle\r\nbottom (alice)\r\n')
  assert.equal(r.text, 'top (bob)\r\nmiddle\r\nbottom (alice)\r\n')
})

test('a file without a trailing newline stays that way', () => {
  const r = merge3('a\nb', 'a!\nb', 'a\nb!')
  assert.equal(r.text, 'a!\nb!')
})

test('markers are git style and labelled with names', () => {
  const text = withMarkers(base, 'top\nmiddle (bob)\nbottom\n', 'top\nmiddle (alice)\nbottom\n', { mine: 'bob', theirs: 'alice' })
  assert.equal(text, 'top\n<<<<<<< mine (bob)\nmiddle (bob)\n=======\nmiddle (alice)\n>>>>>>> session (alice)\nbottom\n')
  assert.ok(hasMarkers(text))
  assert.ok(!hasMarkers(base))
  assert.ok(!hasMarkers('<<<<<<< not ours\nx\n'), 'only Quilt’s own markers count')
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `node --test test/merge3.test.js`
Expected: FAIL, "Cannot find module '../src/merge3.js'".

- [ ] **Step 4: Implement `src/merge3.js`**

```js
// Three-way merge of text, line by line, the way git does it: changes to
// different lines combine on their own; the same lines changed on both sides
// are a conflict. Used when someone comes back to a session after editing
// offline (base: what they last had; ours: their disk; theirs: the session).
import { diff3Merge } from 'node-diff3'

export const MARK = { start: '<<<<<<< mine', mid: '=======', end: '>>>>>>> session' }

const lines = (s) => s.split('\n')

/**
 * Merges ours and theirs against base. `conflicts` is empty when the merge
 * is clean; `text` then holds the merged file. With conflicts, `text` holds
 * the merge with ours taken for each conflicted region (callers decide what
 * to do with it; see withMarkers).
 */
export function merge3 (base, ours, theirs) {
  const regions = diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true })
  const out = []
  const conflicts = []
  for (const r of regions) {
    if (r.ok) { out.push(...r.ok); continue }
    const c = r.conflict
    conflicts.push({ base: c.o, ours: c.a, theirs: c.b })
    out.push(...c.a)
  }
  return { text: out.join('\n'), conflicts }
}

/** The merge written out with git-style markers around each conflict, labelled with people's names. */
export function withMarkers (base, ours, theirs, names) {
  const regions = diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true })
  const out = []
  for (const r of regions) {
    if (r.ok) { out.push(...r.ok); continue }
    out.push(`${MARK.start} (${names.mine})`, ...r.conflict.a, MARK.mid, ...r.conflict.b, `${MARK.end} (${names.theirs})`)
  }
  return out.join('\n')
}

/** True when the text still holds markers that withMarkers put there. */
export function hasMarkers (text) {
  return typeof text === 'string' && text.split('\n').some((l) => l.startsWith(`${MARK.start} (`) || l.startsWith(`${MARK.end} (`))
}
```

Line endings: splitting on `\n` leaves `\r` attached to each line, so CRLF files round-trip unchanged. A missing trailing newline round-trips because the last element after `split` is the last line, not `''`.

- [ ] **Step 5: Run the tests**

Run: `node --test test/merge3.test.js`
Expected: all 8 PASS. If the "same change on both sides" test fails, the `excludeFalseConflicts` option is missing.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/merge3.js test/merge3.test.js
git commit -m "Three-way text merge for offline edits

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: One AI merge attempt per file

**Files:**
- Create: `src/merge-ai.js`
- Test: `test/merge-ai.test.js`

**Interfaces:**
- Consumes: `merge3` (Task 1) for the sanity check; `claudeCli()` from `src/editors.js`.
- Produces: `findMergeCli({ env, exists }) → { cmd, args } | null`; `aiMerge({ path, base, ours, theirs, mine, theirsBy, run }) → Promise<{ text } | { refused: string }>`; `MERGE_AI_LIMITS = { maxBytes: 200_000, maxHunks: 20, timeoutMs: 90_000 }`; `mergePrompt(opts) → string`.

- [ ] **Step 1: Write the failing tests**

`test/merge-ai.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aiMerge, findMergeCli, mergePrompt } from '../src/merge-ai.js'

const base = 'function add (a, b) {\n  return a + b\n}\n'
const ours = 'function add (a, b) {\n  // bob: guard\n  return a + b\n}\n'
const theirs = 'function add (a, b) {\n  return Number(a) + Number(b)\n}\n'
const opts = { path: 'src/add.js', base, ours, theirs, mine: 'bob', theirsBy: 'alice' }

test('the prompt carries all three versions and the rule', () => {
  const p = mergePrompt(opts)
  assert.match(p, /src\/add\.js/)
  assert.match(p, /bob/)
  assert.match(p, /alice/)
  assert.ok(p.includes(base) && p.includes(ours) && p.includes(theirs))
  assert.match(p, /CONFLICT:/)
})

test('a fenced file in the answer is accepted', async () => {
  const merged = 'function add (a, b) {\n  // bob: guard\n  return Number(a) + Number(b)\n}\n'
  const run = async () => '```\n' + merged + '```\n'
  assert.deepEqual(await aiMerge({ ...opts, run }), { text: merged })
})

test('CONFLICT answers are refused with the reason', async () => {
  const run = async () => 'CONFLICT: both sides rewrote the return statement differently'
  assert.deepEqual(await aiMerge({ ...opts, run }), { refused: 'both sides rewrote the return statement differently' })
})

test('an answer that drops a line nobody touched is refused', async () => {
  const run = async () => '```\nfunction add (a, b) {\n  return Number(a) + Number(b)\n```\n'
  const r = await aiMerge({ ...opts, run })
  assert.match(r.refused, /dropped/)
})

test('an answer without a fenced file is refused', async () => {
  const r = await aiMerge({ ...opts, run: async () => 'Sure! Here is my thinking…' })
  assert.match(r.refused, /no file/)
})

test('a failing or slow command is refused, never thrown', async () => {
  const r = await aiMerge({ ...opts, run: async () => { throw new Error('timed out') } })
  assert.equal(r.refused, 'timed out')
})

test('files too big or binary are refused without running anything', async () => {
  let ran = false
  const run = async () => { ran = true; return '' }
  const big = 'x'.repeat(200_001)
  assert.match((await aiMerge({ ...opts, ours: big, run })).refused, /too large/)
  assert.equal(ran, false)
})

test('QUILT_MERGE_CMD wins; otherwise the first installed CLI', () => {
  assert.deepEqual(findMergeCli({ env: { QUILT_MERGE_CMD: 'node fake.js --x' }, exists: () => false }), { cmd: 'node', args: ['fake.js', '--x'] })
  const exists = (p) => p.endsWith('/codex')
  assert.deepEqual(findMergeCli({ env: { PATH: '/usr/bin' }, exists, claude: () => null }), { cmd: '/usr/bin/codex', args: ['exec', '--full-auto', '-'] })
  assert.equal(findMergeCli({ env: { PATH: '/usr/bin' }, exists: () => false, claude: () => null }), null)
})
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test test/merge-ai.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `src/merge-ai.js`**

```js
// When a three-way merge overlaps, the returning person's own AI tool gets
// one go at combining both sides without changing what the code does. It
// runs headless (claude -p, codex exec, cursor-agent -p) with the three
// versions on stdin and answers with the whole file, or CONFLICT: when the
// two sides cannot both be true. Anything doubtful is refused and becomes a
// merge conflict for people to settle.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { claudeCli } from './editors.js'
import { merge3 } from './merge3.js'

export const MERGE_AI_LIMITS = { maxBytes: 200_000, maxHunks: 20, timeoutMs: 90_000 }

const CLIS = [
  { exe: 'claude', args: ['-p', '--no-session-persistence'] },
  { exe: 'codex', args: ['exec', '--full-auto', '-'] },
  { exe: 'cursor-agent', args: ['-p'] }
]

/** The headless command to merge with: QUILT_MERGE_CMD, else the first of claude, codex, cursor-agent that is installed. */
export function findMergeCli ({ env = process.env, exists = fs.existsSync, claude = claudeCli } = {}) {
  const custom = env.QUILT_MERGE_CMD
  if (custom) {
    const [cmd, ...args] = custom.split(' ').filter(Boolean)
    return { cmd, args }
  }
  for (const c of CLIS) {
    if (c.exe === 'claude') {
      const found = claude({ exists })
      if (found) return { cmd: found, args: c.args }
      continue
    }
    for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
      const p = path.join(dir, c.exe)
      if (exists(p)) return { cmd: p, args: c.args }
    }
  }
  return null
}
```

Note: `claudeCli` already searches `~/.local/bin`, `/opt/homebrew/bin` and `PATH`, and the Claude app bundle; passing `{ exists }` through keeps it testable (it accepts `exists` in its options object).

Then the rest of the module:

```js
export function mergePrompt ({ path: rel, base, ours, theirs, mine, theirsBy }) {
  const fence = (label, text) => `${label}:\n\`\`\`\n${text}\`\`\`\n`
  return `You are merging two people's edits to one file, \`${rel}\`, in a shared coding session.
${mine} edited it offline. Meanwhile ${theirsBy || 'someone in the session'} edited it in the session. Both started from BASE.

Rules:
- Produce the file with EVERY change from BOTH versions kept, and nothing else changed.
- Do not change what the code does, rename anything, reformat, or "improve" it.
- Keep the file's line endings and trailing newline as they are.
- If the two versions cannot both be true (they change the same thing in incompatible ways), answer with exactly one line: CONFLICT: <why, in one sentence>
- Otherwise answer with ONLY the whole merged file inside one \`\`\` fenced block. No words before or after it.

${fence('BASE', base)}
${fence(`${mine.toUpperCase()}'S VERSION (offline)`, ours)}
${fence(`SESSION VERSION (${theirsBy || 'others'})`, theirs)}`
}

/** Runs a command with text on stdin, in a temp folder so it never counts as a chat in the project. */
function runCli ({ cmd, args }, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: os.tmpdir(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timed out')) }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error(`${cmd} is not installed`) : e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error((err || out).trim().split('\n').pop() || `${cmd} exited with ${code}`))
    })
    child.stdin.end(input)
  })
}

/** The fenced file in an answer, or null. Accepts an optional language tag after the opening fence. */
function fencedFile (answer) {
  const m = /```[^\n]*\n([\s\S]*?)```/.exec(answer)
  return m ? m[1] : null
}

/**
 * Lines both sides kept from base must survive the merge; a merge that
 * drops one lost something nobody changed. Returns the first such line, or null.
 */
function droppedLine (base, ours, theirs, merged) {
  const { text } = merge3(base, ours, theirs)
  const keep = new Set(text.split('\n'))
  const have = new Set(merged.split('\n'))
  for (const line of base.split('\n')) if (line.trim() && keep.has(line) && !have.has(line)) return line
  return null
}

/**
 * One attempt at merging with the AI. Resolves to { text } or { refused: reason };
 * never throws. `run(cli, input, timeoutMs)` is for tests; `cli` defaults to findMergeCli().
 */
export async function aiMerge ({ path: rel, base, ours, theirs, mine, theirsBy, run = runCli, cli = null, limits = MERGE_AI_LIMITS }) {
  for (const [label, t] of [['base', base], ['your version', ours], ['the session version', theirs]]) {
    if (Buffer.byteLength(t, 'utf8') > limits.maxBytes) return { refused: `${label} is too large for the AI to merge` }
  }
  if (merge3(base, ours, theirs).conflicts.length > limits.maxHunks) return { refused: 'too many overlapping changes for the AI to merge' }
  const command = cli || findMergeCli()
  if (!command) return { refused: 'no AI tool is installed to merge with (claude, codex or cursor-agent)' }
  let answer
  try {
    answer = await run(command, mergePrompt({ path: rel, base, ours, theirs, mine, theirsBy }), limits.timeoutMs)
  } catch (err) {
    return { refused: err.message }
  }
  const conflict = /^\s*CONFLICT:\s*(.*)$/m.exec(answer)
  if (conflict) return { refused: conflict[1].trim() || 'the AI says the changes conflict' }
  const text = fencedFile(answer)
  if (text === null) return { refused: 'the AI gave no file back' }
  const dropped = droppedLine(base, ours, theirs, text)
  if (dropped !== null) return { refused: `the AI's merge dropped a line nobody changed: ${dropped.trim().slice(0, 60)}` }
  return { text }
}
```

The `findMergeCli` test expects `{ cmd: '/usr/bin/codex', args: ['exec', '--full-auto', '-'] }` with `claude: () => null`; that matches the `CLIS` table.

- [ ] **Step 4: Run the tests**

Run: `node --test test/merge-ai.test.js`
Expected: 8 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/merge-ai.js test/merge-ai.test.js
git commit -m "Headless AI merge attempt for overlapping offline edits

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Shared merge records

**Files:**
- Create: `src/merges.js`
- Test: `test/merges.test.js`

**Interfaces:**
- Produces:
  - `publicMerge(value) → record | null` (validated plain object)
  - `readMerges(map) → record[]` (open first, then by ts)
  - `openMerge(doc, map, fields, origin) → record` with fields `{ path, by, byId, others, kind, ours, base, theirsHash, binary }`
  - `updateMerge(doc, map, id, patch, origin) → record` (throws `no such merge`)
  - `pruneMerges(doc, map, origin, now = Date.now())`
  - Constants `MAX_RECORD_TEXT = 200_000`, `MAX_MERGES = 50`, `DONE_TTL_MS = 24 * 60 * 60 * 1000`, `KINDS = ['conflict', 'ai', 'claimed']`, `STATES = ['open', 'editing', 'done']`, `HOWS = ['mine', 'theirs', 'hand', 'agent', 'review']`.

Record shape (what `publicMerge` returns):

```js
{ id, path, by, byId, others: [names], ts, kind, state,
  ours: string | null, base: string | null, theirsHash: string | null, binary: bool, local: bool,
  claimedBy: string | null, resolvedBy: string | null, how: string | null, doneTs: number | null, reason: string | null }
```

- [ ] **Step 1: Write the failing tests**

`test/merges.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { openMerge, updateMerge, readMerges, pruneMerges, publicMerge, MAX_RECORD_TEXT, MAX_MERGES, DONE_TTL_MS } from '../src/merges.js'

const fresh = () => { const doc = new Y.Doc(); return { doc, map: doc.getMap('merges') } }
const fields = { path: 'src/a.js', by: 'bob', byId: 'k1', others: ['alice'], kind: 'conflict', ours: 'mine\n', base: 'base\n', theirsHash: 'abc', binary: false }

test('a record opens, reads back and validates', () => {
  const { doc, map } = fresh()
  const r = openMerge(doc, map, fields, null)
  assert.match(r.id, /^[0-9a-f]{16}$/)
  assert.equal(r.state, 'open')
  assert.deepEqual(readMerges(map), [r])
  assert.equal(publicMerge({ ...r, kind: 'weird' }), null)
  assert.equal(publicMerge({ ...r, id: 'nope' }), null)
})

test('text over the cap is not stored in the record', () => {
  const { doc, map } = fresh()
  const r = openMerge(doc, map, { ...fields, ours: 'x'.repeat(MAX_RECORD_TEXT + 1) }, null)
  assert.equal(r.ours, null)
  assert.equal(r.local, true)
})

test('update patches a record and refuses unknown ids', () => {
  const { doc, map } = fresh()
  const r = openMerge(doc, map, fields, null)
  const done = updateMerge(doc, map, r.id, { state: 'done', how: 'mine', resolvedBy: 'alice' }, null)
  assert.equal(done.state, 'done')
  assert.equal(done.how, 'mine')
  assert.ok(done.doneTs > 0)
  assert.throws(() => updateMerge(doc, map, 'ffffffffffffffff', { state: 'done' }, null), /no such merge/)
  assert.throws(() => updateMerge(doc, map, r.id, { state: 'bogus' }, null), /state/)
})

test('open records come first; done ones are pruned by age and count', () => {
  const { doc, map } = fresh()
  const old = openMerge(doc, map, fields, null)
  updateMerge(doc, map, old.id, { state: 'done', how: 'theirs', resolvedBy: 'bob' }, null)
  map.set(old.id, { ...map.get(old.id), doneTs: Date.now() - DONE_TTL_MS - 1 })
  const open = openMerge(doc, map, { ...fields, path: 'src/b.js' }, null)
  assert.equal(readMerges(map)[0].id, open.id)
  pruneMerges(doc, map, null)
  assert.deepEqual(readMerges(map).map((m) => m.id), [open.id])
  for (let i = 0; i < MAX_MERGES + 5; i++) {
    const r = openMerge(doc, map, { ...fields, path: `f${i}` }, null)
    updateMerge(doc, map, r.id, { state: 'done', how: 'theirs', resolvedBy: 'bob' }, null)
  }
  pruneMerges(doc, map, null)
  assert.ok(readMerges(map).length <= MAX_MERGES)
  assert.ok(readMerges(map).some((m) => m.id === open.id), 'open records are never pruned')
})
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test test/merges.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `src/merges.js`**

```js
// Merge records: a file whose offline and in-session edits could not be
// combined on their own. Kept as plain objects in the shared doc so everyone
// in the session (and every AI) sees the same list and anyone can settle it.
import crypto from 'node:crypto'

export const MAX_RECORD_TEXT = 200_000
export const MAX_MERGES = 50
export const DONE_TTL_MS = 24 * 60 * 60 * 1000
export const KINDS = ['conflict', 'ai', 'claimed']
export const STATES = ['open', 'editing', 'done']
export const HOWS = ['mine', 'theirs', 'hand', 'agent', 'review']

const HEX_ID = /^[0-9a-f]{16}$/i
const str = (v, max) => typeof v === 'string' && v.length <= max
const optStr = (v, max) => v == null || str(v, max)

/** A record we'll show. Anything a modified client pushed that isn't this shape is ignored. */
export function publicMerge (v) {
  if (!v || typeof v !== 'object') return null
  if (typeof v.id !== 'string' || !HEX_ID.test(v.id)) return null
  if (!str(v.path, 1024) || !v.path) return null
  if (!str(v.by, 80) || !optStr(v.byId, 128)) return null
  if (!Array.isArray(v.others) || !v.others.every((n) => str(n, 80))) return null
  if (typeof v.ts !== 'number' || !Number.isFinite(v.ts)) return null
  if (!KINDS.includes(v.kind) || !STATES.includes(v.state)) return null
  if (!optStr(v.ours, MAX_RECORD_TEXT) || !optStr(v.base, MAX_RECORD_TEXT) || !optStr(v.theirsHash, 64)) return null
  if (!optStr(v.claimedBy, 80) || !optStr(v.resolvedBy, 80) || !optStr(v.reason, 500)) return null
  if (v.how != null && !HOWS.includes(v.how)) return null
  if (v.doneTs != null && typeof v.doneTs !== 'number') return null
  return {
    id: v.id, path: v.path, by: v.by, byId: v.byId ?? null, others: v.others.slice(0, 20), ts: v.ts,
    kind: v.kind, state: v.state, ours: v.ours ?? null, base: v.base ?? null, theirsHash: v.theirsHash ?? null,
    binary: !!v.binary, local: !!v.local, claimedBy: v.claimedBy ?? null, resolvedBy: v.resolvedBy ?? null,
    how: v.how ?? null, doneTs: v.doneTs ?? null, reason: v.reason ?? null
  }
}

const rank = (s) => (s === 'done' ? 1 : 0)
const order = (a, b) => rank(a.state) - rank(b.state) || a.ts - b.ts || (a.id < b.id ? -1 : 1)

function split (map) {
  const valid = []
  const junk = []
  map.forEach((v, key) => {
    const m = publicMerge(v)
    if (m && m.id === key) valid.push(m)
    else junk.push(key)
  })
  valid.sort(order)
  return { valid, junk }
}

export function readMerges (map) {
  return split(map).valid
}

/** Opens a record. Text beyond the cap stays on the opener's disk only (`local`). */
export function openMerge (doc, map, { path, by, byId = null, others = [], kind, ours = null, base = null, theirsHash = null, binary = false, claimedBy = null, reason = null }, origin) {
  if (!KINDS.includes(kind)) throw new Error('bad merge kind')
  const fits = (t) => t == null || t.length <= MAX_RECORD_TEXT
  const local = !fits(ours) || !fits(base)
  const rec = {
    id: crypto.randomBytes(8).toString('hex'),
    path, by, byId, others: others.filter((n) => n && n !== by).slice(0, 20), ts: Date.now(),
    kind, state: 'open',
    ours: fits(ours) ? ours : null, base: fits(base) ? base : null, theirsHash, binary: !!binary, local,
    claimedBy, resolvedBy: null, how: null, doneTs: null, reason
  }
  doc.transact(() => {
    for (const key of split(map).junk) map.delete(key)
    map.set(rec.id, rec)
  }, origin)
  return publicMerge(rec)
}

/** Changes state, how, resolvedBy or reason. Setting state to done stamps doneTs. */
export function updateMerge (doc, map, id, patch, origin) {
  const cur = publicMerge(map.get(id))
  if (!cur) throw new Error('no such merge')
  const next = { ...map.get(id) }
  if (patch.state !== undefined) {
    if (!STATES.includes(patch.state)) throw new Error('bad merge state')
    next.state = patch.state
    if (patch.state === 'done') next.doneTs = Date.now()
  }
  if (patch.how !== undefined) {
    if (patch.how != null && !HOWS.includes(patch.how)) throw new Error('bad merge how')
    next.how = patch.how
  }
  if (patch.resolvedBy !== undefined) next.resolvedBy = patch.resolvedBy
  if (patch.reason !== undefined) next.reason = patch.reason
  const out = publicMerge(next)
  if (!out) throw new Error('bad merge record')
  doc.transact(() => map.set(id, next), origin)
  return out
}

/** Drops done records older than a day, and the oldest done ones beyond MAX_MERGES. Open ones are kept. */
export function pruneMerges (doc, map, origin, now = Date.now()) {
  const { valid, junk } = split(map)
  const drop = new Set(junk)
  const done = valid.filter((m) => m.state === 'done').sort((a, b) => (a.doneTs || 0) - (b.doneTs || 0))
  for (const m of done) if (m.doneTs && now - m.doneTs > DONE_TTL_MS) drop.add(m.id)
  let count = valid.length - drop.size
  for (const m of done) {
    if (count <= MAX_MERGES) break
    if (!drop.has(m.id)) { drop.add(m.id); count-- }
  }
  if (!drop.size) return
  doc.transact(() => { for (const id of drop) map.delete(id) }, origin)
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/merges.test.js`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/merges.js test/merges.test.js
git commit -m "Shared merge records in the session doc

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The rejoin flow merges instead of interleaving

**Files:**
- Modify: `src/session.js` (imports; constructor; `start()` lines ~177-181; `ingest` ~line 500; `writeOut` ~line 713; replace `reconcileOffline` ~lines 367-409; `status()` ~line 1573; `stop()` ~line 1610)
- Test: `test/sync.test.js` (replace "offline edits merge when a client comes back" at line 356; add new tests after it)

**Interfaces:**
- Consumes: `merge3` (Task 1), `aiMerge`, `findMergeCli` (Task 2), `openMerge`, `readMerges`, `updateMerge`, `pruneMerges` (Task 3).
- Produces on `Session`: `captureOffline() → { entries, take, downloads }`; `mergeOffline(offline) → Promise<void>`; `mergeOne(entry) → Promise<'pushed'|'merged'|'ai'|'conflict'|null>`; `applyMerged(rel, text, detail)`; `openConflict({ rel, base, ours, theirs, theirsBy, kind, reason, claimedBy })`; `mergeDir(id) → absolute path`; `mergeList() → record[]`; `this.merges` (Y.Map), `this.merging` (Set of rel); `status().merges`; event `'merges'` with the list after `mergeOffline` finishes.

- [ ] **Step 1: Write the failing tests**

In `test/sync.test.js`, a helper near the other helpers (after `pair`):

```js
// A merge "AI" for tests: QUILT_MERGE_CMD runs this script, which answers
// CONFLICT unless MERGE_FAKE_ANSWER names a file whose content to return.
const FAKE_MERGE = path.join(tmp('merge-cli'), 'fake-merge.mjs')
fs.writeFileSync(FAKE_MERGE, `
import fs from 'node:fs'
const file = process.env.MERGE_FAKE_ANSWER
let input = ''
process.stdin.on('data', (d) => { input += d })
process.stdin.on('end', () => {
  if (process.env.MERGE_FAKE_LOG) fs.appendFileSync(process.env.MERGE_FAKE_LOG, input + '\\n----\\n')
  if (!file) { process.stdout.write('CONFLICT: the test says no\\n'); return }
  process.stdout.write('\`\`\`\\n' + fs.readFileSync(file, 'utf8') + '\`\`\`\\n')
})
`)
process.env.QUILT_MERGE_CMD = `${process.execPath} ${FAKE_MERGE}`

/** Bob leaves, both sides edit, bob returns. Returns bob's new session. */
async function rejoinAfter (t, { A, B, dirA, dirB, room }, { bob = {}, alice = {} } = {}) {
  await close(B)
  for (const [rel, text] of Object.entries(bob)) text === null ? fs.rmSync(path.join(dirB, rel)) : write(dirB, rel, text)
  for (const [rel, text] of Object.entries(alice)) text === null ? fs.rmSync(path.join(dirA, rel)) : write(dirA, rel, text)
  for (const rel of Object.keys(alice)) await waitFor(() => A.sharedKey(rel) === (alice[rel] === null ? undefined : alice[rel]))
  return open(t, dirB, 'bob', { room })
}
```

Replace the existing test at line 356 with this version (it keeps the chat-file assertion and adds the new-file and merged outcomes):

```js
test('offline edits to different lines merge when a client comes back', async (t) => {
  const p = await pair(t)
  const { A, dirA, dirB } = p
  write(dirA, 'offline.txt', 'top\nmiddle\nbottom\n')
  await waitFor(() => read(dirB, 'offline.txt') === 'top\nmiddle\nbottom\n')
  await close(p.B)
  const note = path.join(tmp('note'), 'while-away.txt')
  fs.writeFileSync(note, 'sent while bob was offline')
  const sentAway = await A.sendFile(note, { to: 'bob' })
  write(dirB, 'offline.txt', 'top (bob offline)\nmiddle\nbottom\n')
  write(dirB, 'bob-only.txt', 'made on a plane\n')
  write(dirA, 'offline.txt', 'top\nmiddle\nbottom (alice)\n')
  await waitFor(() => A.files.get('offline.txt').toString() === 'top\nmiddle\nbottom (alice)\n')
  const B = await open(t, dirB, 'bob', { room: p.room })
  const expected = 'top (bob offline)\nmiddle\nbottom (alice)\n'
  await waitFor(() => read(dirA, 'offline.txt') === expected && read(dirB, 'offline.txt') === expected)
  await waitFor(() => read(dirA, 'bob-only.txt') === 'made on a plane\n')
  assert.deepEqual(B.mergeList(), [], 'a clean merge opens no record')
  const got = await waitFor(() => B.messages({ markRead: false }).find((m) => m.id === sentAway.id)?.file.localPath)
  assert.equal(read(dirB, got), 'sent while bob was offline')
})

test('offline edits to the same lines open a merge conflict and keep the session version', async (t) => {
  const p = await pair(t, { 'same.txt': 'top\nmiddle\nbottom\n' })
  await waitFor(() => read(p.dirB, 'same.txt') === 'top\nmiddle\nbottom\n')
  const B = await rejoinAfter(t, p, { bob: { 'same.txt': 'top\nmiddle (bob)\nbottom\n' }, alice: { 'same.txt': 'top\nmiddle (alice)\nbottom\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'same.txt'))
  assert.equal(rec.kind, 'conflict')
  assert.equal(rec.state, 'open')
  assert.equal(rec.by, 'bob')
  assert.deepEqual(rec.others, ['alice'])
  assert.equal(rec.ours, 'top\nmiddle (bob)\nbottom\n')
  assert.equal(rec.base, 'top\nmiddle\nbottom\n')
  assert.match(rec.reason, /the test says no/)
  assert.equal(read(p.dirB, 'same.txt'), 'top\nmiddle (alice)\nbottom\n', "the session's version is on bob's disk")
  assert.equal(read(p.dirA, 'same.txt'), 'top\nmiddle (alice)\nbottom\n', 'alice is not disturbed')
  assert.equal(read(path.join(p.dirB, '.quilt', 'merges', rec.id), 'ours'), 'top\nmiddle (bob)\nbottom\n')
  await waitFor(() => p.A.mergeList().some((m) => m.id === rec.id), 'alice sees the record too')
})

test('the AI merges overlapping edits when it can, and the result is listed for review', async (t) => {
  const p = await pair(t, { 'ai.txt': 'top\nmiddle\nbottom\n' })
  await waitFor(() => read(p.dirB, 'ai.txt') === 'top\nmiddle\nbottom\n')
  const answer = path.join(tmp('answer'), 'merged.txt')
  fs.writeFileSync(answer, 'top\nmiddle (bob and alice)\nbottom\n')
  const log = path.join(tmp('log'), 'calls.txt')
  process.env.MERGE_FAKE_ANSWER = answer
  process.env.MERGE_FAKE_LOG = log
  t.after(() => { delete process.env.MERGE_FAKE_ANSWER; delete process.env.MERGE_FAKE_LOG })
  const B = await rejoinAfter(t, p, { bob: { 'ai.txt': 'top\nmiddle (bob)\nbottom\n' }, alice: { 'ai.txt': 'top\nmiddle (alice)\nbottom\n' } })
  await waitFor(() => read(p.dirA, 'ai.txt') === 'top\nmiddle (bob and alice)\nbottom\n' && read(p.dirB, 'ai.txt') === 'top\nmiddle (bob and alice)\nbottom\n')
  const rec = B.mergeList().find((m) => m.path === 'ai.txt')
  assert.equal(rec.kind, 'ai')
  assert.equal(rec.state, 'open')
  const prompt = fs.readFileSync(log, 'utf8')
  assert.match(prompt, /middle \(bob\)/)
  assert.match(prompt, /middle \(alice\)/)
  assert.match(prompt, /alice/)
})

test('a file deleted offline but changed in the session is a conflict, and stays', async (t) => {
  const p = await pair(t, { 'gone.txt': 'keep me\n' })
  await waitFor(() => read(p.dirB, 'gone.txt') === 'keep me\n')
  const B = await rejoinAfter(t, p, { bob: { 'gone.txt': null }, alice: { 'gone.txt': 'keep me, edited\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'gone.txt'))
  assert.equal(rec.kind, 'conflict')
  assert.equal(rec.ours, null)
  assert.equal(read(p.dirB, 'gone.txt'), 'keep me, edited\n')
  assert.equal(read(p.dirA, 'gone.txt'), 'keep me, edited\n')
})

test('a file changed offline but deleted in the session is a conflict; ours waits in .quilt/merges', async (t) => {
  const p = await pair(t, { 'bye.txt': 'original\n' })
  await waitFor(() => read(p.dirB, 'bye.txt') === 'original\n')
  const B = await rejoinAfter(t, p, { bob: { 'bye.txt': 'original, plus bob\n' }, alice: { 'bye.txt': null } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'bye.txt'))
  assert.equal(rec.ours, 'original, plus bob\n')
  assert.equal(rec.theirsHash, null)
  assert.equal(read(p.dirB, 'bye.txt'), null, 'the session deleted it, so it is gone until someone chooses it')
  assert.equal(read(path.join(p.dirB, '.quilt', 'merges', rec.id), 'ours'), 'original, plus bob\n')
})

test('a binary changed on both sides is a conflict without asking the AI', async (t) => {
  const bin = (n) => Buffer.from([0, 1, 2, n, 0, 255])
  const p = await pair(t)
  fs.writeFileSync(path.join(p.dirA, 'pic.bin'), bin(3))
  await waitFor(() => fs.existsSync(path.join(p.dirB, 'pic.bin')))
  await close(p.B)
  fs.writeFileSync(path.join(p.dirB, 'pic.bin'), bin(4))
  fs.writeFileSync(path.join(p.dirA, 'pic.bin'), bin(5))
  await waitFor(() => p.A.blobs.get('pic.bin')?.hash !== undefined && Buffer.from(p.A.blobs.get('pic.bin').data, 'base64').equals(bin(5)))
  const B = await open(t, p.dirB, 'bob', { room: p.room })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'pic.bin'))
  assert.equal(rec.binary, true)
  assert.equal(rec.ours, null)
  assert.ok(fs.readFileSync(path.join(p.dirB, 'pic.bin')).equals(bin(5)))
  assert.ok(fs.readFileSync(path.join(p.dirB, '.quilt', 'merges', rec.id, 'ours')).equals(bin(4)))
})

test('offline edits to a file someone else claimed wait as a claimed merge', async (t) => {
  const p = await pair(t, { 'locked.txt': 'original\n' })
  await waitFor(() => read(p.dirB, 'locked.txt') === 'original\n')
  await p.A.claim('locked.txt', 'mine for now')
  await waitFor(() => p.B.claimFor('locked.txt'))
  const B = await rejoinAfter(t, p, { bob: { 'locked.txt': 'original\nbob added this\n' }, alice: { 'locked.txt': 'original, alice\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'locked.txt'))
  assert.equal(rec.kind, 'claimed')
  assert.equal(rec.claimedBy, 'alice')
  assert.equal(read(p.dirB, 'locked.txt'), 'original, alice\n')
  assert.equal(fs.existsSync(path.join(p.dirB, '.quilt', 'rejected')), false, 'not dumped in rejected any more')
})

test('a file only bob changed offline is pushed, not merged', async (t) => {
  const p = await pair(t, { 'solo.txt': 'one\n' })
  await waitFor(() => read(p.dirB, 'solo.txt') === 'one\n')
  const B = await rejoinAfter(t, p, { bob: { 'solo.txt': 'one\ntwo\n' } })
  await waitFor(() => read(p.dirA, 'solo.txt') === 'one\ntwo\n')
  assert.deepEqual(B.mergeList(), [])
})
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test test/sync.test.js`
Expected: the new tests FAIL (`B.mergeList is not a function`, or merges never appear). The old tests still pass.

- [ ] **Step 3: Wire the new modules into `Session`**

At the top of `src/session.js`, after `import { migrateDir } from './legacy.js'`:

```js
import { merge3 } from './merge3.js'
import { aiMerge, findMergeCli } from './merge-ai.js'
import { openMerge, readMerges, updateMerge, pruneMerges } from './merges.js'
```

In the constructor, after `this.tasks = ...` (or after `this.commitRequests` if `tasks` isn't there):

```js
    this.merges = this.doc.getMap('merges') // id -> merge record (see merges.js)
    this.merging = new Set() // paths held out of normal sync until their offline merge has run
    this.mergeCliMissing = false // logged once per session
```

In `goLive()`, after `this.commitRequests.observe(...)`:

```js
    this.merges.observe(() => { this.scheduleStatusWrite(); this.emit('merges', this.mergeList()) })
```

In `status()`, after `commits: ...`:

```js
      merges: this.mergeList(),
```

Add, in the `// ---- tasks --` area (or near `claimFor`):

```js
  // ------------------------------------------------------------ merges --

  mergeList () { return readMerges(this.merges) }

  /** Where this machine keeps a merge's base, ours and theirs (and PROMPT.md for Send to…). */
  mergeDir (id) { return path.join(this.stateDir, 'merges', id) }
```

- [ ] **Step 4: Hold merging paths out of normal sync**

In `ingest(rel)`, right after `if (!this.syncable(rel)) return false`:

```js
    if (this.merging.has(rel)) return false // its offline merge hasn't run yet; see mergeOffline
```

In `writeOut(rel)`, right after `if (!this.syncable(rel)) return`:

```js
    if (this.merging.has(rel)) return // mergeOffline writes this path once it has merged it
```

- [ ] **Step 5: Replace `reconcileOffline` with capture + merge**

Replace the whole `reconcileOffline ()` method with:

```js
  /**
   * Back in a folder we synced before: note every file edited while away as
   * { rel, base, ours } (base: the shared version we last had; ours: what's
   * on disk; a key is text, "bin:<sha1>", or null for "gone") and keep those
   * paths out of normal sync until mergeOffline has merged them against what
   * the session did meanwhile. Nothing is pushed here.
   */
  captureOffline () {
    const onDisk = new Set(walk(this.root, this.ig))
    const downloads = []
    const take = [] // shared versions that never reached the folder: written now, not pushed back
    const entries = []
    const hold = (rel, base, ours) => { this.merging.add(rel); entries.push({ rel, base, ours }) }
    for (const rel of this.sharedPaths()) {
      if (!this.syncable(rel)) continue
      const known = this.sharedKey(rel)
      if (known !== undefined) this.lastKnown.set(rel, known)
      const b = this.blobs.get(rel)
      const had = this.storedOnDisk.get(rel)
      if (b && b.stored && had !== b.hash) {
        // Its download hadn't finished when we stopped, so the folder doesn't
        // have it yet: fetch it rather than share what's on disk. Anything
        // other than the version we last wrote was edited offline; keep it.
        const disk = this.readDisk(rel)
        if (disk && disk.key !== undefined && !(disk.binary && disk.hash === had)) this.keepConflict(rel, disk)
        if (disk && disk.key !== undefined) this.lastKnown.set(rel, disk.key)
        else this.lastKnown.delete(rel)
        onDisk.delete(rel)
        downloads.push(rel)
        continue
      }
      if (onDisk.has(rel)) continue
      // Not in the folder: deleted while offline, unless it was never written (the write failed) and is still due.
      if (this.known && !this.known.has(rel)) take.push(rel)
      else hold(rel, known, null)
    }
    for (const rel of onDisk) {
      const was = this.known && this.known.get(rel)
      const shared = this.sharedKey(rel)
      if (was && shared !== undefined) {
        const disk = this.readDisk(rel)
        if (disk && disk.key !== undefined && disk.key !== shared && sha1(disk.key) === was) {
          // The folder still has the version we last wrote, so the room moved
          // on without the change reaching the disk: take it, don't undo it.
          take.push(rel)
          continue
        }
      }
      const disk = this.readDisk(rel)
      if (!disk || disk.skip || disk.tooLarge) continue
      if (disk.key === shared) { this.lastKnown.set(rel, disk.key); continue }
      hold(rel, shared, disk.key)
    }
    return { entries, take, downloads }
  }

  /** Runs once the relay has synced: merges every captured path against the session's version. */
  async mergeOffline ({ entries, take, downloads }) {
    for (const rel of take) this.tryWrite(rel)
    for (const rel of downloads) this.downloadLarge(rel, this.blobs.get(rel))
    const counts = { pushed: 0, merged: 0, ai: 0, conflict: 0 }
    const queue = entries.slice()
    const worker = async () => {
      while (queue.length && !this.stopped) {
        const e = queue.shift()
        try {
          const r = await this.mergeOne(e)
          if (r) counts[r]++
        } catch (err) {
          this.merging.delete(e.rel)
          this.log(`could not merge ${e.rel}: ${err.message}`)
        }
      }
    }
    await Promise.all([worker(), worker()])
    for (const e of entries) this.merging.delete(e.rel)
    pruneMerges(this.doc, this.merges, LOCAL)
    const parts = []
    if (counts.pushed) parts.push(`${counts.pushed} shared`)
    if (counts.merged) parts.push(`${counts.merged} merged`)
    if (counts.ai) parts.push(`${counts.ai} merged by AI (have a look)`)
    if (counts.conflict) parts.push(`${counts.conflict} need${counts.conflict === 1 ? 's' : ''} merging`)
    if (parts.length) this.log(`${counts.conflict ? '⚠️ ' : '✅ '}your offline changes: ${parts.join(', ')}`)
    this.emit('merges', this.mergeList())
    this.scheduleStatusWrite()
  }

  /** Merges one captured path. Returns what happened, or null when nothing needed doing. */
  async mergeOne ({ rel, base }) {
    const release = () => this.merging.delete(rel)
    const disk = this.readDisk(rel)
    if (disk && (disk.skip || disk.tooLarge)) { release(); return null }
    const ours = disk ? disk.key : null // re-read: it may have changed again before the relay synced
    const theirs = this.sharedKey(rel)
    const theirsBy = this.lastEditorOf(rel)
    if (theirs === base) { release(); return this.ingest(rel) ? 'pushed' : null } // nobody else touched it
    if (ours === theirs || (ours === null && theirs === undefined)) {
      release()
      if (ours === null) this.lastKnown.delete(rel); else this.lastKnown.set(rel, ours)
      return null
    }
    if (ours === base) { release(); this.tryWrite(rel); return null } // only they changed it
    const claim = this.claimFor(rel)
    const binary = [base, ours, theirs].some((k) => typeof k === 'string' && k.startsWith('bin:'))
    if (claim && claim.by !== this.name) return this.openConflict({ rel, base, ours, theirs, theirsBy, disk, kind: 'claimed', claimedBy: claim.by, binary })
    if (binary || ours === null || theirs === undefined) return this.openConflict({ rel, base, ours, theirs, theirsBy, disk, kind: 'conflict', binary })
    const { text, conflicts } = merge3(base || '', ours, theirs)
    if (!conflicts.length) {
      this.applyMerged(rel, text, `with ${theirsBy || 'the session'}'s changes`)
      release()
      return 'merged'
    }
    const cli = findMergeCli()
    if (!cli && !this.mergeCliMissing) {
      this.mergeCliMissing = true
      this.log('overlapping changes go straight to merge conflicts: no AI tool (claude, codex or cursor-agent) is installed to merge with')
    }
    const ai = await aiMerge({ path: rel, base: base || '', ours, theirs, mine: this.name, theirsBy, cli })
    if (ai.text) {
      this.applyMerged(rel, ai.text, `by AI with ${theirsBy || 'the session'}'s changes`)
      openMerge(this.doc, this.merges, { path: rel, by: this.name, byId: this.identity?.publicKey || null, others: theirsBy ? [theirsBy] : [], kind: 'ai', ours, base, theirsHash: sha1(theirs), binary: false }, LOCAL)
      this.writeMergeFiles(this.mergeList().find((m) => m.path === rel && m.kind === 'ai' && m.state === 'open')?.id, { base, ours, theirs })
      release()
      return 'ai'
    }
    return this.openConflict({ rel, base, ours, theirs, theirsBy, disk, kind: 'conflict', reason: ai.refused, binary: false })
  }

  /** Writes a merged text to the shared doc and the disk as one edit of ours. */
  applyMerged (rel, text, detail) {
    const abs = resolveInside(this.root, rel)
    this.doc.transact(() => {
      this.blobs.delete(rel)
      let ytext = this.files.get(rel)
      if (!ytext) { ytext = new Y.Text(); this.files.set(rel, ytext) }
      applyTextDiff(ytext, text)
      this.recordActivity(rel, 'merged', detail)
    }, LOCAL)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    this.writeFile(rel, abs, text)
    this.lastKnown.set(rel, text)
    this.setOnDisk(rel, null)
    this.noteMyEdit(rel)
    this.log(`🧵 merged ${rel} ${detail}`)
  }

  /**
   * The two sides cannot be combined on their own: the session's version
   * stays on disk and in the doc, ours is kept in the record and under
   * .quilt/merges/<id>/, and everyone sees the record until someone settles it.
   */
  openConflict ({ rel, base, ours, theirs, theirsBy, disk, kind, reason = null, claimedBy = null, binary }) {
    const text = (k) => (typeof k === 'string' && !k.startsWith('bin:') ? k : null)
    const rec = openMerge(this.doc, this.merges, {
      path: rel, by: this.name, byId: this.identity?.publicKey || null, others: theirsBy ? [theirsBy] : [],
      kind, ours: binary ? null : text(ours), base: binary ? null : text(base),
      theirsHash: theirs === undefined ? null : sha1(theirs), binary, claimedBy, reason
    }, LOCAL)
    this.writeMergeFiles(rec.id, { base, ours, theirs, disk })
    // The session's version goes back on disk (or the file goes, if the session
    // deleted it). lastKnown is set to ours first so writeOut doesn't also copy
    // it to .quilt/conflicts: the merge folder already has it.
    this.merging.delete(rel)
    if (ours === null) this.lastKnown.delete(rel); else this.lastKnown.set(rel, ours)
    this.tryWrite(rel)
    const who = claimedBy ? `${claimedBy} has it claimed` : theirsBy ? `${theirsBy} changed it too` : 'it changed in the session too'
    this.log(`⚠️  ${rel} needs merging: ${who}${reason ? ` (${reason})` : ''}. Your version is kept; see Merges in the app.`)
    this.emit('file-changed', { path: rel, by: theirsBy || 'partner' })
    return 'conflict'
  }

  /** Keeps the three versions of a merge on this machine, for Send to… and for files too big for the record. */
  writeMergeFiles (id, { base, ours, theirs, disk = null }) {
    if (!id) return
    const dir = this.mergeDir(id)
    fs.mkdirSync(dir, { recursive: true })
    const put = (name, key, buf) => {
      if (buf) { fs.writeFileSync(path.join(dir, name), buf); return }
      if (typeof key === 'string' && !key.startsWith('bin:')) fs.writeFileSync(path.join(dir, name), key)
    }
    put('base', base)
    put('ours', ours, disk && disk.binary ? disk.buf : null)
    if (typeof theirs === 'string' && theirs.startsWith('bin:')) {
      const shared = this.blobs.get(this.mergeList().find((m) => m.id === id)?.path)
      if (shared && shared.data) fs.writeFileSync(path.join(dir, 'theirs'), Buffer.from(shared.data, 'base64'))
    } else put('theirs', theirs)
  }
```

- [ ] **Step 6: Change `start()` to use it**

Replace the `hadState` branch in `start()`:

```js
    if (hadState) {
      // We've synced this folder before: hold what was edited while we were
      // away, let the relay tell us what the others did, then merge the two.
      const offline = this.captureOffline()
      this.goLive()
      if (offline.entries.length) this.log(`${offline.entries.length} file(s) changed while you were away; merging once the relay has synced…`)
      this.conn.waitForSync().then(() => this.mergeOffline(offline)).catch(() => {})
    } else {
```

`goLive()` is called before sync as before, so remote updates for every other path apply as they always did; the held paths are skipped by the guards from Step 4 until `mergeOffline` releases them.

In `stop()`, nothing changes: a merge still running sees `this.stopped` and the worker loop ends.

- [ ] **Step 7: Run the sync tests**

Run: `node --test test/sync.test.js`
Expected: all PASS, including the eight new ones. Common failures and what they mean:
- "same lines" test finds no record → `QUILT_MERGE_CMD` was read before the test set it: make sure `findMergeCli()` reads `process.env` at call time (it does if `env = process.env` is a default parameter evaluated per call).
- `.quilt/merges/<id>/ours` missing → `writeMergeFiles` got `id` undefined; check `openMerge` returned the record.
- The deleted-in-session test shows the file still on disk → `tryWrite(rel)` must run after `merging.delete(rel)`, or `writeOut` returns early.

Then run the whole suite: `npm test`. Expected: everything passes; `test/relay.test.js` and `test/commits.test.js` exercise `status()` and must still pass with the new `merges` field.

- [ ] **Step 8: Commit**

```bash
git add src/session.js test/sync.test.js
git commit -m "Merge offline edits on rejoin instead of interleaving them

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Resolving a merge

**Files:**
- Modify: `src/session.js` (merges section from Task 4; `ingest`)
- Test: `test/sync.test.js`

**Interfaces:**
- Produces on `Session`: `resolveMerge(id, { how }) → record` where `how ∈ 'mine' | 'theirs' | 'hand' | 'agent' | 'review'`; `prepareMergeSend(id) → { prompt, dir }`; `mergePromptFor(record) → string`.

- [ ] **Step 1: Write the failing tests**

Append to `test/sync.test.js`:

```js
/** A room where bob has an open conflict on same.txt. */
async function conflicted (t) {
  const p = await pair(t, { 'same.txt': 'top\nmiddle\nbottom\n' })
  await waitFor(() => read(p.dirB, 'same.txt') === 'top\nmiddle\nbottom\n')
  const B = await rejoinAfter(t, p, { bob: { 'same.txt': 'top\nmiddle (bob)\nbottom\n' }, alice: { 'same.txt': 'top\nmiddle (alice)\nbottom\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'same.txt'))
  return { ...p, B, rec }
}

test('keep mine writes my version everywhere and closes the record', async (t) => {
  const { A, B, dirA, dirB, rec } = await conflicted(t)
  const done = B.resolveMerge(rec.id, { how: 'mine' })
  assert.equal(done.state, 'done')
  assert.equal(done.how, 'mine')
  assert.equal(done.resolvedBy, 'bob')
  await waitFor(() => read(dirA, 'same.txt') === 'top\nmiddle (bob)\nbottom\n' && read(dirB, 'same.txt') === 'top\nmiddle (bob)\nbottom\n')
  await waitFor(() => A.mergeList().find((m) => m.id === rec.id)?.state === 'done')
  assert.throws(() => B.resolveMerge(rec.id, { how: 'theirs' }), /already/)
})

test('keep theirs leaves the session version and closes the record', async (t) => {
  const { B, dirB, rec } = await conflicted(t)
  B.resolveMerge(rec.id, { how: 'theirs' })
  assert.equal(read(dirB, 'same.txt'), 'top\nmiddle (alice)\nbottom\n')
  assert.equal(B.mergeList().find((m) => m.id === rec.id).state, 'done')
})

test('the other person can resolve it too, from the record alone', async (t) => {
  const { A, B, dirA, rec } = await conflicted(t)
  await waitFor(() => A.mergeList().some((m) => m.id === rec.id))
  A.resolveMerge(rec.id, { how: 'mine' })
  await waitFor(() => read(dirA, 'same.txt') === 'top\nmiddle (bob)\nbottom\n')
  await waitFor(() => B.mergeList().find((m) => m.id === rec.id)?.resolvedBy === 'alice')
})

test('edit by hand puts markers in the file; saving it without them closes the record', async (t) => {
  const { A, B, dirA, dirB, rec } = await conflicted(t)
  B.resolveMerge(rec.id, { how: 'hand' })
  const marked = 'top\n<<<<<<< mine (bob)\nmiddle (bob)\n=======\nmiddle (alice)\n>>>>>>> session (alice)\nbottom\n'
  await waitFor(() => read(dirB, 'same.txt') === marked && read(dirA, 'same.txt') === marked)
  assert.equal(B.mergeList().find((m) => m.id === rec.id).state, 'editing')
  write(dirB, 'same.txt', 'top\nmiddle (both)\nbottom\n')
  await waitFor(() => B.mergeList().find((m) => m.id === rec.id)?.state === 'done')
  assert.equal(B.mergeList().find((m) => m.id === rec.id).how, 'hand')
  await waitFor(() => read(dirA, 'same.txt') === 'top\nmiddle (both)\nbottom\n')
})

test('send to a tool writes the three versions and a prompt; the agent then marks it resolved', async (t) => {
  const { B, dirB, rec } = await conflicted(t)
  const { prompt, dir } = B.prepareMergeSend(rec.id)
  assert.equal(dir, path.join(dirB, '.quilt', 'merges', rec.id))
  assert.equal(read(dir, 'base'), 'top\nmiddle\nbottom\n')
  assert.equal(read(dir, 'ours'), 'top\nmiddle (bob)\nbottom\n')
  assert.equal(read(dir, 'theirs'), 'top\nmiddle (alice)\nbottom\n')
  assert.equal(read(dir, 'PROMPT.md'), prompt)
  assert.match(prompt, /same\.txt/)
  assert.match(prompt, /quilt_resolve_merge/)
  assert.match(prompt, new RegExp(rec.id))
  write(dirB, 'same.txt', 'top\nmiddle (agent)\nbottom\n')
  const done = B.resolveMerge(rec.id, { how: 'agent' })
  assert.equal(done.state, 'done')
})

test('keep mine on a file someone else claimed is refused', async (t) => {
  const p = await pair(t, { 'locked.txt': 'original\n' })
  await waitFor(() => read(p.dirB, 'locked.txt') === 'original\n')
  await p.A.claim('locked.txt', 'mine')
  await waitFor(() => p.B.claimFor('locked.txt'))
  const B = await rejoinAfter(t, p, { bob: { 'locked.txt': 'bob\n' }, alice: { 'locked.txt': 'alice\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'locked.txt'))
  assert.throws(() => B.resolveMerge(rec.id, { how: 'mine' }), /claimed by alice/)
  await p.A.release('*')
  await waitFor(() => B.claims.size === 0)
  B.resolveMerge(rec.id, { how: 'mine' })
  await waitFor(() => read(p.dirA, 'locked.txt') === 'bob\n')
})

test('an AI merge listed for review is closed with "review"', async (t) => {
  const p = await pair(t, { 'ai.txt': 'top\nmiddle\nbottom\n' })
  await waitFor(() => read(p.dirB, 'ai.txt') === 'top\nmiddle\nbottom\n')
  const answer = path.join(tmp('answer'), 'merged.txt')
  fs.writeFileSync(answer, 'top\nmiddle (both)\nbottom\n')
  process.env.MERGE_FAKE_ANSWER = answer
  t.after(() => { delete process.env.MERGE_FAKE_ANSWER })
  const B = await rejoinAfter(t, p, { bob: { 'ai.txt': 'top\nmiddle (bob)\nbottom\n' }, alice: { 'ai.txt': 'top\nmiddle (alice)\nbottom\n' } })
  const rec = await waitFor(() => B.mergeList().find((m) => m.path === 'ai.txt' && m.kind === 'ai'))
  assert.equal(B.resolveMerge(rec.id, { how: 'review' }).state, 'done')
})
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test test/sync.test.js`
Expected: the seven new tests FAIL with `resolveMerge is not a function`.

- [ ] **Step 3: Implement resolution in `src/session.js`**

Add to the merges section (after `mergeDir`):

```js
  /** The three versions of a merge: from the record, or from this machine's merge folder when they were too big to share. */
  mergeTexts (rec) {
    const dir = this.mergeDir(rec.id)
    const local = (name) => { try { return fs.readFileSync(path.join(dir, name), 'utf8') } catch { return null } }
    const ours = rec.ours ?? (rec.local ? local('ours') : null)
    const base = rec.base ?? (rec.local ? local('base') : null)
    const theirs = this.files.get(rec.path)?.toString() ?? null
    return { ours, base, theirs }
  }

  /**
   * Settles a merge: `mine` writes the returning person's version, `theirs`
   * keeps the session's, `hand` puts conflict markers in the file for someone
   * to edit (the record closes when the file next syncs without them),
   * `agent` and `review` just close it (the file is already as wanted).
   */
  resolveMerge (id, { how } = {}) {
    const rec = this.mergeList().find((m) => m.id === id)
    if (!rec) throw new Error('no such merge')
    if (rec.state === 'done') throw new Error('that merge is already settled')
    if (!['mine', 'theirs', 'hand', 'agent', 'review'].includes(how)) throw new Error('say how: mine, theirs, hand, agent or review')
    const refusal = this.writeRefusal(rec.path)
    if (refusal && how !== 'review') throw new Error(refusal)
    if (how === 'mine' || how === 'hand') {
      const claim = this.claimFor(rec.path)
      if (claim && claim.by !== this.name) throw new Error(`${rec.path} is claimed by ${claim.by}${claim.note ? ` (${claim.note})` : ''}; ask them, or wait for the release`)
    }
    const { ours, base, theirs } = this.mergeTexts(rec)
    if (how === 'mine') {
      if (rec.binary) {
        const buf = (() => { try { return fs.readFileSync(path.join(this.mergeDir(rec.id), 'ours')) } catch { return null } })()
        if (!buf) throw new Error(`${rec.by}'s version of this file is only on their computer`)
        const abs = resolveInside(this.root, rec.path)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        this.writeFile(rec.path, abs, buf)
        this.merging.delete(rec.path)
        this.ingest(rec.path)
      } else if (ours === null) {
        if (rec.local) throw new Error(`${rec.by}'s version of this file is only on their computer`)
        const abs = resolveInside(this.root, rec.path)
        fs.rmSync(abs, { force: true })
        this.ingest(rec.path)
      } else {
        this.applyMerged(rec.path, ours, `keeping ${rec.by === this.name ? 'my' : `${rec.by}'s`} version`)
      }
    } else if (how === 'theirs') {
      this.tryWrite(rec.path)
    } else if (how === 'hand') {
      if (rec.binary || ours === null || theirs === null) throw new Error('markers only work when both sides have a text version')
      this.applyMerged(rec.path, withMarkers(base || '', ours, theirs, { mine: rec.by, theirs: rec.others[0] || 'session' }), 'with conflict markers to edit by hand')
      return updateMerge(this.doc, this.merges, id, { state: 'editing', how: 'hand', resolvedBy: this.name }, LOCAL)
    }
    const out = updateMerge(this.doc, this.merges, id, { state: 'done', how, resolvedBy: this.name }, LOCAL)
    this.log(`✅ ${rec.path}: merge settled (${how === 'mine' ? `${rec.by}'s version` : how === 'theirs' ? "the session's version" : how === 'agent' ? 'merged by an AI' : 'reviewed'})`)
    this.scheduleStatusWrite()
    return out
  }
```

Change the Task 4 import line to `import { merge3, withMarkers, hasMarkers } from './merge3.js'`.

Then the prompt for Send to…:

```js
  mergePromptFor (rec) {
    const dir = path.relative(this.root, this.mergeDir(rec.id)).split(path.sep).join('/')
    const other = rec.others[0] || 'someone in the session'
    return `Merge conflict in \`${rec.path}\` (Quilt merge ${rec.id}).

${rec.by} changed this file while away from the session; meanwhile ${other} changed it in the session. Quilt could not combine the two on its own. Please merge them:

- \`${dir}/base\`: the version both started from
- \`${dir}/ours\`: ${rec.by}'s version (offline)${rec.ours === null && !rec.local ? ' — deleted' : ''}
- \`${dir}/theirs\`: the session's version (${other})${rec.theirsHash === null ? ' — deleted' : ''}
- \`${rec.path}\`: currently the session's version

Write the merged result to \`${rec.path}\`, keeping every change from both sides and changing no behaviour. If the two really cannot both be true, say so and ask ${rec.by} and ${other} in the chat (quilt_message) rather than picking one.
When the file is right, call the \`quilt_resolve_merge\` tool with id \`${rec.id}\` and how \`agent\` (or tell the person to click Resolved in Quilt).
`
  }

  /** Writes the three versions and PROMPT.md for a tool to work from; returns the prompt. */
  prepareMergeSend (id) {
    const rec = this.mergeList().find((m) => m.id === id)
    if (!rec) throw new Error('no such merge')
    const dir = this.mergeDir(id)
    fs.mkdirSync(dir, { recursive: true })
    const { ours, base, theirs } = this.mergeTexts(rec)
    const put = (name, text) => { if (text !== null && !fs.existsSync(path.join(dir, name))) fs.writeFileSync(path.join(dir, name), text) }
    put('base', base)
    put('ours', ours)
    if (theirs !== null) fs.writeFileSync(path.join(dir, 'theirs'), theirs)
    const prompt = this.mergePromptFor(rec)
    fs.writeFileSync(path.join(dir, 'PROMPT.md'), prompt)
    return { prompt, dir }
  }
```

Closing an `editing` record when the markers are gone: in `ingest(rel)`, just before `let detail = ''` (after the large-file branch), add:

```js
    if (!disk.binary) this.closeHandMerge(rel, disk.text)
```

and the helper in the merges section:

```js
  /** A file being edited by hand lost its markers: that merge is settled. */
  closeHandMerge (rel, text) {
    const rec = this.mergeList().find((m) => m.path === rel && m.state === 'editing')
    if (!rec || hasMarkers(text)) return
    updateMerge(this.doc, this.merges, rec.id, { state: 'done', how: 'hand', resolvedBy: this.name }, LOCAL)
    this.log(`✅ ${rel}: merged by hand`)
  }
```

`.quilt/` is inside the project folder but ignored by `loadIgnore` (`.quilt` is in the default ignore list), so the merge files never sync; confirm with `grep -n "quilt" src/fsutil.js`.

- [ ] **Step 4: Run the tests**

Run: `node --test test/sync.test.js`
Expected: all PASS. If "edit by hand" never reaches `done`, check that `ingest` is reached for bob's save (the path must have been released from `this.merging` by `openConflict`).

- [ ] **Step 5: Commit**

```bash
git add src/session.js test/sync.test.js
git commit -m "Settle a merge: keep mine, keep theirs, markers, or hand it to a tool

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Daemon routes, MCP tools and status markdown

**Files:**
- Modify: `src/control.js` (routes object), `src/mcp.js` (after `quilt_release`), `src/status.js` (after the Claimed files section)
- Test: `test/mcp.test.js`

**Interfaces:**
- Consumes: `session.mergeList()`, `session.resolveMerge(id, { how })`, `session.prepareMergeSend(id)`.
- Produces: `GET /merges → { merges }`; `POST /merges/resolve { id, how } → record`; `POST /merges/send { id } → { prompt, dir }`; MCP `quilt_merges {}` and `quilt_resolve_merge { id, how }`; `renderStatus` prints a "Merges to settle" section.

- [ ] **Step 1: Write the failing test**

In `test/mcp.test.js`, after the existing tests (find the last `test(` block; the `human` session is `dana` in `humanDir`), add:

```js
test('merges are listed and settled through the MCP tools', async () => {
  // Two tool calls on an empty list, then a record made directly in the shared doc.
  assert.match(text(await call('quilt_merges')), /nothing to merge/i)
  const { openMerge } = await import('../src/merges.js')
  const rec = openMerge(human.doc, human.merges, { path: 'src/app.js', by: 'dana', others: ['helper'], kind: 'conflict', ours: 'console.log("dana")\n', base: 'console.log("hi")\n', theirsHash: 'x', binary: false }, null)
  const listed = await waitFor(async () => { const t = text(await call('quilt_merges')); return t.includes(rec.id) ? t : null })
  assert.match(listed, /src\/app\.js/)
  assert.match(listed, /dana/)
  const r = text(await call('quilt_resolve_merge', { id: rec.id, how: 'theirs' }))
  assert.match(r, /settled/)
  await waitFor(() => human.mergeList().find((m) => m.id === rec.id)?.state === 'done')
})
```

Check how the earlier tests in this file obtain a daemon for the agent's calls: `withDaemon` finds the daemon for `joined.dir` (the agent's own joined session). If the MCP client in this file joined its own session via `quilt_join_session`, the record from `human.merges` reaches it through the relay; `quilt_merges` then reads the agent session's list. Keep the test after the one that joins.

- [ ] **Step 2: Run to see it fail**

Run: `node --test test/mcp.test.js`
Expected: the new test FAILS (`Tool quilt_merges not found`).

- [ ] **Step 3: Routes in `src/control.js`**

Add to `routes`:

```js
    'GET /merges': () => ({ merges: session.mergeList() }),
    'POST /merges/resolve': (b) => session.resolveMerge(String(b.id || ''), { how: b.how }),
    'POST /merges/send': (b) => session.prepareMergeSend(String(b.id || '')),
```

- [ ] **Step 4: Tools in `src/mcp.js`**

After the `quilt_release` registration:

```js
  const mergeLine = (m, me) => {
    const who = m.by === me ? 'you' : m.by
    const other = m.others[0] ? (m.others[0] === me ? 'you' : m.others[0]) : 'the session'
    const what = m.kind === 'ai' ? `merged by AI, waiting for a look` : m.kind === 'claimed' ? `${who} changed it offline but ${m.claimedBy} has it claimed` : `${who} changed it offline and ${other} changed it in the session`
    return `- \`${m.path}\` (id ${m.id}, ${m.state}): ${what}${m.reason ? ` — ${m.reason}` : ''}`
  }

  server.registerTool('quilt_merges', {
    description: 'Files whose offline edits and in-session edits could not be combined automatically. Each has an id. The file currently holds the session\'s version; the other version is under .quilt/merges/<id>/ours (with base and theirs beside it). To settle one yourself: write the merged file, then call quilt_resolve_merge with how "agent".',
    inputSchema: {}
  }, () => withDaemon(async (d) => {
    const { merges } = await call(d, 'GET', '/merges')
    const me = (await call(d, 'GET', '/info')).name
    const open = merges.filter((m) => m.state !== 'done')
    if (!open.length) return 'Nothing to merge.'
    return `Merges to settle:\n${open.map((m) => mergeLine(m, me)).join('\n')}`
  }))

  server.registerTool('quilt_resolve_merge', {
    description: 'Settle a merge from quilt_merges. how: "agent" after you wrote the merged file yourself; "mine" to keep the offline version; "theirs" to keep the session version; "review" to accept an AI merge as it is.',
    inputSchema: {
      id: z.string().describe('The merge id'),
      how: z.enum(['agent', 'mine', 'theirs', 'review']).describe('How it was settled')
    }
  }, ({ id, how }) => withDaemon(async (d) => {
    const r = await call(d, 'POST', '/merges/resolve', { id, how })
    return `Settled the merge of ${r.path} (${how}).`
  }))
```

Also add one sentence to the `instructions` string in `runMcp`: `' If quilt_status lists merges to settle, read quilt_merges before editing those files.'`

- [ ] **Step 5: Status markdown in `src/status.js`**

After the Claimed files section (before `out.push('## Recent activity')`):

```js
  const merges = (st.merges || []).filter((m) => m.state !== 'done')
  if (merges.length) {
    out.push('## Merges to settle')
    for (const m of merges) {
      const who = m.by === st.me.name ? 'you' : m.by
      out.push(`- \`${m.path}\` (id ${m.id}): ${who} changed it offline${m.others[0] ? `, ${m.others[0] === st.me.name ? 'you' : m.others[0]} changed it in the session` : ''}${m.kind === 'ai' ? '; merged by AI, needs a look' : ''}. See quilt_merges.`)
    }
    out.push('')
  }
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/mcp.test.js test/relay.test.js test/commits.test.js`
Expected: PASS. Then `npm test` for the whole suite.

- [ ] **Step 7: Commit**

```bash
git add src/control.js src/mcp.js src/status.js test/mcp.test.js
git commit -m "List and settle merges from the daemon, MCP and status

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Send to a coding tool

**Files:**
- Modify: `src/editors.js` (`openIn`, `openInClaude`, `claudeSessionCommand`), `src/ui-server.js` (routes after `open-in`)
- Test: `test/editors.test.js`

**Interfaces:**
- Produces: `openIn(id, dir, { prompt, ...opts }) → Promise<{ copied: boolean }>`; `claudePromptCommand(cli, dir, id, prompt) → [cli, args, { cwd }]`; `copyToClipboard(text) → Promise<boolean>`; UI route `POST /api/sessions/:id/merges/send { id, app } → { copied, app }`, plus `GET /api/sessions/:id/merges` and `POST /api/sessions/:id/merges/resolve { id, how }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/editors.test.js`:

```js
import { claudePromptCommand } from '../src/editors.js'

test('a Claude session can start with a prompt that edits files without asking', () => {
  const [file, args, opts] = claudePromptCommand('/bin/claude', '/Users/me/Panorama', 'abc', 'Merge conflict in src/a.js')
  assert.equal(file, '/bin/claude')
  assert.deepEqual(args, ['-p', 'Merge conflict in src/a.js', '--session-id', 'abc', '--permission-mode', 'acceptEdits'])
  assert.deepEqual(opts, { cwd: '/Users/me/Panorama', timeout: 300000 })
})
```

(Move the import up with the others; shown here for clarity.)

- [ ] **Step 2: Run to see it fail**

Run: `node --test test/editors.test.js`
Expected: FAIL, `claudePromptCommand` is not exported.

- [ ] **Step 3: Implement in `src/editors.js`**

After `claudeSessionCommand`:

```js
/** A Claude Code session that starts by working on `prompt` headless (edits allowed), then can be opened to look at. */
export function claudePromptCommand (cli, dir, id, prompt) {
  return [cli, ['-p', prompt, '--session-id', id, '--permission-mode', 'acceptEdits'], { cwd: dir, timeout: 300000 }]
}

/** Puts text on the clipboard (pbcopy on a Mac, clip on Windows, xclip elsewhere). False when it couldn't. */
export async function copyToClipboard (text) {
  const cmd = process.platform === 'darwin' ? ['pbcopy', []] : process.platform === 'win32' ? ['clip', []] : ['xclip', ['-selection', 'clipboard']]
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd[1], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
    child.stdin.end(text)
  })
}
```

Change `openInClaude` to take the prompt:

```js
async function openInClaude (dir, opts) {
  const [file, args] = openCommand('claude', dir, opts) // checks it's installed; the folder link is the fallback
  const cli = claudeCli(opts)
  if (cli) {
    const id = crypto.randomUUID()
    try {
      if (opts.prompt) await run(...claudePromptCommand(cli, dir, id, opts.prompt))
      else await run(...claudeSessionCommand(cli, dir, id))
      const link = `claude://resume?session=${id}`
      await run(...(process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', link]] : ['open', [link]]))
      return { copied: false }
    } catch {} // fall back to the folder link (and the clipboard, when there's a prompt)
  }
  const copied = opts.prompt ? await copyToClipboard(opts.prompt) : false
  await run(file, args)
  return { copied }
}

export async function openIn (id, dir, opts = {}) {
  dir = path.resolve(dir)
  try {
    if (id === 'claude') return await openInClaude(dir, opts)
    const copied = opts.prompt ? await copyToClipboard(opts.prompt) : false
    await run(...openCommand(id, dir, opts))
    return { copied }
  } catch (err) {
    throw new Error(`Could not open it: ${err.message}`)
  }
}
```

`run` passes `opts` through to `execFile`, so the `{ cwd, timeout }` from `claudePromptCommand` applies. The existing `openIn` callers ignore the return value, so returning an object is compatible.

- [ ] **Step 4: UI server routes in `src/ui-server.js`**

After `'POST /api/sessions/:id/open-in'`:

```js
    'GET /api/sessions/:id/merges': (b, id) => ({ merges: get(id).mergeList() }),
    'POST /api/sessions/:id/merges/resolve': (b, id) => { const r = get(id).resolveMerge(String(b.id || ''), { how: b.how }); pushStatus(id); return r },
    'POST /api/sessions/:id/merges/send': async (b, id) => {
      const s = get(id)
      const { prompt } = s.prepareMergeSend(String(b.id || ''))
      const app = String(b.app || '')
      const { copied } = await openIn(app, s.root, { prompt })
      return { copied, app }
    },
```

Check that `pushStatus` exists in `ui-server.js` (it is used by the `/read` route at line ~396); if its name differs, use that one.

- [ ] **Step 5: Run the tests**

Run: `node --test test/editors.test.js test/ui.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/editors.js src/ui-server.js test/editors.test.js
git commit -m "Send a merge to Claude Code, Cursor or another app with the prompt

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Merge bar and compare view in the app

**Files:**
- Create: `src/ui/merges.js`
- Modify: `src/ui/session.js` (markup ~line 93, `ws()` state, `renderTop`, `bindMain`, `renderMainBar`, `renderMain`, imports), `src/ui/app.css` (after `.request input.input`)

**Interfaces:**
- Consumes: `status.merges` (records), `state.defaults.editors` (`[{ id, name }]`), `api(method, url, body)`, `toast`, `esc`, `I` from `common.js`; `/api/sessions/:id/file?path=` for the current text.
- Produces: `renderMergeBar(el, { merges, me, editors, sessionId })`, `bindMergeBar(el, { onCompare })`, `renderMergeView(el, { merge, theirs, me, editors })`, `mergeActionsHtml(m, me, editors)`.

No test harness covers the UI; verification is by hand in Step 6.

- [ ] **Step 1: Write `src/ui/merges.js`**

```js
// Merges: the bar above the main pane listing files whose offline and
// in-session edits could not be combined, and the side-by-side view of one.
import { esc, I, api, toast } from './common.js'

const ACTIONS = { mine: 'Keep mine', theirs: 'Keep session', hand: 'Edit by hand', review: 'Looks fine', agent: 'Resolved' }

function describe (m, me) {
  const who = m.by === me ? 'You' : esc(m.by)
  const other = m.others[0] ? (m.others[0] === me ? 'you' : esc(m.others[0])) : 'someone'
  if (m.kind === 'ai') return `${who} changed this offline, ${other} changed it in the session. An AI combined the two; have a look.`
  if (m.kind === 'claimed') return `${who} changed this offline, but ${esc(m.claimedBy || 'someone')} has it claimed. The session's version is in the file.`
  if (m.ours === null && !m.local) return `${who} deleted this offline, ${other} changed it in the session.`
  if (m.theirsHash === null) return `${who} changed this offline, but it was deleted in the session.`
  return `${who} changed this offline, ${other} changed it in the session${m.reason ? ` (${esc(m.reason)})` : ''}.`
}

export function mergeActionsHtml (m, me, editors, { full = false } = {}) {
  const id = esc(m.id)
  const b = (how, cls = 'ghost') => `<button class="btn sm ${cls}" data-merge="${id}" data-how="${how}">${ACTIONS[how]}</button>`
  if (m.state === 'done') return `<span class="tag">Settled by ${esc(m.resolvedBy || 'someone')}</span>`
  if (m.state === 'editing') return `<span class="hint">Markers are in the file</span>${b('agent', 'primary')}`
  if (m.kind === 'ai') return b('review', 'primary') + (full ? b('mine') + b('theirs') : '')
  const mineLabel = m.ours === null && !m.local ? 'Delete it' : m.by === me ? 'Keep mine' : `Keep ${esc(m.by)}'s`
  const send = editors.length
    ? `<span class="merge-send"><button class="btn sm" data-merge="${id}" data-send="${esc(editors[0].id)}">Send to ${esc(editors[0].name)}</button>${editors.length > 1 ? `<select class="input sm" data-merge-apps="${id}" aria-label="Other apps">${editors.slice(1).map((e) => `<option value="${esc(e.id)}">Send to ${esc(e.name)}</option>`).join('')}</select>` : ''}</span>`
    : ''
  const claimed = m.kind === 'claimed'
  return `<button class="btn sm ghost" data-merge="${id}" data-how="mine" ${claimed ? 'disabled title="Claimed"' : ''}>${mineLabel}</button>${b('theirs')}${m.binary || m.ours === null || m.theirsHash === null ? '' : `<button class="btn sm ghost" data-merge="${id}" data-how="hand" ${claimed ? 'disabled title="Claimed"' : ''}>Edit by hand</button>`}${send}`
}

export function renderMergeBar (el, { merges, me, editors }) {
  const open = merges.filter((m) => m.state !== 'done')
  el.hidden = !open.length
  if (!open.length) { el.innerHTML = ''; return }
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return
  el.innerHTML = open.map((m) => `
    <div class="request merge-row" data-merge-row="${esc(m.id)}">
      <span class="ico">${I.file}</span>
      <div class="rq-main"><button class="linkish mono" data-compare="${esc(m.id)}" title="Compare the two versions">${esc(m.path)}</button>
        <span class="hint">${describe(m, me)}</span></div>
      ${mergeActionsHtml(m, me, editors)}
    </div>`).join('')
}

/** Wires the bar (and the compare view) once; `onCompare(id)` opens the view. */
export function bindMerges (el, { sessionId, onCompare }) {
  el.addEventListener('click', async (e) => {
    const cmp = e.target.closest('[data-compare]')
    if (cmp) { onCompare(cmp.dataset.compare); return }
    const btn = e.target.closest('[data-merge]')
    if (!btn) return
    btn.disabled = true
    try {
      if (btn.dataset.send) {
        const r = await api('POST', `/api/sessions/${sessionId()}/merges/send`, { id: btn.dataset.merge, app: btn.dataset.send })
        toast(r.copied ? 'Opened. The merge prompt is on your clipboard: paste it in.' : 'Sent. It will open when done.')
      } else {
        await api('POST', `/api/sessions/${sessionId()}/merges/resolve`, { id: btn.dataset.merge, how: btn.dataset.how })
        toast('Settled')
      }
    } catch (err) { toast(err.message); btn.disabled = false }
  })
  el.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-merge-apps]')
    if (!sel) return
    try {
      const r = await api('POST', `/api/sessions/${sessionId()}/merges/send`, { id: sel.dataset.mergeApps, app: sel.value })
      toast(r.copied ? 'Opened. The merge prompt is on your clipboard: paste it in.' : 'Sent. It will open when done.')
    } catch (err) { toast(err.message) }
  })
}

/** Lines of `text` that do not appear in `base` get the `changed` class. Cheap, good enough to spot what each side did. */
function column (title, text, base) {
  if (text === null) return `<div class="merge-col"><div class="merge-col-head">${title}</div><div class="fv-note">Deleted</div></div>`
  const known = new Set((base || '').split('\n'))
  const rows = text.split('\n').map((l, i) => `<div class="fv-line${known.has(l) ? '' : ' changed'}"><span class="fv-num">${i + 1}</span><span class="fv-code">${esc(l) || ' '}</span></div>`).join('')
  return `<div class="merge-col"><div class="merge-col-head">${title}</div><div class="fv-scroll mono">${rows}</div></div>`
}

export function renderMergeView (el, { merge: m, theirs, me, editors }) {
  if (!m) { el.innerHTML = '<div class="main-empty"><p class="hint">That merge is settled or gone.</p></div>'; return }
  const mine = m.by === me ? 'Mine (offline)' : `${esc(m.by)}'s (offline)`
  const sess = `Session${m.others[0] ? ` (${esc(m.others[0])})` : ''}`
  el.innerHTML = `<div class="fv-banner"><span class="fv-path mono">${esc(m.path)}</span><span class="hint">${describe(m, me)}</span><span class="spacer"></span>${mergeActionsHtml(m, me, editors, { full: true })}</div>
    ${m.binary ? '<div class="fv-note">Binary file: pick a version above.</div>' : `<div class="merge-cols">${column(mine, m.ours, m.base)}${column(sess, theirs, m.base)}</div>`}`
}
```

`linkish` and `fv-line`/`fv-num`/`fv-code` are the class names `fileview.js` uses for its rows; check with `grep -n "fv-line\|fv-num\|fv-code" src/ui/fileview.js src/ui/app.css` and match whatever the real names are. If `linkish` does not exist, add it in the CSS step.

- [ ] **Step 2: Mount it in `src/ui/session.js`**

Import at the top:

```js
import { renderMergeBar, bindMerges, renderMergeView } from './merges.js'
```

Markup: after `<div class="requests" id="requests" hidden></div>` add `<div class="requests merges" id="merges" hidden></div>`.

`ws()` state: add `mergeSel: null` after `fileSel: null`, and the mode set becomes `'ai' | 'files' | 'merge'`.

In `renderTop()`, after `renderAccess()`:

```js
  renderMerges()
```

New function next to `renderAccess`:

```js
function renderMerges () {
  const bar = $('#merges')
  if (!bar) return
  const st = sum().status
  renderMergeBar(bar, { merges: st.merges || [], me: me(), editors: state.defaults.editors || [] })
  const w = ws(current)
  if (w.mode === 'merge' && w.mergeSel) renderMain()
}
```

In `mountSession` where `bindAccess()` is called, add `bindMerges($('#merges'), { sessionId: () => current, onCompare: openMerge })` and:

```js
function openMerge (id) {
  const w = ws(current)
  w.mergeSel = id
  w.mode = 'merge'
  saveWs(current)
  renderMainBar()
  renderMain()
}
```

In `renderMainBar()`, append a merge tab when `w.mergeSel` is set (after the file tabs string):

```js
  + (w.mergeSel ? `<div class="ws-tab${w.mode === 'merge' ? ' on' : ''}" role="tab" aria-selected="${w.mode === 'merge'}" tabindex="0" data-kind="merge" data-tab="${esc(w.mergeSel)}" title="Merge">
      <span class="ico">${I.file}</span><span class="nm">Merge</span>
      <button class="x" data-kind="merge" data-close="${esc(w.mergeSel)}" aria-label="Close merge">${I.x}</button></div>` : '')
```

and change the hidden line to `$('#mainbar').hidden = !w.aiTabs.length && !w.fileTabs.length && !w.mergeSel`.

In `bindMain()`'s tab click handler, before the `if (close)` block's list logic, handle the merge kind:

```js
    if (close && close.dataset.kind === 'merge') {
      e.stopPropagation()
      w.mergeSel = null
      if (w.mode === 'merge') w.mode = w.fileSel ? 'files' : 'ai'
      saveWs(current); renderMainBar(); renderMain(); return
    }
    if (tab && tab.dataset.kind === 'merge') { openMerge(tab.dataset.tab); return }
```

In `renderMain()`, before `if (w.mode === 'ai')`:

```js
  if (w.mode === 'merge') {
    const m = (st.merges || []).find((x) => x.id === w.mergeSel) || null
    const cached = m ? state.files.get(fileKey(m.path)) : null
    renderMergeView(el, { merge: m, theirs: cached && cached.file && !cached.file.missing ? cached.file.text : null, me: me(), editors: state.defaults.editors || [] })
    if (m && !cached) refreshFile(m.path, false)
    return
  }
```

`refreshFile` and `fileKey` already exist in `session.js` (used by `openFile`); `refreshFile` re-renders the main pane when the file arrives, which repaints the merge view with `theirs`. Also handle the compare view's action buttons: the `bindMerges` listener is on `#merges` only, so in `bindMain()`'s `#main` click handler add the same two branches (`[data-merge]` with `data-how` / `data-send`) by calling a shared helper: move the click body of `bindMerges` into an exported `handleMergeClick(e, sessionId)` in `merges.js` and call it from both listeners.

- [ ] **Step 3: Styles in `src/ui/app.css`**

After `.request input.input { width: 190px; }`:

```css
.merges { background: color-mix(in srgb, var(--amber, #a8701c) 8%, var(--bg)); }
.merge-row .ico { display: inline-flex; color: var(--muted); }
.merge-row .linkish { background: none; border: 0; padding: 0; color: var(--fg); font: inherit; cursor: pointer; text-decoration: underline dotted; }
.merge-send { display: inline-flex; gap: 4px; align-items: center; }
.merge-send .input.sm { height: 30px; font-size: 12.5px; }
.merge-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--border); min-height: 0; flex: 1; }
.merge-col { display: flex; flex-direction: column; min-width: 0; background: var(--bg); }
.merge-col-head { padding: 6px 10px; font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--border); }
.merge-col .fv-scroll { flex: 1; overflow: auto; }
.merge-col .fv-line.changed { background: color-mix(in srgb, var(--amber, #a8701c) 18%, transparent); }
@media (max-width: 900px) { .merge-cols { grid-template-columns: 1fr; } }
```

Use the variable names that `app.css` actually defines (`grep -n "^  --" src/ui/app.css | head -30`); replace `--amber` with the closest existing warm accent if there is none.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS (the UI is served as static files; `test/ui.test.js` loads `index.html` and the API, so a syntax error in `merges.js` shows up only in the browser, which is why Step 5 follows).

- [ ] **Step 5: Try it in the app**

Two folders on this machine, one relay (the dev relay or `quilt serve`). Launch the UI from the worktree:

```bash
cd /Users/danielcarmichael/elegy/.claude/worktrees/offline-merge && node bin/quilt.js ui
```

1. Start a session in folder A, join from folder B (second app window or `quilt join` in B with a different name).
2. Leave in B. Edit `same.txt` on the same line in both folders. Rejoin B.
3. Expect: the amber bar shows `same.txt` with the sentence and buttons; alice's version is in both files; clicking the path opens the two columns with changed lines highlighted.
4. Click **Keep mine**: both folders now hold bob's text; the bar empties.
5. Repeat with **Edit by hand**: markers appear in both folders; save without markers in B; the bar empties.
6. With Claude Code installed, **Send to Claude Code**: `.quilt/merges/<id>/PROMPT.md` exists, and a Claude session opens after it finishes.
7. Set `QUILT_MERGE_CMD` to the fake script from the sync tests with `MERGE_FAKE_ANSWER` to see the "Looks fine" row.

Fix anything that does not match, then re-run `npm test`.

- [ ] **Step 6: Commit**

```bash
git add src/ui/merges.js src/ui/session.js src/ui/app.css
git commit -m "Merge bar and compare view in the app

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Release note and final check

**Files:**
- Modify: `RELEASES.md`, `package.json` (version), `README.md` if it describes offline behaviour

- [ ] **Step 1: Add the release section**

`test/releases.test.js` fails when the top section's version differs from `package.json`; bump both. In `package.json` set `"version": "0.3.3"`. At the top of the sections in `RELEASES.md` (above `## 0.3.2 — 2026-10-02`):

```markdown
## 0.3.3 — 2026-10-02

Work offline, come back, and nothing is lost.

- **Offline changes merge properly.** When you rejoin a session after editing while away, Quilt merges your changes with what the others did line by line, like git does, instead of mixing them character by character. Changes to different lines just combine.
- **Your AI combines overlapping changes.** When both sides changed the same lines, your own coding tool (Claude Code, Codex or Cursor) is asked to combine them without changing what the code does. Those files show in the new **Merges** bar for a look.
- **Real conflicts are yours to settle.** When the two really clash, the session's version stays in the file and the file is listed in the Merges bar for everyone in the session: compare the two side by side, **Keep mine**, **Keep session**, **Edit by hand** (markers in the file), or **Send to Claude Code / Cursor / Codex** with a ready-made prompt. AIs see them with `quilt_merges` and settle them with `quilt_resolve_merge`.
```

- [ ] **Step 2: Check the README**

```bash
grep -n -i "offline\|rejoin\|conflict" README.md
```

If a sentence says offline edits "merge character by character" or similar, change it to say they are merged line by line and conflicts appear in the Merges bar.

- [ ] **Step 3: Run everything**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add RELEASES.md package.json README.md
git commit -m "Release notes: merging offline work

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Follow-ups (not in this plan)

- `src/hooks.js` (branch `claim-before-edit`): mention open merges in the `SessionStart` context once that branch is merged.
- The relay's hosted MCP (`src/relay-mcp.js`) could expose `quilt_merges` for cloud agents; it reads the same `merges` map.
- First join still backs up to `.quilt/conflicts/`; a base-less merge is a separate design.
