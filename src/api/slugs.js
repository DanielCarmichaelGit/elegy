// Org addresses: /org/<slug>. Lowercase letters, digits and single hyphens.
// "personal" is the space switcher's name for your own space; "new" and
// "discover" are words routes might want.
const RESERVED = new Set(['personal', 'new', 'discover'])

export function slugify (name) {
  const s = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  if (!s) return 'org'
  return RESERVED.has(s) ? `${s}-org` : s
}

/** The first of base, base-2, base-3, ... that `taken` says is free. */
export async function uniqueSlug (name, taken) {
  const base = slugify(name)
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`
    if (!await taken(slug)) return slug
  }
}
