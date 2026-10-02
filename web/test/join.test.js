import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinView, joinRedirect, isRoom, JOIN_HOST, SITE_URL, JOIN_TTL_MS, rememberJoin, recallJoin, signInForJoin, joinPagePath } from '../lib/join.js'

test('an invite with its secret opens in Quilt', () => {
  const link = 'https://join.heyquilt.com/room-1a2b#abc_D-9'
  assert.equal(JOIN_HOST, 'join.heyquilt.com')
  assert.deepEqual(joinView('room-1a2b', '#abc_D-9'), { missing: false, link, open: `quilt://join?invite=${encodeURIComponent(link)}` })
  assert.deepEqual(joinView('room-1a2b', 'abc_D-9'), joinView('room-1a2b', '#abc_D-9'), 'with or without the #')
})

test('without its secret, or for something that is not a room, the link is missing part of it', () => {
  for (const [room, hash] of [['room-1a2b', ''], ['room-1a2b', '#'], ['bad room', '#abc'], ['', '#abc'], ['x'.repeat(65), '#abc']]) {
    assert.deepEqual(joinView(room, hash), { missing: true }, `${room} ${hash}`)
  }
})

test('rooms follow the relay rule', () => {
  assert.equal(isRoom('room-1a2b'), true)
  assert.equal(isRoom('Room_9'), true)
  for (const bad of ['', 'bad room', 'a/b', 'x'.repeat(65), null]) assert.equal(isRoom(bad), false, String(bad))
})

test('paths on join.heyquilt.com redirect to the invite page on the main site', () => {
  assert.equal(SITE_URL, 'https://heyquilt.com')
  assert.equal(joinRedirect('/room-1a2b'), 'https://heyquilt.com/join/room-1a2b')
  assert.equal(joinRedirect('/room-1a2b/'), 'https://heyquilt.com/join/room-1a2b')
  for (const other of ['/', '/a/b', '/bad%20room', `/${'x'.repeat(65)}`, '']) assert.equal(joinRedirect(other), null, other)
})

test('signing in from an invite comes back to the invite page', () => {
  assert.equal(joinPagePath('room-1a2b'), '/join/room-1a2b')
  assert.equal(signInForJoin('room-1a2b'), '/signin?next=%2Fjoin%2Froom-1a2b')
})

function fakeStorage () {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), keys: () => [...m.keys()] }
}

test('a remembered invite is recalled for an hour, per room, and only in this browser', () => {
  const s = fakeStorage()
  rememberJoin(s, 'room-1a2b', 'sec-ret', 1000)
  assert.equal(recallJoin(s, 'room-1a2b', 2000), 'sec-ret')
  assert.equal(recallJoin(s, 'room-other', 2000), '', 'another room')
  assert.equal(recallJoin(s, 'room-1a2b', 1000 + JOIN_TTL_MS - 1), 'sec-ret', 'just inside the hour')
  assert.equal(recallJoin(s, 'room-1a2b', 1000 + JOIN_TTL_MS), '', 'an hour later')
  assert.deepEqual(s.keys(), [], 'the stale entry is removed')
})

test('remembering and recalling never throw: no storage, bad rooms, garbage', () => {
  const s = fakeStorage()
  rememberJoin(null, 'room-1a2b', 'x')
  rememberJoin(s, 'bad room', 'x')
  rememberJoin(s, 'room-1a2b', '')
  assert.deepEqual(s.keys(), [])
  assert.equal(recallJoin(null, 'room-1a2b'), '')
  s.setItem('quilt-join:room-1a2b', '{not json')
  assert.equal(recallJoin(s, 'room-1a2b'), '')
  s.setItem('quilt-join:room-1a2b', JSON.stringify({ secret: 5, at: Date.now() }))
  assert.equal(recallJoin(s, 'room-1a2b'), '')
  const throwing = { getItem () { throw new Error('blocked') }, setItem () { throw new Error('blocked') }, removeItem () {} }
  rememberJoin(throwing, 'room-1a2b', 'x')
  assert.equal(recallJoin(throwing, 'room-1a2b'), '')
})
