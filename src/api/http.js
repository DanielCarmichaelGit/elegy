// Small pieces every API route module shares.
export class HttpError extends Error { constructor (status, message) { super(message); this.status = status } }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ids are uuids; anything else can't exist (and Postgres would reject it), so it's a 404. */
export function needId (id, what = 'thing') {
  if (!UUID.test(String(id || ''))) throw new HttpError(404, `no such ${what}`)
  return String(id)
}

// C0/C1 controls, zero-width characters, and bidi overrides/isolates: none of
// these belong in a name, and a bidi override can make a name display backwards
// or hide characters, e.g. in an email subject.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠⁦-⁩؜]/

/** The code points of `value` with control/zero-width/bidi characters removed. */
export function stripInvisible (value) {
  return Array.from(String(value ?? '')).filter((ch) => !INVISIBLE.test(ch))
}

/** A trimmed name with no control characters (it may end up in an email subject).
 * Slices by code point, not UTF-16 unit, so cutting at `max` never splits a
 * surrogate pair (e.g. an emoji) into two lone, invalid surrogates. */
export function cleanName (value, max, message) {
  const s = stripInvisible(value).slice(0, max).join('').trim()
  if (!s) throw new HttpError(400, message)
  return s
}
