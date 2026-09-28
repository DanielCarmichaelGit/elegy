// Git and GitHub for the session host: clone a repo to start a session, then
// pull, commit, push and open a pull request. Wraps the `git` and `gh` CLIs;
// arguments are always passed as a list, never through a shell.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

// COWOVE_GH lets tests stand in a fake `gh`.
const GH = () => process.env.COWOVE_GH || 'gh'
const REPO_RE = /^[\w.-]+\/[\w.-]+$/
// Never stop to ask for a password or open an editor.
const ENV = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_EDITOR: 'true', GH_NO_UPDATE_NOTIFIER: '1' }

/** Runs a command; resolves to stdout, or rejects with a short message from stderr. */
function run (cmd, args, { cwd, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env: { ...process.env, ...ENV }, maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      if (allowFail) return resolve(null)
      if (err.code === 'ENOENT') return reject(new Error(cmd === GH() ? 'The GitHub CLI (gh) is not installed.' : 'git is not installed.'))
      const e = new Error(shortError(stderr || stdout || err.message))
      e.stderr = String(stderr || '')
      e.exitCode = err.code
      reject(e)
    })
  })
}
const git = (dir, args, opts) => run('git', args, { cwd: dir, ...opts })
const gh = (args, opts) => run(GH(), args, opts)

/** The first useful line of a CLI error, without "fatal:"/"error:" noise. */
function shortError (text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean)
  const line = lines.find((l) => /^(fatal|error|remote|GraphQL|HTTP)/i.test(l)) || lines[0] || 'Something went wrong.'
  return line.replace(/^(fatal|error):\s*/i, '').replace(/^remote:\s*/i, '').slice(0, 300)
}

/** Throws unless `name` is a valid branch name. */
export async function checkBranchName (name) {
  name = String(name || '').trim()
  if (!name) throw new Error('Enter a branch name.')
  if (name.startsWith('-') || (await run('git', ['check-ref-format', '--branch', name], { allowFail: true })) === null) {
    throw new Error(`"${name}" isn't a valid branch name.`)
  }
  return name
}

function checkRepo (repo) {
  repo = String(repo || '').trim()
  if (!REPO_RE.test(repo) || repo.split('/').some((p) => /^\.+$/.test(p))) throw new Error('Pick a repository (owner/name).')
  return repo
}

/** True if `dir` is the top of a git work tree (not just somewhere inside one). */
export function isRepo (dir) {
  return !!dir && fs.existsSync(path.join(dir, '.git'))
}

// --------------------------------------------------------------- GitHub --

/** Is gh installed and signed in? { installed, authenticated, user, message } */
export async function ghStatus () {
  const probe = (args) => new Promise((resolve) => {
    execFile(GH(), args, { env: { ...process.env, ...ENV }, timeout: 20000 }, (err, stdout, stderr) => resolve({ err, text: `${stdout}\n${stderr}` }))
  })
  const version = await probe(['--version'])
  if (version.err && version.err.code === 'ENOENT') return { installed: false, authenticated: false, user: null, message: 'Install the GitHub CLI (gh), then run `gh auth login`.' }
  const out = await probe(['auth', 'status', '--hostname', 'github.com'])
  if (out.err) return { installed: true, authenticated: false, user: null, message: 'Run `gh auth login` in a terminal to connect GitHub.' }
  const user = (out.text.match(/account (\S+)/) || out.text.match(/as (\S+)/) || [])[1] || null
  return { installed: true, authenticated: true, user, message: null }
}

/** Your repos, plus your organizations' repos, most recently updated first. */
export async function listRepos ({ limit = 100 } = {}) {
  limit = Math.max(1, Math.min(1000, Number(limit) || 100))
  const fields = ['--json', 'nameWithOwner,description,updatedAt,defaultBranchRef']
  const parse = (out) => { try { return JSON.parse(out || '[]') } catch { return [] } }
  const mine = parse(await gh(['repo', 'list', ...fields, '--limit', String(limit)]))
  const orgs = String(await gh(['api', 'user/orgs', '--jq', '.[].login'], { allowFail: true }) || '').split('\n').filter(Boolean).slice(0, 10)
  const theirs = await Promise.all(orgs.map((o) => gh(['repo', 'list', o, ...fields, '--limit', String(Math.min(limit, 100))], { allowFail: true }).then(parse)))
  const seen = new Set()
  return [...mine, ...theirs.flat()]
    .filter((r) => r && r.nameWithOwner && !seen.has(r.nameWithOwner) && seen.add(r.nameWithOwner))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .map((r) => ({ name: r.nameWithOwner, description: r.description || '', updatedAt: r.updatedAt || null, defaultBranch: r.defaultBranchRef?.name || null }))
}

