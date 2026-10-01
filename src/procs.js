// Registry of running quilt processes (relays, the app, folder syncs) so
// `quilt stop` and the app's Shut down button can stop all of them.
// Each process writes ~/.quilt/procs/<pid>.json and removes it on exit.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { quiltHome } from './legacy.js'

const procsDir = () => path.join(quiltHome(), 'procs')

const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

/** Records this process as a running quilt `kind` ('relay', 'app', 'sync'). */
export function registerProcess (kind, info = {}) {
  const file = path.join(procsDir(), `${process.pid}.json`)
  fs.mkdirSync(procsDir(), { recursive: true, mode: 0o700 })
  // Private: an app's entry carries its link (with the per-launch token).
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, kind, ...info, startedAt: Date.now() }), { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  process.on('exit', () => { try { fs.rmSync(file, { force: true }) } catch {} })
}

/** Running quilt processes, oldest first. Cleans up entries for dead ones. */
export function listProcesses () {
  let files = []
  try { files = fs.readdirSync(procsDir()).filter((f) => f.endsWith('.json')) } catch { return [] }
  const out = []
  for (const f of files) {
    const file = path.join(procsDir(), f)
    let info
    try { info = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { info = null }
    if (info && alive(info.pid)) out.push(info)
    else fs.rmSync(file, { force: true })
  }
  return out.sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * Stops every registered quilt process except `exclude` (a pid). Asks nicely
 * first (so syncs flush and relays save), then force-kills stragglers.
 * Returns the processes that were stopped.
 */
export async function stopProcesses ({ exclude = process.pid, timeoutMs = 5000 } = {}) {
  const targets = listProcesses().filter((p) => p.pid !== exclude)
  for (const p of targets) { try { process.kill(p.pid, 'SIGTERM') } catch {} }
  const deadline = Date.now() + timeoutMs
  while (targets.some((p) => alive(p.pid)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  for (const p of targets) {
    if (alive(p.pid)) { try { process.kill(p.pid, 'SIGKILL') } catch {} }
    fs.rmSync(path.join(procsDir(), `${p.pid}.json`), { force: true })
  }
  return targets
}

/** The newest running app's private link, preferring the desktop app; null if none. */
export function runningAppUrl () {
  const apps = listProcesses().filter((p) => p.kind === 'app' && p.url)
  const pick = apps.filter((p) => p.desktop).pop() || apps.pop()
  return pick ? pick.url : null
}

/** One-line description of a registered process, for `quilt stop`. */
export function describeProcess (p) {
  if (p.kind === 'relay') return `relay on :${p.port} (pid ${p.pid})`
  if (p.kind === 'app') return `app on :${p.port} (pid ${p.pid})`
  if (p.kind === 'sync') return `sync of ${p.dir} (pid ${p.pid})`
  return `${p.kind} (pid ${p.pid})`
}
