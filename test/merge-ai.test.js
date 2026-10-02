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
