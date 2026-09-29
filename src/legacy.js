// Quilt was called cowove until 2026-09-28. Existing installs keep working:
// ~/.cowove and a project's .cowove folder are moved to .quilt the first time
// they're needed, and COWOVE_* settings count as QUILT_* ones.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Moves <parent>/.cowove to <parent>/.quilt if only the old one exists. */
export function migrateDir (parent) {
  const cur = path.join(parent, '.quilt')
  const old = path.join(parent, '.cowove')
  try { if (!fs.existsSync(cur) && fs.existsSync(old)) fs.renameSync(old, cur) } catch {}
  return cur
}

/** ~/.quilt: settings, identity, recent sessions, running processes. */
export const quiltHome = () => migrateDir(os.homedir())

/** Copies COWOVE_* variables to their QUILT_* names unless those are set. */
export function adoptLegacyEnv (env = process.env) {
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('COWOVE_') && env[`QUILT_${k.slice(7)}`] === undefined) env[`QUILT_${k.slice(7)}`] = v
  }
  return env
}
