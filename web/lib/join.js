// Invites: https://join.heyquilt.com/<room>#<secret>. The secret stays in the
// fragment, so it never reaches a server; the page reads it in the browser.
export const JOIN_HOST = 'join.heyquilt.com'
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/

export const isRoom = (room) => ROOM_RE.test(String(room ?? ''))

/** What the page shows for a room and the fragment it was opened with (location.hash). */
export function joinView (room, hash = '') {
  const secret = String(hash || '').replace(/^#/, '')
  if (!isRoom(room) || !secret) return { missing: true }
  const link = `https://${JOIN_HOST}/${room}#${secret}`
  return { missing: false, link, open: `quilt://join?invite=${encodeURIComponent(link)}` }
}

/** The app route a join.heyquilt.com path is served from, or null when it isn't an invite. */
export function joinPath (pathname) {
  const m = String(pathname || '').match(/^\/([A-Za-z0-9_-]{1,64})\/?$/)
  return m ? `/join/${m[1]}` : null
}
