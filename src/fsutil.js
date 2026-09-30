import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { makeIgnore, isIgnored, scopeIgnore, IGNORE_FILES } from './pathrules.js'

export { IGNORE_FILES } from './pathrules.js'
export { MAX_TEXT_BYTES, MAX_BINARY_BYTES, isIgnored, isSafeRelPath, globMatcher, patternsOverlap } from './pathrules.js'

export function toPosix (p) {
  return p.split(path.sep).join('/')
}

/**
 * Builds the ignore matcher from built-ins and every .gitignore / .quiltignore
 * in the project, each applying to its own folder. Folders already ignored
 * aren't searched, so a .gitignore inside node_modules has no say.
 */
export function loadIgnore (root) {
  const ig = makeIgnore()
  const visit = (dirRel) => {
    const dir = path.join(root, dirRel)
    for (const file of IGNORE_FILES) {
      try { ig.add(scopeIgnore(fs.readFileSync(path.join(dir, file), 'utf8'), dirRel)) } catch {}
    }
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name
      if (!isIgnored(ig, rel)) visit(rel)
    }
  }
  visit('')
  return ig
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
