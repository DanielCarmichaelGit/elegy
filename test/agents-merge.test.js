import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startAgentReaders } from '../src/agents/index.js'

test('a Cursor reader that is still working is not marked idle by the other', () => {
  let composer
  let transcripts
  const readers = [
    ['Cursor', ({ onState }) => {
      composer = onState
      onState({ tool: 'Cursor', status: 'working' })
      return { stop () {} }
    }],
    ['Cursor', ({ onState }) => {
      transcripts = onState
      onState({ tool: 'Cursor', status: 'idle' })
      return { stop () {} }
    }]
  ]
  const seen = []
  const handle = startAgentReaders({
    dir: process.cwd(),
    readers,
    onEntries () {},
    onState: (s) => seen.push({ tool: s.tool, status: s.status })
  })
  assert.equal(seen.at(-1).status, 'working')
  transcripts({ tool: 'Cursor', status: 'idle' })
  assert.deepEqual(seen.at(-1), { tool: 'Cursor', status: 'working' })
  composer({ tool: 'Cursor', status: 'idle' })
  assert.equal(seen.at(-1).status, 'idle')
  handle.stop()
})
