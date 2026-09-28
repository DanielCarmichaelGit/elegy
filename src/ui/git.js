// The Git button and panel in the session top bar. Only the host sees it: git
// lives on their computer, since sync never writes inside .git.
import { I, state, $, esc, toast, api } from './common.js'

let sid = null // session shown
let st = null // last status from /git
let busy = null // 'pull' | 'commit' | 'pr' | 'load'
let prUrl = null
let refreshTimer = null

export const gitMarkup = () => `
  <div class="git-wrap" id="git-wrap" hidden>
    <button class="btn sm ghost" id="git-btn" aria-haspopup="true" aria-expanded="false" aria-controls="git-panel" title="Git">${I.branch}<span class="wide-only git-label" id="git-label">Git</span></button>
    <div class="popover git-panel" id="git-panel" role="dialog" aria-label="Git" hidden>
      <div class="git-head" id="git-head"></div>
      <div id="git-files"></div>
      <p class="error" id="git-error"></p>
      <div class="git-sec">
        <div class="git-sec-head"><b>Pull latest</b><span class="hint" id="git-pull-hint"></span></div>
        <button type="button" class="btn sm" id="git-pull">${I.down}<span>Pull latest</span></button>
      </div>
      <form class="git-sec" id="git-commit">
        <div class="git-sec-head"><b>Commit</b><span class="hint">Saves every change in this folder</span></div>
        <div class="row"><input class="input grow" id="git-msg" placeholder="Describe the change" aria-label="Commit message" autocomplete="off">
        <button class="btn sm primary" type="submit">Commit</button></div>
      </form>
      <form class="git-sec" id="git-pr">
        <div class="git-sec-head"><b>Push &amp; open PR</b><span class="hint" id="git-pr-hint"></span></div>
        <input class="input" id="git-title" placeholder="Title (defaults to the last commit)" aria-label="Pull request title" autocomplete="off">
        <textarea class="input" id="git-body" rows="3" placeholder="What changed, and why (optional)" aria-label="Pull request description"></textarea>
        <div class="git-pr-foot"><span id="git-pr-link"></span><button class="btn sm primary" type="submit">Push &amp; open PR</button></div>
      </form>
    </div>
  </div>`

export function bindGit (id, signal) {
  sid = id
  st = null
  busy = null
  prUrl = null
  const wrap = $('#git-wrap')
  const btn = $('#git-btn')
  const panel = $('#git-panel')
  const setOpen = (open) => {
    panel.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    if (open) load()
  }
  btn.onclick = () => setOpen(panel.hidden)
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen(false); btn.focus() } })
  document.addEventListener('mousedown', (e) => { if (!wrap.contains(e.target)) setOpen(false) }, { signal })

  $('#git-pull').onclick = () => act('pull', 'git/pull', {}, (r) => toast(r.message))
  $('#git-commit').onsubmit = (e) => {
    e.preventDefault()
    const message = $('#git-msg').value.trim()
    if (!message) { showError('Write a commit message.'); $('#git-msg').focus(); return }
    act('commit', 'git/commit', { message }, (r) => {
      $('#git-msg').value = ''
      toast(`Committed ${r.files} file${r.files === 1 ? '' : 's'} (${r.hash})`)
    })
  }
  $('#git-pr').onsubmit = (e) => {
    e.preventDefault()
    act('pr', 'git/pr', { title: $('#git-title').value, body: $('#git-body').value }, (r) => {
      prUrl = r.url
      $('#git-title').value = ''
      $('#git-body').value = ''
      toast(r.created ? 'Pull request opened' : 'Pushed. The pull request was already open.')
    })
  }
  panel.addEventListener('click', (e) => { if (e.target.closest('#git-refresh')) load() })
  renderGitButton()
}

export function unbindGit () {
  clearTimeout(refreshTimer)
  sid = null
}

/** Show or hide the button as the session's git availability changes. */
export function renderGitButton () {
  const wrap = $('#git-wrap')
  if (!wrap || !sid) return
  const s = state.sessions.get(sid)
  const on = !!(s && s.git)
  if (wrap.hidden === on) {
    wrap.hidden = !on
    if (on && !st) load(true)
  }
}

/** Files changed: refresh the counts shortly, if anyone's looking. */
export function gitFilesChanged () {
  if (!sid || $('#git-panel')?.hidden !== false) return
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => load(true), 800)
}

