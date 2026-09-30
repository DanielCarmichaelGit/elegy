// Pure, no Next imports, so it can be unit-tested directly.
// The space switcher: "personal" or one of your orgs, remembered in a cookie.
export const SPACE_COOKIE = 'quilt_space'
export const PERSONAL = 'personal'

// The API's slug format (src/api/slugs.js): lowercase letters, digits, single hyphens.
export function isSlug (s) {
  return typeof s === 'string' && s.length <= 48 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)
}

/** Where a remembered space leads: an org you're still in, otherwise your personal dashboard. */
export function spaceHome (value, orgs) {
  const org = isSlug(value) && value !== PERSONAL ? (orgs || []).find((o) => o.slug === value) : null
  return org ? `/org/${org.slug}` : '/dashboard'
}
