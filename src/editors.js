// Opens a session's folder in the AI coding app someone already has
// installed (Claude, Cursor, Codex...), so their AI works right where the
// files sync and its chats reach the session's feed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

// `tool` matches the AI tool names people pick in their profile. On a Mac,
// `mac` is the app bundle; `url` builds a link the app opens instead of the
// folder being handed to it. On Windows, `win` is the exe under %LOCALAPPDATA%.
export const EDITORS = [
  { id: 'claude', name: 'Claude Code', tool: 'Claude Code', mac: 'Claude', win: 'AnthropicClaude/claude.exe', url: (dir) => `claude://code/new?folder=${encodeURIComponent(dir)}` },
  { id: 'cursor', name: 'Cursor', tool: 'Cursor', mac: 'Cursor', win: 'Programs/cursor/Cursor.exe' },
  { id: 'codex', name: 'Codex', tool: 'Codex', mac: 'Codex' },
  { id: 'windsurf', name: 'Windsurf', tool: 'Windsurf', mac: 'Windsurf', win: 'Programs/Windsurf/Windsurf.exe' },
  { id: 'vscode', name: 'VS Code', tool: 'GitHub Copilot', mac: 'Visual Studio Code', win: 'Programs/Microsoft VS Code/Code.exe' },
  { id: 'zed', name: 'Zed', tool: 'Zed', mac: 'Zed' }
]

/** Where an editor is installed on this computer, or null. */
function locate (ed, { platform = process.platform, home = os.homedir(), exists = fs.existsSync } = {}) {
  if (platform === 'darwin') {
    for (const dir of ['/Applications', path.join(home, 'Applications')]) {
      const app = path.join(dir, `${ed.mac}.app`)
      if (ed.mac && exists(app)) return app
    }
    return null
  }
  if (platform === 'win32' && ed.win) {
    const exe = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), ...ed.win.split('/'))
    return exists(exe) ? exe : null
  }
  return null
}

/** The editors installed here, in list order: [{ id, name, tool }]. */
export function installedEditors (opts) {
  return EDITORS.filter((ed) => locate(ed, opts)).map(({ id, name, tool }) => ({ id, name, tool }))
}

/** The command that opens `dir` in editor `id`: [file, args]. */
export function openCommand (id, dir, opts = {}) {
  const ed = EDITORS.find((e) => e.id === id)
  if (!ed) throw new Error('Unknown app.')
  const where = locate(ed, opts)
  if (!where) throw new Error(`${ed.name} isn't installed on this computer.`)
  const platform = opts.platform || process.platform
  if (platform === 'darwin') return ed.url ? ['open', [ed.url(dir)]] : ['open', ['-a', where, dir]]
  if (ed.url) return ['cmd', ['/c', 'start', '""', ed.url(dir)]]
  return [where, [dir]]
}

export function openIn (id, dir, opts) {
  const [file, args] = openCommand(id, path.resolve(dir), opts)
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (err) => (err ? reject(new Error(`Could not open it: ${err.message}`)) : resolve()))
  })
}
