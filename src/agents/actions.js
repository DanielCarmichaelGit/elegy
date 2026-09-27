// Turns an AI tool call into one short, shareable line ("Edited src/app.ts",
// "Ran npm test"). Deliberately lossy: command arguments, file contents and
// output never leave the machine.
import path from 'node:path'

const EDIT = new Set(['edit', 'multiedit', 'notebookedit', 'edit_file', 'search_replace', 'str_replace', 'apply_patch', 'write'])
const READ = new Set(['read', 'read_file'])
const SEARCH = new Set(['grep', 'glob', 'grep_search', 'file_search', 'glob_file_search', 'codebase_search', 'list_dir', 'ls'])
const RUN = new Set(['bash', 'run_terminal_cmd', 'run_terminal_command', 'run_command', 'shell'])
const DELETE = new Set(['delete_file'])

/**
 * @param {string} tool   tool name as the agent reported it
 * @param {object} input  tool input
 * @param {string} dir    the synced folder, for relative paths
 * @param {{ existed?: (abs: string) => boolean }} [opts]
 */
export function describeAction (tool, input = {}, dir = '', opts = {}) {
  const name = String(tool || '').trim()
  // Cursor versions its tools ("edit_file_v2"); the suffix doesn't change what they do.
  const key = name.toLowerCase().replace(/_v\d+$/, '')
  input = input && typeof input === 'object' ? input : {}

  if (EDIT.has(key)) {
    const file = pickPath(input)
    const shown = file ? rel(file, dir) : 'a file'
    if (key === 'write' && file && opts.existed && !opts.existed(path.resolve(dir || '/', file))) return `Created ${shown}`
    return `Edited ${shown}`
  }
  if (DELETE.has(key)) {
    const file = pickPath(input)
    return file ? `Deleted ${rel(file, dir)}` : 'Deleted a file'
  }
  if (READ.has(key)) {
    const file = pickPath(input)
    return file ? `Read ${rel(file, dir)}` : 'Read a file'
  }
  if (SEARCH.has(key)) return 'Searched the code'
  if (RUN.has(key)) {
    const cmd = summarizeCommand(input.command ?? input.cmd ?? '')
    return cmd ? `Ran ${cmd}` : 'Ran a command'
  }
  return `Used ${name || 'a tool'}`
}

function pickPath (input) {
  for (const k of ['file_path', 'path', 'target_file', 'notebook_path', 'filePath', 'relative_workspace_path']) {
    if (typeof input[k] === 'string' && input[k]) return input[k]
  }
  return null
}

function rel (file, dir) {
  if (!dir || !path.isAbsolute(file)) return file.replace(/^\.\//, '')
  const r = path.relative(dir, file)
  // Paths outside the project are reduced to their file name.
  if (r.startsWith('..') || path.isAbsolute(r)) return path.basename(file)
  return r.split(path.sep).join('/')
}

const SETUP = new Set(['cd', 'pushd', 'export', 'set', 'source', '.', 'true'])

/** "FOO=1 npm test -- --watch" -> "npm test". Only the program and one plain word survive. */
export function summarizeCommand (command) {
  // "cd app && npm test" is really "npm test": skip setup steps.
  const steps = String(command).split(/&&|;|\|\|/).map((s) => s.trim()).filter(Boolean)
  const main = steps.find((s) => {
    const w = s.split(/\s+/).filter((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x))
    return w.length && !SETUP.has(w[0])
  })
  // Only setup steps (e.g. just "cd somewhere"): show the program, not where it went.
  return main ? summarizeStep(main) : summarizeStep(steps[0] || '').split(' ')[0]
}

function summarizeStep (step) {
  const words = String(step).trim().split(/\s+/).filter(Boolean)
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift()
  if (!words.length) return ''
  let program = words[0]
  // Show a program's name, never where it lives (paths can contain user names).
  if (program.includes('/')) program = program.split('/').filter(Boolean).pop() || ''
  if (!/^[A-Za-z0-9][\w.+-]*$/.test(program)) return ''
  const next = words[1]
  return next && /^[a-z][\w:-]*$/.test(next) ? `${program} ${next}` : program
}
