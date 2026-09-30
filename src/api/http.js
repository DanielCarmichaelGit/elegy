// Small pieces every API route module shares.
export class HttpError extends Error { constructor (status, message) { super(message); this.status = status } }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ids are uuids; anything else can't exist (and Postgres would reject it), so it's a 404. */
export function needId (id, what = 'thing') {
  if (!UUID.test(String(id || ''))) throw new HttpError(404, `no such ${what}`)
  return String(id)
}

/** A trimmed name with no control characters (it may end up in an email subject). */
export function cleanName (value, max, message) {
  const s = Array.from(String(value ?? ''), (ch) => (ch < ' ' || ch === '\u007f' ? ' ' : ch)).join('').trim().slice(0, max).trim()
  if (!s) throw new HttpError(400, message)
  return s
}