/** Branch names of a GitHub repo, and which one is the default. */
export async function listBranches (repo) {
  repo = checkRepo(repo)
  const [names, def] = await Promise.all([
    gh(['api', `repos/${repo}/branches`, '--paginate', '--jq', '.[].name']),
    gh(['api', `repos/${repo}`, '--jq', '.default_branch'])
  ])
  const defaultBranch = def.trim() || null
  const branches = names.split('\n').map((s) => s.trim()).filter(Boolean)
  // Default branch first, then alphabetical.
  branches.sort((a, b) => (a === defaultBranch ? -1 : b === defaultBranch ? 1 : a.localeCompare(b)))
  return { branches, defaultBranch }
}

/**
 * Clones `repo` into `dir` (which must be new or empty), then checks out
 * `branch`, or creates `newBranch` from origin/`base` (default: the default branch).
 */
export async function cloneRepo ({ repo, dir, branch, newBranch, base }) {
  repo = checkRepo(repo)
  if (!dir) throw new Error('Choose a folder to clone into.')
  dir = path.resolve(dir)
  if (branch) branch = await checkBranchName(branch)
  if (newBranch) newBranch = await checkBranchName(newBranch)
  if (base) base = await checkBranchName(base)
  const existed = fs.existsSync(dir)
  if (existed && fs.readdirSync(dir).some((f) => f !== '.DS_Store')) {
    throw new Error(`${path.basename(dir)} already has files in it. Pick an empty or new folder.`)
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  try {
    await gh(['repo', 'clone', repo, dir])
    const has = async (b) => (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`], { allowFail: true })) !== null
    if (newBranch) {
      base = base || await defaultBranchOf(dir)
      if (!base || !(await has(base))) throw new Error(`There's no branch named ${base} on GitHub to start from.`)
      if (await has(newBranch)) throw new Error(`A branch named ${newBranch} already exists. Use it instead, or pick another name.`)
      await git(dir, ['checkout', '-q', '--no-track', '-b', newBranch, `origin/${base}`])
    } else if (branch) {
      const current = (await git(dir, ['branch', '--show-current'])).trim()
      if (branch !== current) {
        if (!(await has(branch))) throw new Error(`There's no branch named ${branch} on GitHub.`)
        await git(dir, ['checkout', '-q', '-b', branch, '--track', `origin/${branch}`])
      }
    }
    return { dir, branch: (await git(dir, ['branch', '--show-current'])).trim() }
  } catch (err) {
    // Only clean up what we made.
    if (!existed) fs.rmSync(dir, { recursive: true, force: true })
    else for (const f of fs.readdirSync(dir)) if (f !== '.DS_Store') fs.rmSync(path.join(dir, f), { recursive: true, force: true })
    throw err
  }
}

// ---------------------------------------------------------------- local --

async function defaultBranchOf (dir) {
  const head = await git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true })
  if (head && head.trim()) return head.trim().replace(/^origin\//, '')
  for (const b of ['main', 'master']) {
    if ((await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`], { allowFail: true })) !== null) return b
  }
  return null
}

const STATUS_WORDS = { M: 'modified', T: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflicted' }
const word = (xy) => {
  const c = xy[0] !== '.' ? xy[0] : xy[1]
  return STATUS_WORDS[c] || 'modified'
}

/** { isRepo, branch, upstream, ahead, behind, changed: [{ path, status }], defaultBranch } */
export async function status (dir) {
  if (!isRepo(dir)) return { isRepo: false }
  const out = await git(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
  const parts = out.split('\0')
  const res = { isRepo: true, branch: null, upstream: null, ahead: 0, behind: 0, changed: [], defaultBranch: await defaultBranchOf(dir) }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    if (p.startsWith('# branch.head ')) res.branch = p.slice(14) === '(detached)' ? null : p.slice(14)
    else if (p.startsWith('# branch.upstream ')) res.upstream = p.slice(18)
    else if (p.startsWith('# branch.ab ')) {
      const m = p.match(/\+(\d+) -(\d+)/)
      if (m) { res.ahead = +m[1]; res.behind = +m[2] }
    } else if (p.startsWith('1 ')) res.changed.push({ path: p.split(' ').slice(8).join(' '), status: word(p.slice(2, 4)) })
    else if (p.startsWith('2 ')) { res.changed.push({ path: p.split(' ').slice(9).join(' '), status: word(p.slice(2, 4)) }); i++ } // next part is the old path
    else if (p.startsWith('u ')) res.changed.push({ path: p.split(' ').slice(10).join(' '), status: 'conflicted' })
    else if (p.startsWith('? ')) res.changed.push({ path: p.slice(2), status: 'new' })
  }
  // No upstream yet (a new branch): count commits not on the default branch.
  if (!res.upstream && res.branch && res.defaultBranch) {
    const n = await git(dir, ['rev-list', '--count', `origin/${res.defaultBranch}..HEAD`], { allowFail: true })
    if (n) res.ahead = +n.trim() || 0
  }
  return res
}

function mustBeRepo (dir) {
  if (!isRepo(dir)) throw new Error('This folder isn\'t a git repository.')
}

async function rebaseInProgress (dir) {
  const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
  return fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))
}

/**
 * Fetches, then rebases your commits onto origin/<base>, or the branch's
 * upstream, or the default branch. On a conflict the rebase is undone.
 */
export async function pull (dir, { base } = {}) {
  mustBeRepo(dir)
  if (await rebaseInProgress(dir)) throw new Error('A rebase is already in progress in this folder. Finish or abort it in a terminal first.')
  const st = await status(dir)
  if (!st.branch) throw new Error('You\'re not on a branch (detached HEAD).')
  if (st.changed.some((c) => c.status !== 'new')) throw new Error('Commit your changes first, then pull.')
  if (base) base = await checkBranchName(base)
  await git(dir, ['fetch', '--quiet', '--prune', 'origin'])
  const onto = base ? `origin/${base}` : st.upstream || (st.defaultBranch ? `origin/${st.defaultBranch}` : null)
  if (!onto) throw new Error('There\'s no branch on GitHub to pull from.')
  if ((await git(dir, ['rev-parse', '--verify', '--quiet', onto], { allowFail: true })) === null) throw new Error(`There's no ${onto} to pull from.`)
  const incoming = +(await git(dir, ['rev-list', '--count', `HEAD..${onto}`])).trim()
  if (!incoming) return { onto, pulled: 0, message: 'Already up to date.' }
  try {
    await git(dir, ['rebase', '--quiet', onto])
  } catch (err) {
    let files = []
    if (await rebaseInProgress(dir)) {
      files = String(await git(dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }) || '').split('\n').filter(Boolean)
      await git(dir, ['rebase', '--abort'], { allowFail: true })
    }
    if (files.length) throw new Error(`Pulling conflicts with your commits in ${files.slice(0, 5).join(', ')}${files.length > 5 ? '…' : ''}. Nothing was changed; resolve it in a terminal.`)
    throw new Error(`Couldn't pull: ${err.message}`)
  }
  return { onto, pulled: incoming, message: `Pulled ${incoming} commit${incoming === 1 ? '' : 's'} from ${onto}.` }
}

/** Stages everything and commits. */
/**
 * Whether this session's person hosts git: the folder is a repo and, in a
 * session with an owner, they own it. (Without an owner, whoever started it.)
 */
export function hostsGit (session, { joined = false } = {}) {
  const acc = session.access
  const host = acc && acc.controlled ? acc.owner : !joined
  return !!host && isRepo(session.root)
}

export async function commit (dir, message) {
  mustBeRepo(dir)
  message = String(message || '').trim()
  if (!message) throw new Error('Write a commit message.')
  await git(dir, ['add', '-A'])
  if ((await git(dir, ['diff', '--cached', '--quiet'], { allowFail: true })) !== null) throw new Error('Nothing to commit.')
  try {
    await git(dir, ['commit', '-q', '-m', message])
  } catch (err) {
    if (/tell me who you are|user\.email|user\.name/i.test(err.stderr || err.message)) throw new Error('Set your git name and email first (git config --global user.name / user.email).')
    throw err
  }
  const [hash, files] = await Promise.all([
    git(dir, ['rev-parse', '--short', 'HEAD']),
    git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])
  ])
  return { hash: hash.trim(), subject: message.split('\n')[0], files: files.split('\n').filter(Boolean).length }
}

