// Time spent in sessions, from the visits the relay reports (see routes/relay.js).
// Pure: the API's routes hand it rows from the store and the time now. Times are
// epoch ms; an interval is [start, end) and a list of them is kept sorted and merged.

export const DAY_MS = 24 * 60 * 60 * 1000
export const MAX_SESSIONS = 100
export const MAX_PEOPLE_TOP = 3
export const MAX_COLLABORATORS = 30
export const MAX_VISITS = 20

/** Sorted, overlapping and touching intervals joined, empty ones dropped. */
export function merge (intervals) {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])
  const out = []
  for (const [s, e] of sorted) {
    const last = out[out.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/** Where two merged lists overlap, as a merged list. */
export function intersect (a, b) {
  const out = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0])
    const e = Math.min(a[i][1], b[j][1])
    if (e > s) out.push([s, e])
    if (a[i][1] < b[j][1]) i++
    else j++
  }
  return out
}

/** A merged list cut to [from, to). */
export function clip (list, from, to) {
  return list.map(([s, e]) => [Math.max(s, from), Math.min(e, to)]).filter(([s, e]) => e > s)
}

export const total = (list) => list.reduce((n, [s, e]) => n + (e - s), 0)

/** A visit as an interval: an open visit runs until now. */
const span = (v, now) => [v.startedAt, v.endedAt == null ? now : Math.min(v.endedAt, now)]

const formatters = new Map()
function partsIn (t, tz) {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formatters.set(tz, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]))
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, weekday: p.weekday }
}

/** Whether `tz` is an IANA time zone this runtime knows ("Europe/Paris", "UTC"). */
export function isTimeZone (tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return true } catch { return false }
}

/** How far `tz` is ahead of UTC at `t`, in ms. */
export function zoneOffset (t, tz) {
  const p = partsIn(t, tz)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000
}

/** 00:00 on a calendar day in `tz` (month 1-12; days past the month's end roll over). */
export function midnightIn (year, month, day, tz) {
  const guess = Date.UTC(year, month - 1, day)
  const first = guess - zoneOffset(guess, tz)
  return guess - zoneOffset(first, tz)
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Monday 00:00 of the week `now` falls in, in `tz`. */
export function weekStart (now, tz) {
  const p = partsIn(now, tz)
  return midnightIn(p.year, p.month, p.day - WEEKDAYS.indexOf(p.weekday), tz)
}

/** The 1st of the month `now` falls in, 00:00 in `tz`. */
export function monthStart (now, tz) {
  const p = partsIn(now, tz)
  return midnightIn(p.year, p.month, 1, tz)
}

/** The newest name an account went by in these rows. */
function latest (rows) {
  return rows.reduce((a, b) => (b.startedAt > a.startedAt ? b : a))
}

/**
 * The dashboard: for `me` ('person:<id>'), each session in `sessions` I was in, my
 * time there and the people and agents whose visits overlapped mine; plus my time
 * collaborating this week and who I worked with most this month (both in `tz`).
 * `visits` are every visit in those sessions. Nobody I never overlapped with appears.
 */
export function summarize ({ me, sessions, visits, now, tz = 'UTC' }) {
  const byRoom = new Map()
  for (const v of visits) {
    if (!byRoom.has(v.room)) byRoom.set(v.room, [])
    byRoom.get(v.room).push(v)
  }
  const collab = [] // time I overlapped anyone, across every session
  const together = new Map() // account -> { name, kind, spans } across every session
  const rows = []
  for (const s of sessions) {
    const inRoom = byRoom.get(s.room) || []
    const mineRows = inRoom.filter((v) => v.account === me)
    if (!mineRows.length) continue
    const mine = merge(mineRows.map((v) => span(v, now)))
    const others = new Map()
    for (const v of inRoom) {
      if (v.account === me) continue
      if (!others.has(v.account)) others.set(v.account, [])
      others.get(v.account).push(v)
    }
    collab.push(...intersect(mine, merge(inRoom.filter((v) => v.account !== me).map((v) => span(v, now)))))
    const people = []
    for (const [account, theirs] of others) {
      const both = intersect(mine, merge(theirs.map((v) => span(v, now))))
      const ms = total(both)
      if (ms <= 0) continue
      const last = latest(theirs)
      people.push({ account, name: last.accountName, kind: last.kind, togetherMs: ms, lastTogetherAt: both[both.length - 1][1] })
      const t = together.get(account) || { name: last.accountName, kind: last.kind, at: 0, spans: [] }
      if (last.startedAt >= t.at) Object.assign(t, { name: last.accountName, kind: last.kind, at: last.startedAt })
      t.spans.push(...both)
      together.set(account, t)
    }
    people.sort((a, b) => b.togetherMs - a.togetherMs || a.name.localeCompare(b.name))
    const ownerRows = s.ownerAccount ? inRoom.filter((v) => v.account === s.ownerAccount) : []
    const open = inRoom.some((v) => v.endedAt == null)
    rows.push({
      room: s.room,
      name: s.name || '',
      owner: { name: ownerRows.length ? latest(ownerRows).accountName : '' },
      mine: !!s.ownerAccount && s.ownerAccount === me,
      createdAt: s.createdAt,
      lastActiveAt: open ? now : s.lastActiveAt,
      myTotalMs: total(mine),
      people
    })
  }
  rows.sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.room.localeCompare(b.room))
  const week = weekStart(now, tz)
  const month = monthStart(now, tz)
  const topCollaborators = [...together].map(([account, t]) => ({ account, name: t.name, kind: t.kind, ms: total(clip(merge(t.spans), month, now)) }))
    .filter((c) => c.ms > 0)
    .sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name))
    .slice(0, MAX_PEOPLE_TOP)
  return {
    totals: { collaboratingThisWeek: total(clip(merge(collab), week, now)), topCollaborators },
    sessions: rows.slice(0, MAX_SESSIONS)
  }
}

/** Everyone I've overlapped with in these sessions, most recent first (for invites). */
export function collaborators (sessions) {
  const seen = new Map()
  for (const s of sessions) {
    for (const p of s.people) {
      const was = seen.get(p.account)
      if (!was || p.lastTogetherAt > was.lastTogetherAt) seen.set(p.account, { account: p.account, name: p.name, kind: p.kind, lastTogetherAt: p.lastTogetherAt })
    }
  }
  return [...seen.values()].sort((a, b) => b.lastTogetherAt - a.lastTogetherAt).slice(0, MAX_COLLABORATORS)
}

/** My last visits to one session, newest first. */
export function myVisits ({ me, visits }) {
  return visits.filter((v) => v.account === me)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_VISITS)
    .map((v) => ({ startedAt: v.startedAt, endedAt: v.endedAt ?? null }))
}