async function load (quiet = false) {
  const id = sid
  if (!id || (busy && busy !== 'load')) return
  if (!quiet) { busy = 'load'; paint() }
  try {
    const next = await api('GET', `/api/sessions/${id}/git`)
    if (id !== sid) return
    st = next
    if (!quiet) showError('')
  } catch (err) {
    if (id === sid && !quiet) showError(err.message)
  } finally {
    if (busy === 'load') busy = null
    if (id === sid) paint()
  }
}

async function act (kind, path, body, done) {
  const id = sid
  if (busy) return
  busy = kind
  showError('')
  paint()
  try {
    const r = await api('POST', `/api/sessions/${id}/${path}`, body)
    if (id !== sid) return
    st = r.status
    done(r)
  } catch (err) {
    if (id === sid) showError(err.message)
  } finally {
    busy = null
    if (id === sid) paint()
  }
}

function showError (msg) {
  const el = $('#git-error')
  if (el) el.textContent = msg
}

const WORDS = { new: 'New', modified: 'Changed', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', copied: 'Copied', conflicted: 'Conflict' }

function paint () {
  const label = $('#git-label')
  if (!label) return
  label.textContent = st?.branch || 'Git'
  const head = $('#git-head')
  if (!st) {
    head.innerHTML = `<span class="hint">${busy === 'load' ? 'Reading git…' : ''}</span>`
    return
  }
  const sync = !st.upstream
    ? `<span class="git-chip" title="This branch isn't on GitHub yet">Not pushed${st.ahead ? ` · ${st.ahead} commit${st.ahead === 1 ? '' : 's'}` : ''}</span>`
    : !st.ahead && !st.behind
        ? '<span class="git-chip ok">Up to date</span>'
        : `${st.ahead ? `<span class="git-chip" title="Commits to push">↑ ${st.ahead}</span>` : ''}${st.behind ? `<span class="git-chip warn" title="Commits to pull">↓ ${st.behind}</span>` : ''}`
  head.innerHTML = `
    <span class="git-branch">${I.branch}<code>${esc(st.branch || 'detached HEAD')}</code></span>
    ${sync}
    <span class="spacer"></span>
    <button type="button" class="btn sm ghost icon" id="git-refresh" title="Refresh" aria-label="Refresh"${busy ? ' disabled' : ''}>${I.refresh}</button>`

  const files = $('#git-files')
  const open = files.querySelector('details')?.open
  const n = st.changed.length
  files.innerHTML = n
    ? `<details class="git-files"${open ? ' open' : ''}><summary>${n} changed file${n === 1 ? '' : 's'}</summary>
        <ul>${st.changed.slice(0, 200).map((c) => `<li><span class="git-st ${esc(c.status)}">${esc(WORDS[c.status] || c.status)}</span><code title="${esc(c.path)}">${esc(c.path)}</code></li>`).join('')}
        ${n > 200 ? `<li class="hint">and ${n - 200} more</li>` : ''}</ul></details>`
    : '<p class="hint git-clean">No uncommitted changes.</p>'

  $('#git-pull-hint').textContent = st.upstream ? `Rebase onto ${st.upstream}` : st.defaultBranch ? `Rebase onto origin/${st.defaultBranch}` : ''
  const onDefault = st.branch && st.branch === st.defaultBranch
  $('#git-pr-hint').textContent = st.defaultBranch && !onDefault ? `Into ${st.defaultBranch}` : ''
  $('#git-pr-link').innerHTML = prUrl
    ? `<a href="${esc(prUrl)}" target="_blank" rel="noopener">${I.link}<span>View pull request</span></a>`
    : onDefault ? `<span class="hint">You're on ${esc(st.branch)}. Start a new branch to open a PR.</span>` : ''

  const set = (sel, kind, idle, working) => {
    const b = $(sel)
    b.disabled = !!busy
    const span = b.querySelector('span')
    ;(span || b).textContent = busy === kind ? working : idle
  }
  set('#git-pull', 'pull', 'Pull latest', 'Pulling…')
  set('#git-commit button[type=submit]', 'commit', 'Commit', 'Committing…')
  set('#git-pr button[type=submit]', 'pr', 'Push & open PR', 'Pushing…')
  if (onDefault) $('#git-pr button[type=submit]').disabled = true
}
