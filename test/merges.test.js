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
