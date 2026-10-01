import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinView, joinPath, isRoom, JOIN_HOST } from '../lib/join.js'

test('an invite with its secret opens in Quilt', () => {
  const link = 'https://join.heyquilt.com/room-1a2b#abc_D-9'
  assert.equal(JOIN_HOST, 'join.heyquilt.com')
  assert.deepEqual(joinView('room-1a2b', '#abc_D-9'), { missing: false, link, open: `quilt://join?invite=${encodeURIComponent(link)}` })
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

test('paths on join.heyquilt.com map to the join route', () => {
  assert.equal(joinPath('/room-1a2b'), '/join/room-1a2b')
  assert.equal(joinPath('/room-1a2b/'), '/join/room-1a2b')
  for (const other of ['/', '/a/b', '/bad%20room', `/${'x'.repeat(65)}`, '']) assert.equal(joinPath(other), null, other)
})
