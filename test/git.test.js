// Git and GitHub integration, offline: a local bare repo plays GitHub, and a
// small fake `gh` (COWOVE_GH) clones from it and pretends to open PRs.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowove-git-')))
const home = path.join(root, 'home')
fs.mkdirSync(home)
process.env.HOME = home
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com'
})

const g = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text)
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8')

// "GitHub": a bare repo with main and dev.
const remote = path.join(root, 'remote.git')
g(root, 'init', '-q', '--bare', '-b', 'main', remote)
const seed = path.join(root, 'seed')
g(root, 'clone', '-q', remote, seed)
g(seed, 'checkout', '-q', '-b', 'main')
write(seed, 'README.md', 'line one\nline two\n')
g(seed, 'add', '-A')
g(seed, 'commit', '-q', '-m', 'first')
g(seed, 'push', '-q', 'origin', 'main')
g(seed, 'checkout', '-q', '-b', 'dev')
write(seed, 'dev.txt', 'dev\n')
g(seed, 'add', '-A')
g(seed, 'commit', '-q', '-m', 'dev work')
g(seed, 'push', '-q', 'origin', 'dev')
g(seed, 'checkout', '-q', 'main')

const fakeGh = path.join(root, 'gh.cjs')
fs.writeFileSync(fakeGh, `#!/usr/bin/env node
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const a = process.argv.slice(2)
const remote = ${JSON.stringify(remote)}
const k = a.slice(0, 2).join(' ')
const out = (s) => process.stdout.write(s + '\\n')
if (a[0] === '--version') out('gh version 0.0.0 (fake)')
else if (k === 'auth status') process.stderr.write('github.com\\n  ✓ Logged in to github.com account tester (keyring)\\n')
else if (k === 'repo clone') execFileSync('git', ['clone', '-q', remote, a[3]])
else if (k === 'repo list') out(JSON.stringify(a[2] === 'acme'
  ? [{ nameWithOwner: 'acme/site', description: 'Org site', updatedAt: '2026-01-02T00:00:00Z', defaultBranchRef: { name: 'main' } }]
  : [{ nameWithOwner: 'me/app', description: '', updatedAt: '2026-03-01T00:00:00Z', defaultBranchRef: { name: 'main' } }]))
else if (a[0] === 'api' && a[1] === 'user/orgs') out('acme')
else if (a[0] === 'api' && a[1].endsWith('/branches')) out(execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: remote, encoding: 'utf8' }).trim())
else if (a[0] === 'api') out('main')
else if (k === 'pr create') {
  const head = a[a.indexOf('--head') + 1]
  const marker = path.join(remote, 'pr-' + head.replace(/\\W/g, '_') + '.json')
  if (fs.existsSync(marker)) { process.stderr.write('a pull request for branch "' + head + '" into branch "main" already exists:\\nhttps://github.com/me/app/pull/1\\n'); process.exit(1) }
  fs.writeFileSync(marker, JSON.stringify(a))
  out('https://github.com/me/app/pull/1')
} else if (k === 'pr view') out('https://github.com/me/app/pull/1')
else { process.stderr.write('fake gh: unknown ' + a.join(' ') + '\\n'); process.exit(2) }
`, { mode: 0o755 })
process.env.COWOVE_GH = fakeGh

const git = await import('../src/git.js')
const clone = (name) => { const d = path.join(root, name); g(root, 'clone', '-q', remote, d); return d }
/** Someone else pushes a commit to main. */
function pushFromElsewhere (file, text) {
  const d = path.join(root, `other-${Math.random().toString(36).slice(2, 8)}`)
  g(root, 'clone', '-q', remote, d)
  write(d, file, text)
  g(d, 'add', '-A')
  g(d, 'commit', '-q', '-m', `edit ${file}`)
  g(d, 'push', '-q', 'origin', 'main')
}

test('branch names are validated with git check-ref-format', async () => {
  assert.equal(await git.checkBranchName(' feature/login '), 'feature/login')
  for (const bad of ['', 'bad..name', '-x', 'a b', 'x~1', 'end.lock', '@{-1}']) {
    await assert.rejects(git.checkBranchName(bad), /branch name/, bad)
  }
})

test('status: branch, upstream, ahead/behind and changed files', async () => {
  const dir = clone('status')
  let st = await git.status(dir)
  assert.deepEqual(st, { isRepo: true, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changed: [], defaultBranch: 'main' })

  write(dir, 'README.md', 'changed\n')
  fs.mkdirSync(path.join(dir, 'src'))
  write(dir, 'src/new file.js', 'x\n')
  st = await git.status(dir)
  assert.deepEqual(st.changed.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: 'README.md', status: 'modified' }, { path: 'src/new file.js', status: 'new' }
  ])
  g(dir, 'mv', 'README.md', 'READ.md')
  st = await git.status(dir)
  assert.ok(st.changed.some((c) => c.path === 'READ.md' && c.status === 'renamed'))

  assert.deepEqual(await git.status(path.join(root, 'nope')), { isRepo: false })
  assert.equal(git.isRepo(path.join(dir, 'src')), false, 'a subfolder of a repo is not a repo root')
})

