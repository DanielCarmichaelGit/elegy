// Your sessions on the dashboard: where you've been, your time there, and who you
// worked with (activity.js does the sums). Only sessions you were in, and only people
// who were there at the same time as you.
import { HttpError } from '../http.js'
import { summarize, collaborators, myVisits, isTimeZone, weekStart, monthStart, MAX_SESSIONS } from '../activity.js'
import { cleanSessionName, BAD_SESSION_NAME } from '../../session-name.js'

const ROOM = /^[A-Za-z0-9_-]{1,64}$/
const NO_SESSION = 'no such session'

export function sessionRoutes ({ store, now, caller }) {
  const me = async (req) => `person:${(await caller(req)).userId}`
  const zoneOf = (req) => {
    const tz = new URL(req.url, 'http://x').searchParams.get('tz') || 'UTC'
    if (!isTimeZone(tz)) throw new HttpError(400, 'tz must be an IANA time zone, like Europe/London')
    return tz
  }

  async function overview (account, tz) {
    const t = now()
    // The latest sessions, plus every one active this week or month, for the totals.
    const since = Math.min(weekStart(t, tz), monthStart(t, tz))
    const sessions = await store.accountSessions(account, { since, limit: MAX_SESSIONS })
    const visits = await store.visitsInRooms(sessions.map((s) => s.room))
    return summarize({ me: account, sessions, visits, now: t, tz })
  }

  /** A session I was in, with every visit to it; 404 otherwise, whether or not it exists. */
  async function mine (account, room) {
    if (!ROOM.test(room)) throw new HttpError(404, NO_SESSION)
    const session = await store.sessionByRoom(room)
    const visits = session ? await store.visitsInRooms([room]) : []
    if (!visits.some((v) => v.account === account)) throw new HttpError(404, NO_SESSION)
    return { session, visits }
  }

  return [
    ['GET', /^\/v1\/me\/sessions$/, async (req) => overview(await me(req), zoneOf(req))],

    ['GET', /^\/v1\/me\/sessions\/([^/]+)$/, async (req, body, [room]) => {
      const account = await me(req)
      const { session, visits } = await mine(account, room)
      const [s] = summarize({ me: account, sessions: [session], visits, now: now() }).sessions
      return { session: { ...s, visits: myVisits({ me: account, visits }) } }
    }],

    // The owner's rename shows for everyone, and the relay's name no longer replaces it.
    ['PUT', /^\/v1\/me\/sessions\/([^/]+)$/, async (req, body, [room]) => {
      const account = await me(req)
      const name = cleanSessionName(body.name)
      if (!name) throw new HttpError(400, BAD_SESSION_NAME)
      const { session } = await mine(account, room)
      if (session.ownerAccount !== account) throw new HttpError(403, 'Only the session owner can rename it.')
      const renamed = await store.renameSession(room, name, now())
      return { session: { room, name: renamed.name } }
    }],

    // People and agents you've worked with, for invites (most recent first, at most 30).
    ['GET', /^\/v1\/me\/collaborators$/, async (req) => {
      const { sessions } = await overview(await me(req), 'UTC')
      return { collaborators: collaborators(sessions) }
    }]
  ]
}
