// Invites: https://join.heyquilt.com/<room>#<secret>. The secret stays in the
// fragment, so it never reaches a server; the page reads it in the browser.
//
// join.heyquilt.com only redirects to heyquilt.com/join/<room> (browsers keep the
// #secret across a redirect): the invite page needs the sign-in cookie, and that
// lives on heyquilt.com. If they're signed out, the page remembers the secret in
// this browser, sends them to sign in (or sign up), and picks it up when they're back.
export const JOIN_HOST = 'join.heyquilt.com'
export const SITE_URL = 'https://heyquilt.com'
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/
/** How long a remembered invite is kept while someone signs in. */
export const JOIN_TTL_MS = 60 * 60 * 1000

export const isRoom = (room) => ROOM_RE.test(String(room ?? ''))

/** What the page shows for a room and the secret it was opened with. */
export function joinView (room, hash = '') {
  const secret = String(hash || '').replace(/^#/, '')
  if (!isRoom(room) || !secret) return { missing: true }
  const link = `https://${JOIN_HOST}/${room}#${secret}`
  return { missing: false, link, open: `quilt://join?invite=${encodeURIComponent(link)}` }
}

/** Where a join.heyquilt.com path redirects: the invite page on the main site, or null when it isn't an invite. */
export function joinRedirect (pathname) {
  const m = String(pathname || '').match(/^\/([A-Za-z0-9_-]{1,64})\/?$/)
  return m ? `${SITE_URL}/join/${m[1]}` : null
}

/** The invite page's path, and where to sign in so you come back to it. */
export const joinPagePath = (room) => `/join/${room}`
export const signInForJoin = (room) => `/signin?next=${encodeURIComponent(joinPagePath(room))}`

const key = (room) => `quilt-join:${room}`

/** Keeps an invite's secret in `storage` (localStorage) while its owner signs in. */
export function rememberJoin (storage, room, secret, now = Date.now()) {
  if (!storage || !isRoom(room) || !secret) return
  try { storage.setItem(key(room), JSON.stringify({ secret: String(secret), at: now })) } catch {}
}

/** The secret remembered for a room, or '' when there is none or it is over an hour old. */
export function recallJoin (storage, room, now = Date.now()) {
  if (!storage || !isRoom(room)) return ''
  try {
    const v = JSON.parse(storage.getItem(key(room)) || 'null')
    if (!v || typeof v.secret !== 'string' || !v.secret || typeof v.at !== 'number') return ''
    if (now - v.at >= JOIN_TTL_MS) { storage.removeItem(key(room)); return '' }
    return v.secret
  } catch {
    return ''
  }
}
