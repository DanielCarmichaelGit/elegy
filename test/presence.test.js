// The relay's presence reports: a queue kept on disk, sent in order in batches,
// retried with backoff, and capped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PresenceReporter, PRESENCE_FILE } from '../src/presence.js'

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-presence-')), PRESENCE_FILE)
/** A stand-in for the accounts API: records each request, answers with `status()`. */
function fakeApi (status = () => 200) {
  const requests = []
  const fetch = async (url, init) => {
    requests.push({ url, headers: init.headers, events: JSON.parse(init.body).events })
    return { ok: status() < 300, status: status() }
  }
  return { fetch, requests, events: () => requests.flatMap((r) => r.events) }
}
const reporter = (o = {}) => {
  let clock = 1_000_000
  const logs = []
  const r = new PresenceReporter({ apiUrl: 'http://api.test/', secret: 's3cret', now: () => clock, log: (m) => logs.push(m), ...o })
  return { r, logs, advance: (ms) => { clock += ms }, at: () => clock }
}

test('a visit starts and ends once, with the account, name and owner; a rename is an event too', async () => {
  const api = fakeApi()
  const { r, advance } = reporter({ fetch: api.fetch })
  const v = r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana', owner: true })
  advance(5000)
  r.visitEnd(v)
  r.visitEnd(v)
  r.rename({ room: 'r1', name: 'Pricing' })
  assert.equal(await r.flush(), true)
  const [start, end, name] = api.events()
  assert.deepEqual({ ...start, id: 'x' }, { id: 'x', type: 'start', room: 'r1', account: 'person:u1', name: 'Dana', owner: true, at: 1_000_000 })
  assert.deepEqual({ ...end, id: 'x' }, { id: 'x', type: 'end', start: start.id, room: 'r1', account: 'person:u1', at: 1_005_000 })
  assert.deepEqual({ ...name, id: 'x' }, { id: 'x', type: 'name', room: 'r1', name: 'Pricing', at: 1_005_000 })
  assert.equal(api.events().length, 3, 'one end per visit')
  assert.equal(api.requests[0].url, 'http://api.test/v1/relay/presence')
  assert.equal(api.requests[0].headers.authorization, 'Bearer s3cret')
  assert.equal(r.size, 0, 'sent events leave the queue')
})

test('sends at most 500 events per request, in order', async () => {
  const api = fakeApi()
  const { r } = reporter({ fetch: api.fetch })
  for (let i = 0; i < 1201; i++) r.rename({ room: 'r1', name: `n${i}` })
  assert.equal(await r.flush(), true)
  assert.deepEqual(api.requests.map((q) => q.events.length), [500, 500, 201])
  assert.deepEqual(api.events().map((e) => e.name), Array.from({ length: 1201 }, (_, i) => `n${i}`))
})

test('a failure keeps the events and backs off, doubling up to 10 minutes', async () => {
  let status = 503
  const api = fakeApi(() => status)
  const { r, logs, advance } = reporter({ fetch: api.fetch })
  r.rename({ room: 'r1', name: 'a' })
  const waits = []
  for (let i = 0; i < 6; i++) {
    assert.equal(await r.tick(), false)
    waits.push(r.retryAt - r.now())
    assert.equal(await r.tick(), false, 'too soon: not even tried')
    advance(waits[i])
  }
  assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
  assert.equal(api.requests.length, 6)
  assert.equal(r.size, 1)
  assert.match(logs[0], /could not report to the accounts API \(the accounts API answered 503\); trying again in 60 s/)
  assert.ok(logs.every((l) => !l.includes('s3cret')), 'the secret is never logged')
  status = 200
  assert.equal(await r.tick(), true)
  assert.equal(r.size, 0)
  assert.equal(r.failures, 0)
})

test('the queue is capped: beyond it the oldest events go, with a log line', async () => {
  const api = fakeApi()
  const { r, logs } = reporter({ fetch: api.fetch, maxQueue: 3 })
  for (const n of ['a', 'b', 'c', 'd', 'e']) r.rename({ room: 'r1', name: n })
  assert.equal(r.size, 3)
  assert.match(logs[0], /queue is full \(3 events\); dropped the 1 oldest/)
  await r.flush()
  assert.deepEqual(api.events().map((e) => e.name), ['c', 'd', 'e'])
})

test('the queue survives a restart, and visits left open are ended at startup', async () => {
  const file = tmp()
  const down = fakeApi(() => 500)
  const first = reporter({ file, fetch: down.fetch })
  const a = first.r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana' })
  const b = first.r.visitStart({ room: 'r1', account: 'agent:a1', name: 'Larry' })
  first.r.visitEnd(b)
  first.r.persist()
  // The process dies here: no close(). A line cut off mid-write is skipped.
  fs.appendFileSync(file, '{"id":"half')
  const api = fakeApi()
  const second = reporter({ file, fetch: api.fetch })
  second.advance(60_000)
  assert.equal(second.r.load(), 1)
  assert.match(second.logs[0], /skipped 1 unreadable line/)
  assert.equal(await second.r.flush(), true)
  const events = api.events()
  assert.deepEqual(events.map((e) => [e.type, e.account]), [['start', 'person:u1'], ['start', 'agent:a1'], ['end', 'agent:a1'], ['end', 'person:u1']])
  assert.equal(events[3].start, a.start)
  assert.equal(events[3].at, 1_060_000, 'ended when the relay came back')
  // Everything was sent, so a third start finds nothing to send or end.
  const third = reporter({ file, fetch: api.fetch })
  assert.equal(third.r.load(), 0)
  assert.equal(third.r.size, 0)
})

test('a visit whose start was already sent is still ended after a crash', async () => {
  const file = tmp()
  const api = fakeApi()
  const first = reporter({ file, fetch: api.fetch })
  const v = first.r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana' })
  await first.r.flush() // the start is sent, and leaves the queue
  assert.equal(first.r.size, 0)
  const second = reporter({ file, fetch: api.fetch })
  assert.equal(second.r.load(), 1)
  await second.r.flush()
  const last = api.events().at(-1)
  assert.deepEqual([last.type, last.start], ['end', v.start])
})

test('closing ends open visits, saves the queue and sends it; nothing is recorded after', async () => {
  const file = tmp()
  const api = fakeApi()
  const { r } = reporter({ file, fetch: api.fetch })
  r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana' })
  await r.close()
  assert.deepEqual(api.events().map((e) => e.type), ['start', 'end'])
  assert.equal(r.visitStart({ room: 'r1', account: 'person:u1', name: 'Dana' }), null)
  assert.equal(r.size, 0)
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.deepEqual(lines, ['{"open":[]}'], 'only the (empty) list of open visits is left on disk')
})

test('with no file the queue lives in memory', async () => {
  const api = fakeApi()
  const { r } = reporter({ fetch: api.fetch })
  assert.equal(r.load(), 0)
  r.rename({ room: 'r1', name: 'x' })
  r.persist()
  assert.equal(await r.flush(), true)
})
