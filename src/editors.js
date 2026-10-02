// Opens a session's folder in the AI coding app someone already has
// installed (Claude, Cursor, Codex...), so their AI works right where the
// files sync and its chats reach the session's feed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, execFileSync, spawn } from 'node:child_process'

// `tool` matches the AI tool names people pick in their profile. On a Mac,
// `mac` is the app bundle; `url` builds a link the app opens instead of the
// folder being handed to it; `cli` is the app's own command-line launcher
// inside the bundle, run with `args` before the folder. On Windows, `win` is
// the exe under %LOCALAPPDATA%. `winCli` is that install's command-line
// launcher, relative to the exe; opening through it (see openCommand) brings
// the window forward when the app is already running.
export const EDITORS = [
  // The Claude app's own "new session in this folder" link loses the folder
  // once you type, so a session is made in the folder first (see openInClaude)
  // and the app opens that; the link is only the fallback.
  // On Windows the Store build is found by its package folder or the claude://
  // link it registers. The versioned WindowsApps path changes on every update.
  { id: 'claude', name: 'Claude Code', tool: 'Claude Code', mac: 'Claude', win: 'AnthropicClaude/claude.exe', winMore: ['Programs/Claude/Claude.exe'], winPackage: 'Claude_pzs8sxrjxfjjc', protocol: 'claude', url: (dir) => `claude://code/new?folder=${encodeURIComponent(dir)}` },
  // Cursor otherwise opens its Agents window, whose chats stay on whatever
  // project was used last; a classic window ties the agent to this folder.
  { id: 'cursor', name: 'Cursor', tool: 'Cursor', mac: 'Cursor', cli: 'Contents/Resources/app/bin/cursor', args: ['--classic', '--new-window'], win: 'Programs/cursor/Cursor.exe', winCli: 'resources/app/bin/cursor.cmd' },
  { id: 'codex', name: 'Codex', tool: 'Codex', mac: 'Codex' },
  { id: 'windsurf', name: 'Windsurf', tool: 'Windsurf', mac: 'Windsurf', win: 'Programs/Windsurf/Windsurf.exe' },
  { id: 'vscode', name: 'VS Code', tool: 'GitHub Copilot', mac: 'Visual Studio Code', win: 'Programs/Microsoft VS Code/Code.exe' },
  { id: 'zed', name: 'Zed', tool: 'Zed', mac: 'Zed' }
]

/** Where an editor is installed on this computer, or null. */
function locate (ed, opts = {}) {
  const { platform = process.platform, home = os.homedir(), exists = fs.existsSync, localAppData = process.env.LOCALAPPDATA } = opts
  if (platform === 'darwin') {
    for (const dir of ['/Applications', path.join(home, 'Applications')]) {
      const app = path.join(dir, `${ed.mac}.app`)
      if (ed.mac && exists(app)) return app
    }
    return null
  }
  if (platform === 'win32') {
    const local = localAppData || path.join(home, 'AppData', 'Local')
    const candidates = [
      ...(ed.win ? [ed.win] : []),
      ...(ed.winMore || []),
      ...(ed.winPackage ? [`Packages/${ed.winPackage}`] : [])
    ]
    for (const rel of candidates) {
      const found = path.join(local, ...rel.split('/'))
      if (exists(found)) return found
    }
    if (ed.protocol && hasProtocol(ed.protocol, opts)) return `${ed.protocol}://`
    return null
  }
  return null
}

/** Whether `name://` is a registered link on this computer. `protocols` is for tests. */
function hasProtocol (name, { protocols, query = execFileSync } = {}) {
  if (protocols) return protocols(name)
  if (process.platform !== 'win32') return false
  try {
    query('reg', ['query', `HKCU\\Software\\Classes\\${name}`, '/v', 'URL Protocol'], { windowsHide: true, stdio: 'ignore', timeout: 3000 })
    return true
  } catch { return false }
}

/** The editors installed here, in list order: [{ id, name, tool }]. */
export function installedEditors (opts) {
  return EDITORS.filter((ed) => locate(ed, opts)).map(({ id, name, tool }) => ({ id, name, tool }))
}

/** The command that opens `dir` in editor `id`: [file, args, runOpts?]. */
export function openCommand (id, dir, opts = {}) {
  const ed = EDITORS.find((e) => e.id === id)
  if (!ed) throw new Error('Unknown app.')
  const where = locate(ed, opts)
  if (!where) throw new Error(`${ed.name} isn't installed on this computer.`)
  const platform = opts.platform || process.platform
  const args = ed.args || []
  if (platform === 'darwin') {
    if (ed.url) return ['open', [ed.url(dir)]]
    if (ed.cli) return [path.join(where, ...ed.cli.split('/')), [...args, dir]]
    return ['open', ['-a', where, dir]]
  }
  if (ed.url) return ['cmd', ['/c', 'start', '""', ed.url(dir)]]
  // Launching Cursor.exe while it is already open hands the folder to the
  // running instance and leaves that window behind whatever is in front.
  // `start` of its CLI activates the window on the folder instead.
  if (ed.winCli) {
    const cli = path.join(path.dirname(where), ...ed.winCli.split('/'))
    const exists = opts.exists || fs.existsSync
    if (exists(cli)) return ['cmd.exe', ['/c', 'start', '', cli, ...args, dir], { activate: true }]
  }
  return [where, [...args, dir]]
}

const run = (file, args, opts = {}) => {
  // `start` returns as soon as the app is activated; waiting would hold the
  // button until the launcher's console exits.
  if (opts.activate) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false })
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolve() })
    })
  }
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, timeout: 60000, ...opts }, (err) => (err ? reject(err) : resolve()))
    child.stdin?.end() // the Claude CLI waits for stdin to close before running a prompt
  })
}

/** The Claude Code command-line tool: installed on its own, or the copy inside the Claude app. */
export function claudeCli ({ platform = process.platform, home = os.homedir(), exists = fs.existsSync, readdir = fs.readdirSync } = {}) {
  const exe = platform === 'win32' ? 'claude.exe' : 'claude'
  const dirs = [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin',
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean)]
  for (const d of dirs) if (exists(path.join(d, exe))) return path.join(d, exe)
  if (platform === 'darwin') {
    const bundled = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code')
    let versions = []
    try { versions = readdir(bundled) } catch {}
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const v of versions) {
      const cli = path.join(bundled, v, 'claude.app', 'Contents', 'MacOS', 'claude')
      if (exists(cli)) return cli
    }
  }
  return null
}

/** How a new Claude Code session named after the folder is made, without a model call. */
export function claudeSessionCommand (cli, dir, id) {
  return [cli, ['-p', `/rename ${path.basename(dir)} (quilt)`, '--session-id', id], { cwd: dir }]
}

async function openInClaude (dir, opts) {
  const [file, args] = openCommand('claude', dir, opts) // checks it's installed; the folder link is the fallback
  const cli = claudeCli(opts)
  if (cli) {
    const id = crypto.randomUUID()
    try {
      await run(...claudeSessionCommand(cli, dir, id))
      const link = `claude://resume?session=${id}`
      return await run(...(process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', link]] : ['open', [link]]))
    } catch {} // fall back to the folder link
  }
  await run(file, args)
}

export async function openIn (id, dir, opts) {
  dir = path.resolve(dir)
  try {
    if (id === 'claude') return await openInClaude(dir, opts)
    await run(...openCommand(id, dir, opts))
  } catch (err) {
    throw new Error(`Could not open it: ${err.message}`)
  }
}
