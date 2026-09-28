import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import ignore from 'ignore'

export const MAX_TEXT_BYTES = 2 * 1024 * 1024
export const MAX_BINARY_BYTES = 8 * 1024 * 1024

// Never synced, regardless of .gitignore. .env files are excluded so secrets
// stay on each person's machine.
const ALWAYS_IGNORED = [
  '.git', '.cowove', 'node_modules', '.DS_Store', 'Thumbs.db',
  '.env', '.env.*', '!.env.example',
  '*.swp', '*.swo', '*~', '.#*'
]

export function toPosix (p) {
  return p.split(path.sep).join('/')
}

/** Builds the ignore matcher from built-ins, .gitignore and .cowoveignore. */
export function loadIgnore (root) {
  const ig = ignore().add(ALWAYS_IGNORED)
  for (const file of ['.gitignore', '.cowoveignore']) {
    try { ig.add(fs.readFileSync(path.join(root, file), 'utf8')) } catch {}
  }
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

/**
 * Resolves a relative path to an absolute one inside root, making sure no
 * symlinked parent directory points outside of it.
 */
export function resolveInside (root, rel) {
  const abs = path.join(root, ...rel.split('/'))
  const realRoot = fs.realpathSync(root)
  let dir = path.dirname(abs)
  // Find the deepest existing ancestor and check where it really points.
  while (!fs.existsSync(dir)) dir = path.dirname(dir)
  const realDir = fs.realpathSync(dir)
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
    throw new Error(`refusing to write outside project: ${rel}`)
  }
  return abs
}

export function looksBinary (buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  // Invalid UTF-8 is treated as binary so it round-trips byte for byte.
  return !Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)
}

export function sha1 (buf) {
  return crypto.createHash('sha1').update(buf).digest('hex')
}

/** Recursively lists syncable files as posix relative paths. */
export function walk (root, ig) {
  const out = []
  const visit = (dirRel) => {
    let entries
    try { entries = fs.readdirSync(path.join(root, dirRel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name
      if (isIgnored(ig, rel)) continue
      if (e.isDirectory()) visit(rel)
      else if (e.isFile()) out.push(rel)
    }
  }
  visit('')
  return out
}

/** Whether two claim patterns can cover the same file (paths: files that exist now). */
export function patternsOverlap (a, b, paths = []) {
  if (a === b) return true
  const ma = globMatcher(a)
  const mb = globMatcher(b)
  return ma(b) || mb(a) || paths.some((p) => ma(p) && mb(p))
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
