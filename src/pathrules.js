// Which paths are synced, and which are safe to accept from a peer. No Node
// APIs here: the web app uses the same rules as the CLI.
import ignore from 'ignore'

export const MAX_TEXT_BYTES = 2 * 1024 * 1024
export const MAX_BINARY_BYTES = 8 * 1024 * 1024

// Never synced, regardless of .gitignore. .env files are excluded so secrets
// stay on each person's machine.
export const ALWAYS_IGNORED = [
  '.git', '.cowove', 'node_modules', '.DS_Store', 'Thumbs.db',
  '.env', '.env.*', '!.env.example',
  '*.swp', '*.swo', '*~', '.#*'
]

/** An ignore matcher from the built-ins plus the text of .gitignore / .cowoveignore files. */
export function makeIgnore (texts = []) {
  const ig = ignore().add(ALWAYS_IGNORED)
  for (const t of texts) if (t) ig.add(t)
  return ig
}

export function isIgnored (ig, rel) {
  if (!rel || rel === '.') return false
  // Check every ancestor directory so "dist/" also excludes "dist/a/b.js".
  const parts = rel.split('/')
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join('/')
    if (ig.ignores(sub)) return true
    if (i < parts.length && ig.ignores(sub + '/')) return true
  }
  return false
}

/**
 * Validates a path received from a peer. Rejects anything that could escape
 * the project folder or touch git internals.
 */
export function isSafeRelPath (rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 1024) return false
  if (rel.includes('\\') || rel.includes('\0')) return false
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false
  const parts = rel.split('/')
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return false
  }
  const first = parts[0].toLowerCase()
  if (first === '.git' || first === '.cowove') return false
  return true
}

/** Converts a simple glob (*, **, ?) or a plain path/folder into a matcher. */
export function globMatcher (pattern) {
  let p = pattern.trim().replace(/^\.\//, '')
  if (!/[*?]/.test(p)) {
    const base = p.replace(/\/+$/, '')
    return (rel) => rel === base || rel.startsWith(base + '/')
  }
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*' && p[i + 1] === '*') {
      re += '.*'
      i++
      if (p[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const rx = new RegExp(`^${re}$`)
  return (rel) => rx.test(rel)
}
