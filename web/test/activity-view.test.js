import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRoom, tzFrom, formatDuration, timeAgo, formatDate, formatTime, visitLine, sessionTitle, initialsOf, avatarList, ownerLine, EMPTY_SESSIONS } from '../lib/activity-view.js'

const T = (iso) => Date.parse(iso)
const MIN = 60 * 1000

test('durations read like "3h 20m", and short ones as "under a minute"', () => {
  assert.equal(formatDuration(0), 'under a minute')
  assert.equal(formatDuration(59 * 1000), 'under a minute')
  assert.equal(formatDuration(MIN), '1m')
  assert.equal(formatDuration(45 * MIN + 30 * 1000), '45m')
  assert.equal(formatDuration(180 * MIN), '3h')
  assert.equal(formatDuration(200 * MIN), '3h 20m')
  assert.equal(formatDuration(NaN), 'under a minute')
})

test('"2 hours ago" and friends, then the date in the visitor\'s time zone', () => {
  const now = T('2026-10-07T12:00:00Z')
  assert.equal(timeAgo(now - 10 * 1000, now), 'just now')
  assert.equal(timeAgo(now - MIN, now), '1 minute ago')
  assert.equal(timeAgo(now - 5 * MIN, now), '5 minutes ago')
  assert.equal(timeAgo(now - 60 * MIN, now), '1 hour ago')
  assert.equal(timeAgo(now - 120 * MIN, now), '2 hours ago')
  assert.equal(timeAgo(now - 30 * 60 * MIN, now), 'yesterday')
  assert.equal(timeAgo(now - 3 * 24 * 60 * MIN, now), '3 days ago')
  assert.equal(timeAgo(T('2026-08-01T02:00:00Z'), now, 'UTC'), 'on Aug 1, 2026')
  assert.equal(timeAgo(T('2026-08-01T02:00:00Z'), now, 'America/Los_Angeles'), 'on Jul 31, 2026')
  assert.equal(timeAgo(now + MIN, now), 'just now', 'a clock a little ahead is not the future')
})

test('dates, times and visits in the visitor\'s time zone', () => {
  const t = T('2026-10-05T13:05:00Z')
  assert.equal(formatDate(t, 'Europe/Paris'), 'Oct 5, 2026')
  assert.equal(formatTime(t, 'Europe/Paris'), '3:05 PM')
  assert.equal(formatTime(t, 'America/New_York'), '9:05 AM')
  assert.deepEqual(visitLine({ startedAt: t, endedAt: t + 90 * MIN }, 'UTC'), { date: 'Oct 5, 2026', from: '1:05 PM', to: '2:35 PM' })
  assert.deepEqual(visitLine({ startedAt: t, endedAt: null }, 'UTC').to, 'still here')
})

test('the time zone cookie, room ids, titles, initials, avatars and owners', () => {
  assert.equal(tzFrom('Europe/Paris'), 'Europe/Paris')
  for (const bad of [undefined, '', 'Mars/Olympus', 'x'.repeat(65)]) assert.equal(tzFrom(bad), 'UTC')
  assert.equal(isRoom('aB3_-x'), true)
  for (const bad of ['', 'a/b', 'x'.repeat(65), null]) assert.equal(isRoom(bad), false)
  assert.equal(sessionTitle('quilt-site'), 'quilt-site')
  assert.equal(sessionTitle(''), 'Untitled session')
  assert.equal(initialsOf('Dana Carmichael'), 'DC')
  assert.equal(initialsOf('larry'), 'L')
  assert.equal(initialsOf(''), '?')
  const people = Array.from({ length: 7 }, (_, i) => ({ account: `person:${i}`, name: `P${i}` }))
  assert.deepEqual(avatarList(people).shown.map((p) => p.name), ['P0', 'P1', 'P2', 'P3', 'P4'])
  assert.equal(avatarList(people).more, 2)
  assert.deepEqual(avatarList(undefined), { shown: [], more: 0 })
  assert.equal(ownerLine({ mine: true, owner: { name: 'Me' } }), 'Owned by you')
  assert.equal(ownerLine({ mine: false, owner: { name: 'Dana' } }), 'Owned by Dana')
  assert.equal(ownerLine({ mine: false, owner: { name: '' } }), 'Owned by someone')
  assert.equal(EMPTY_SESSIONS, 'No sessions yet. Start one in the Quilt app and it shows up here.')
})
