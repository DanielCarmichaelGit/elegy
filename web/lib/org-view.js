// Pure helpers for the Org area, no Next imports, so they're unit-tested directly.
import { can } from './permissions.js'

/** Whether the viewer may do `op` on `resource` in this org (the owner may do everything). */
export function allowed (me, resource, op) {
  return !!me && (me.isOwner || can(me.grants, resource, op))
}

/** The Org area's tabs, per the viewer's Read permissions. Everyone sees their own teams. */
export function orgTabs (slug, me) {
  const base = `/org/${slug}`
  return [
    { href: base, label: 'Overview' },
    allowed(me, 'members', 'r') && { href: `${base}/people`, label: 'People' },
    { href: `${base}/teams`, label: 'Teams' },
    allowed(me, 'roles', 'r') && { href: `${base}/roles`, label: 'Roles' },
    allowed(me, 'invites', 'r') && { href: `${base}/invites`, label: 'Invites' },
    allowed(me, 'org', 'r') && { href: `${base}/settings`, label: 'Settings' }
  ].filter(Boolean)
}

// Messages come back through the query string; show them only if they look like ours.
const SAFE = /^[\p{L}\p{N}\s.,;:'’()@?!_–—-]{1,200}$/u
export function safeMessage (s) {
  if (!s) return null
  return typeof s === 'string' && SAFE.test(s) ? s : 'Something went wrong. Try again.'
}

// Pages render on the server (UTC on Netlify), so the zone is pinned and labelled.
// dateStyle/timeStyle can't be combined with timeZoneName (it throws), hence the fields.
const WHEN = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }
/** A date for server-rendered pages: epoch ms (API) or an ISO string (Supabase). */
export function when (t) {
  return t ? new Date(t).toLocaleString('en', WHEN) : 'never'
}
