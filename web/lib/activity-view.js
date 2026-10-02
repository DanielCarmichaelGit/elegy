// Words and times for your sessions on the dashboard. Pure, no Next imports, so it's
// unit-tested directly. Times are epoch ms from the API.

export const TZ_COOKIE = 'quilt_tz'
export const EMPTY_SESSIONS = 'No sessions yet. Start one in the Quilt app and it shows up here.'
export const UNTITLED = 'Untitled session'
export const MAX_AVATARS = 5
const ROOM = /^[A-Za-z0-9_-]{1,64}$/
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Whether `s` could be a session's room id (anything else is a 404 without asking the API). */
export const isRoom = (s) => ROOM.test(String(s || ''))

/** The visitor's time zone from the cookie their browser set, or UTC until it has. */
export function tzFrom (value) {
  if (typeof value !== 'string' || !value || value.length > 64) return 'UTC'
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return value } catch { return 'UTC' }
}

/** "under a minute", "45m", "3h", "3h 20m". */
export function formatDuration (ms) {
  if (!Number.isFinite(ms) || ms < MIN) return 'under a minute'
  const mins = Math.floor(ms / MIN)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'} ago`

/** "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago", or the date. */
export function timeAgo (t, now, tz = 'UTC') {
  const d = Math.max(0, now - t)
  if (d < MIN) return 'just now'
  if (d < HOUR) return plural(Math.floor(d / MIN), 'minute')
  if (d < DAY) return plural(Math.floor(d / HOUR), 'hour')
  if (d < 2 * DAY) return 'yesterday'
  if (d < 30 * DAY) return plural(Math.floor(d / DAY), 'day')
  return `on ${formatDate(t, tz)}`
}

/** "Oct 5, 2026" in the visitor's time zone. */
export function formatDate (t, tz = 'UTC') {
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz })
}

/** "9:05 AM" in the visitor's time zone. */
export function formatTime (t, tz = 'UTC') {
  return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
}

/** One of my visits: its date, and from and to ("still here" while it's open). */
export function visitLine (v, tz = 'UTC') {
  return { date: formatDate(v.startedAt, tz), from: formatTime(v.startedAt, tz), to: v.endedAt == null ? 'still here' : formatTime(v.endedAt, tz) }
}

export const sessionTitle = (name) => (typeof name === 'string' && name.trim() ? name : UNTITLED)

/** Initials for an avatar: the first letters of the first and last words. */
export function initialsOf (name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  return (Array.from(words[0])[0] + (words.length > 1 ? Array.from(words[words.length - 1])[0] : '')).toUpperCase()
}

/** The avatars a session row shows: up to `max`, and how many more there are. */
export function avatarList (people, max = MAX_AVATARS) {
  const list = Array.isArray(people) ? people : []
  return { shown: list.slice(0, max), more: Math.max(0, list.length - max) }
}

/** "Owned by you", "Owned by Dana", or "Owned by someone" when the name is unknown. */
export function ownerLine (session) {
  if (session.mine) return 'Owned by you'
  return `Owned by ${session.owner?.name || 'someone'}`
}