/** Pushes the current branch and opens a pull request (or finds the open one). Returns { url, created }. */
export async function pushAndOpenPr (dir, { title, body, base } = {}) {
  mustBeRepo(dir)
  const st = await status(dir)
  if (!st.branch) throw new Error('You\'re not on a branch (detached HEAD).')
  base = base ? await checkBranchName(base) : st.defaultBranch
  if (!base) throw new Error('Couldn\'t tell which branch to open the pull request against.')
  if (st.branch === base) throw new Error(`You're on ${base}. Start a new branch to open a pull request.`)
  try {
    await git(dir, ['push', '--quiet', '-u', 'origin', 'HEAD'])
  } catch (err) {
    if (/rejected|non-fast-forward|fetch first/i.test(err.stderr || err.message)) throw new Error('GitHub has commits on this branch you don\'t have. Pull latest first.')
    throw err
  }
  title = String(title || '').trim() || (await git(dir, ['log', '-1', '--format=%s'])).trim()
  try {
    const out = await gh(['pr', 'create', '--title', title, '--body', String(body || ''), '--base', base, '--head', st.branch], { cwd: dir })
    return { url: lastUrl(out), created: true }
  } catch (err) {
    if (!/already exists/i.test(err.stderr || err.message)) throw err
    const out = await gh(['pr', 'view', st.branch, '--json', 'url', '--jq', '.url'], { cwd: dir })
    return { url: lastUrl(out), created: false }
  }
}

const lastUrl = (out) => (String(out).match(/https?:\/\/\S+/g) || []).pop() || String(out).trim()