test('commit: stages everything, refuses empty messages and empty commits', async () => {
  const dir = clone('commit')
  await assert.rejects(git.commit(dir, '   '), /commit message/)
  await assert.rejects(git.commit(dir, 'nothing here'), /Nothing to commit/)
  write(dir, 'a.txt', 'a\n')
  write(dir, 'README.md', 'new readme\n')
  const c = await git.commit(dir, 'Add a\n\nwith a body')
  assert.equal(c.subject, 'Add a')
  assert.equal(c.files, 2)
  assert.match(c.hash, /^[0-9a-f]{7,}$/)
  assert.equal(g(dir, 'log', '-1', '--format=%B'), 'Add a\n\nwith a body')
  const st = await git.status(dir)
  assert.equal(st.ahead, 1)
  assert.deepEqual(st.changed, [])
  await assert.rejects(git.commit(path.join(root, 'nope'), 'x'), /isn't a git repository/)
})

test('pull: fetches and rebases local commits on top', async () => {
  const dir = clone('pull')
  assert.equal((await git.pull(dir)).pulled, 0)
  write(dir, 'mine.txt', 'mine\n')
  await git.commit(dir, 'mine')
  pushFromElsewhere('theirs.txt', 'theirs\n')

  write(dir, 'mine.txt', 'uncommitted\n')
  await assert.rejects(git.pull(dir), /Commit your changes first/)
  g(dir, 'checkout', '--', 'mine.txt')
  write(dir, 'untracked.txt', 'fine\n') // new files don't block a pull

  const r = await git.pull(dir)
  assert.equal(r.pulled, 1)
  assert.equal(r.onto, 'origin/main')
  assert.equal(read(dir, 'theirs.txt'), 'theirs\n')
  assert.equal(g(dir, 'log', '--format=%s', '-3'), 'mine\nedit theirs.txt\nfirst', 'linear history, mine on top')
  const st = await git.status(dir)
  assert.equal(st.ahead, 1)
  assert.equal(st.behind, 0)
})

test('pull: a conflict is aborted cleanly, leaving nothing half-done', async () => {
  const dir = clone('conflict')
  write(dir, 'README.md', 'line one (mine)\nline two\n')
  await git.commit(dir, 'my readme')
  const before = g(dir, 'rev-parse', 'HEAD')
  pushFromElsewhere('README.md', 'line one (theirs)\nline two\n')

  await assert.rejects(git.pull(dir), /conflicts with your commits in README\.md/)
  assert.equal(g(dir, 'rev-parse', 'HEAD'), before)
  assert.equal(read(dir, 'README.md'), 'line one (mine)\nline two\n')
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'rebase-merge')) && !fs.existsSync(path.join(dir, '.git', 'rebase-apply')))
  assert.deepEqual((await git.status(dir)).changed, [])
})

test('clone: existing branch, new branch from a base, and bad input', async () => {
  const dev = path.join(root, 'clones', 'dev')
  assert.deepEqual(await git.cloneRepo({ repo: 'me/app', dir: dev, branch: 'dev' }), { dir: dev, branch: 'dev' })
  assert.equal((await git.status(dev)).upstream, 'origin/dev')
  assert.ok(fs.existsSync(path.join(dev, 'dev.txt')))

  const feat = path.join(root, 'clones', 'feat')
  assert.equal((await git.cloneRepo({ repo: 'me/app', dir: feat, newBranch: 'feature/a' })).branch, 'feature/a')
  const st = await git.status(feat)
  assert.equal(st.upstream, null, 'a new branch has no upstream until pushed')
  assert.equal(st.defaultBranch, 'main')
  assert.ok(!fs.existsSync(path.join(feat, 'dev.txt')), 'started from main')

  const fromDev = path.join(root, 'clones', 'from-dev')
  await git.cloneRepo({ repo: 'me/app', dir: fromDev, newBranch: 'feature/b', base: 'dev' })
  assert.ok(fs.existsSync(path.join(fromDev, 'dev.txt')), 'started from dev')

  const bad = path.join(root, 'clones', 'bad')
  await assert.rejects(git.cloneRepo({ repo: 'me/app', dir: bad, newBranch: 'no..dots' }), /valid branch name/)
  await assert.rejects(git.cloneRepo({ repo: 'me/app', dir: bad, branch: 'missing' }), /no branch named missing/)
  assert.ok(!fs.existsSync(bad), 'a failed clone is cleaned up')
  await assert.rejects(git.cloneRepo({ repo: 'me/app', dir: bad, newBranch: 'dev' }), /already exists/)
  await assert.rejects(git.cloneRepo({ repo: 'me/app', dir: feat, branch: 'main' }), /already has files/)
  await assert.rejects(git.cloneRepo({ repo: 'not a repo; rm -rf /', dir: bad }), /owner\/name/)
})

