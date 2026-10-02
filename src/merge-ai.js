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

// The merge runs on its own when someone rejoins, on text a peer wrote: the
// AI only has to answer, so it gets no tools (claude --tools "") or a
// read-only sandbox (codex). cursor-agent has no such switch: its -p mode has
// every tool, so it runs without --force, as before.
const CLIS = [
  { exe: 'claude', args: ['-p', '--no-session-persistence', '--tools', ''] },
  { exe: 'codex', args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-'] },
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

/** A fence longer than any run of backticks in the texts, so none of them can close it. */
export function fenceFor (...texts) {
  let longest = 0
  for (const t of texts) for (const run of (t || '').match(/`+/g) || []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

export function mergePrompt ({ path: rel, base, ours, theirs, mine, theirsBy }) {
  const f = fenceFor(base, ours, theirs)
  const fence = (label, text) => `${label}:\n${f}\n${text}${f}\n`
  return `You are merging two people's edits to one file, \`${rel}\`, in a shared coding session.
${mine} edited it offline. Meanwhile ${theirsBy || 'someone in the session'} edited it in the session. Both started from BASE.

Rules:
- Produce the file with EVERY change from BOTH versions kept, and nothing else changed.
- Do not change what the code does, rename anything, reformat, or "improve" it.
- Keep the file's line endings and trailing newline as they are.
- If the two versions cannot both be true (they change the same thing in incompatible ways), answer with exactly one line: CONFLICT: <why, in one sentence>
- Otherwise answer with ONLY the whole merged file inside one fenced block opened and closed with ${f} (${f.length} backticks, longer than any run of backticks inside the file). No words before or after it.

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

/**
 * The file in an answer that is exactly one fenced block, or null. Accepts a
 * language tag after the opening fence. The closing fence is the same length
 * as the opening one, and no line inside may start with that many backticks:
 * otherwise the answer is several blocks (or a file whose own fences closed
 * the wrapper) and taking any one of them could drop part of the file.
 */
export function fencedFile (answer) {
  const m = /^(`{3,})[^`\n]*\n([\s\S]*?)\1[ \t]*$/.exec(String(answer).trim())
  if (!m) return null
  const inner = new RegExp(`^ {0,3}${m[1]}`, 'm')
  return inner.test(m[2]) ? null : m[2]
}

/**
 * Lines both sides kept from base must survive the merge; a merge that
 * drops one lost something nobody changed. Returns the first such line, or null.
 * (Checked against ours/theirs directly, not merge3's output: inside a
 * conflicted hunk, merge3's fallback text keeps ours' side verbatim, which
 * would wrongly count as "untouched" when theirs actually changed it.)
 */
function droppedLine (base, ours, theirs, merged) {
  const keptByOurs = new Set(ours.split('\n'))
  const keptByTheirs = new Set(theirs.split('\n'))
  const have = new Set(merged.split('\n'))
  for (const line of base.split('\n')) {
    if (line.trim() && keptByOurs.has(line) && keptByTheirs.has(line) && !have.has(line)) return line
  }
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
  // A refusal is the whole answer saying CONFLICT:, not any line of a valid
  // merged file that happens to start with those words (e.g. a comment).
  const text = fencedFile(answer)
  const conflict = text === null ? /^CONFLICT:\s*(.*)/.exec(answer.trim()) : null
  if (conflict) return { refused: conflict[1].trim() || 'the AI says the changes conflict' }
  if (text === null) return { refused: 'the AI gave no file back' }
  if (!text && (ours || theirs)) return { refused: 'the AI gave back an empty file' }
  const dropped = droppedLine(base, ours, theirs, text)
  if (dropped !== null) return { refused: `the AI's merge dropped a line nobody changed: ${dropped.trim().slice(0, 60)}` }
  return { text }
}