test('push and open a PR; a second push finds the existing PR', async () => {
  const dir = path.join(root, 'clones', 'pr')
  await git.cloneRepo({ repo: 'me/app', dir, newBranch: 'feature/pr' })
  write(dir, 'pr.txt', 'pr\n')
  await git.commit(dir, 'Add pr.txt')
  const r = await git.pushAndOpenPr(dir, { title: '', body: 'Body' })
  assert.deepEqual(r, { url: 'https://github.com/me/app/pull/1', created: true })
  assert.ok(g(remote, 'rev-parse', '--verify', 'refs/heads/feature/pr'))
  const args = JSON.parse(fs.readFileSync(path.join(remote, 'pr-feature_pr.json'), 'utf8'))
  assert.equal(args[args.indexOf('--title') + 1], 'Add pr.txt', 'empty title falls back to the last commit')
  assert.equal(args[args.indexOf('--base') + 1], 'main')
  assert.equal((await git.status(dir)).upstream, 'origin/feature/pr')

  assert.deepEqual(await git.pushAndOpenPr(dir, { title: 'Again' }), { url: 'https://github.com/me/app/pull/1', created: false })

  const onMain = clone('pr-main')
  await assert.rejects(git.pushAndOpenPr(onMain, { title: 'x' }), /Start a new branch/)
})

test('gh: status, repos (with orgs) and branches', async () => {
  assert.deepEqual(await git.ghStatus(), { installed: true, authenticated: true, user: 'tester', message: null })
  const repos = await git.listRepos({ limit: 10 })
  assert.deepEqual(repos.map((r) => r.name), ['me/app', 'acme/site'])
  assert.equal(repos[0].defaultBranch, 'main')
  const b = await git.listBranches('me/app')
  assert.equal(b.defaultBranch, 'main')
  assert.equal(b.branches[0], 'main')
  assert.ok(b.branches.includes('dev'))
  await assert.rejects(git.listBranches('../etc'), /owner\/name/)

  process.env.COWOVE_GH = path.join(root, 'no-such-gh')
  try {
    const st = await git.ghStatus()
    assert.equal(st.installed, false)
    assert.match(st.message, /gh auth login/)
  } finally { process.env.COWOVE_GH = fakeGh }
})

// ------------------------------------------------------------------- API --
let ui, base
before(async () => {
  const { startUi } = await import('../src/ui-server.js')
  ui = await startUi({ port: 0, relayPort: 0 })
  base = `http://127.0.0.1:${ui.port}`
})
after(async () => { await ui.close(); fs.rmSync(root, { recursive: true, force: true }) })
const api = (method, p, body) => fetch(base + p, {
  method,
  headers: { 'x-cowove-token': ui.token, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))

test('API: start a session from GitHub, then commit and open a PR', async () => {
  assert.equal((await api('GET', '/api/github/status')).body.user, 'tester')
  assert.equal((await api('GET', '/api/github/repos')).body.repos.length, 2)
  assert.ok((await api('GET', '/api/github/branches?repo=me/app')).body.branches.includes('dev'))

  const bad = await api('POST', '/api/sessions', { mode: 'github', repo: 'me/app', newBranch: 'bad name', hostRelay: true })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /valid branch name/)

  const s = await api('POST', '/api/sessions', { mode: 'github', repo: 'me/app', newBranch: 'feature/api', hostRelay: true })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.equal(s.body.dir, path.join(home, 'cowove', 'app'), 'defaults to the join folder')
  assert.equal(s.body.git, true)
  const id = s.body.id

  let st = await api('GET', `/api/sessions/${id}/git`)
  assert.equal(st.body.branch, 'feature/api')
  assert.deepEqual(st.body.changed, [], '.cowove/ is kept out of git')

  write(s.body.dir, 'api.txt', 'hi\n')
  assert.equal((await api('POST', `/api/sessions/${id}/git/commit`, { message: '' })).status, 400)
  const c = await api('POST', `/api/sessions/${id}/git/commit`, { message: 'From the app' })
  assert.equal(c.status, 200, JSON.stringify(c.body))
  assert.equal(c.body.status.ahead, 1)
  const pulled = await api('POST', `/api/sessions/${id}/git/pull`)
  assert.equal(pulled.status, 200, JSON.stringify(pulled.body))
  const pr = await api('POST', `/api/sessions/${id}/git/pr`, { title: 'API PR', body: '' })
  assert.equal(pr.status, 200, JSON.stringify(pr.body))
  assert.equal(pr.body.url, 'https://github.com/me/app/pull/1')
  assert.equal(pr.body.status.upstream, 'origin/feature/api')
  await api('POST', `/api/sessions/${id}/stop`)
})

test('API: git endpoints refuse folders that are not repos', async () => {
  const dir = path.join(root, 'plain')
  fs.mkdirSync(dir)
  const s = await api('POST', '/api/sessions', { mode: 'create', dir, hostRelay: true })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.equal(s.body.git, false)
  for (const [m, p] of [['GET', 'git'], ['POST', 'git/pull'], ['POST', 'git/commit'], ['POST', 'git/pr']]) {
    const r = await api(m, `/api/sessions/${s.body.id}/${p}`, m === 'POST' ? { message: 'x' } : undefined)
    assert.equal(r.status, 400, p)
    assert.match(r.body.error, /isn't a git repository/)
  }
  await api('POST', `/api/sessions/${s.body.id}/stop`)
})
