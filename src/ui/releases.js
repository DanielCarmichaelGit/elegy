// What's new and the update check: a bar across the top when a newer Quilt is out, and the
// release notes in a quilted pop-up (shown by itself the first time a new version runs).
import { I, state, $, esc, api } from './common.js'
import { quiltMark } from './mark.js'

const RECHECK_MS = 4 * 60 * 60 * 1000
let shownUnseen = false
let hiddenBar = false

/** Asks the app about versions, shows the update bar, and opens the notes after an update. */
export async function checkRelease () {
  try { state.release = await api('GET', '/api/version') } catch { return }
  renderUpdateBar()
  if (state.release.unseen && !shownUnseen) {
    shownUnseen = true
    openReleaseNotes()
    api('POST', '/api/version/seen').catch(() => {})
    state.release.unseen = false
  }
  if (!checkRelease.timer) checkRelease.timer = setInterval(() => checkRelease().catch(() => {}), RECHECK_MS)
}

/** The bar at the top of the window: this version is out of date. */
export function renderUpdateBar () {
  const r = state.release
  let bar = $('#update-bar')
  const show = !!r?.outOfDate && !hiddenBar
  document.body.classList.toggle('has-update', show)
  if (!show) { bar?.remove(); return }
  if (!bar) {
    bar = document.createElement('div')
    bar.id = 'update-bar'
    bar.setAttribute('role', 'status')
    document.body.prepend(bar)
  }
  bar.innerHTML = `
    <span class="ub-dot"></span>
    <span class="ub-text"><b>Quilt ${esc(r.latest.version)} is out.</b> You have ${esc(r.version)}.</span>
    <button class="btn sm ghost" type="button" data-release-notes>What's new</button>
    <a class="btn sm primary" href="${esc(r.downloadUrl)}" target="_blank" rel="noopener">${I.down}<span>Download</span></a>
    <button class="btn sm ghost icon ub-x" type="button" data-hide-update aria-label="Hide until next time">${I.x}</button>`
}

/** Bold and code only; everything else is text. */
export function inline (md) {
  return esc(md)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

const PATCHES = ['a', 'b', 'c', 'd']
const when = (d) => {
  if (!d) return ''
  const t = new Date(`${d}T12:00:00Z`)
  return isNaN(t) ? d : t.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

function releaseHtml (rel, i, { current = false, latest = false } = {}) {
  return `
  <section class="rn-rel${latest ? ' rn-latest' : ''}" aria-labelledby="rn-v-${esc(rel.version)}">
    <header class="rn-rel-head">
      <span class="rn-patch rn-patch-${PATCHES[i % PATCHES.length]}" id="rn-v-${esc(rel.version)}">${esc(rel.version)}</span>
      <span class="rn-when">${esc(when(rel.date))}</span>
      ${current ? '<span class="rn-tag">You have this</span>' : ''}
      ${latest ? `<a class="btn sm primary" href="${esc(state.release.downloadUrl)}" target="_blank" rel="noopener">${I.down}<span>Download</span></a>` : ''}
    </header>
    ${rel.summary ? `<p class="rn-sum">${inline(rel.summary)}</p>` : ''}
    ${rel.items.length ? `<ul class="rn-list">${rel.items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>` : ''}
  </section>`
}

/** The release notes pop-up: the logo, then every version newest first (and a newer one from GitHub, if any). */
export function openReleaseNotes () {
  const r = state.release
  if (!r) return
  $('#rn-back')?.remove()
  const back = document.createElement('div')
  back.id = 'rn-back'
  back.className = 'modal-back rn-back'
  const newer = r.outOfDate ? [{ ...r.latest, items: r.latest.items.length ? r.latest.items : ['**A newer Quilt is ready.** Download it to see what changed.'] }] : []
  const rels = r.releases || []
  back.innerHTML = `
  <div class="rn quilt-patch" role="dialog" aria-modal="true" aria-labelledby="rn-title">
    <span class="quilt-stitch" aria-hidden="true"></span>
    <div class="rn-card">
      <header class="rn-head">
        <div class="rn-logo">${quiltMark({ sew: true })}</div>
        <h2 id="rn-title">What's new</h2>
        <p class="rn-lead">${r.outOfDate ? `Quilt <b>${esc(r.latest.version)}</b> is out; you have ${esc(r.version)}.` : `You have the newest Quilt, <b>${esc(r.version)}</b>.`}</p>
        <button class="btn icon ghost rn-close" type="button" data-rn-close aria-label="Close">${I.x}</button>
      </header>
      <div class="rn-body">
        ${newer.map((rel) => releaseHtml(rel, 0, { latest: true })).join('')}
        ${rels.map((rel, i) => releaseHtml(rel, i + newer.length, { current: rel.version === r.version })).join('')}
        <footer class="rn-foot">All releases live on <a href="https://github.com/DanielCarmichaelGit/heyquilt/releases" target="_blank" rel="noopener">GitHub</a>.</footer>
      </div>
    </div>
  </div>`
  document.body.appendChild(back)
  const close = () => back.remove()
  back.addEventListener('mousedown', (e) => { if (e.target === back) close() })
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
  back.querySelector('[data-rn-close]').onclick = close
  back.querySelector('[data-rn-close]').focus()
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-release-notes]')) {
    if (state.release) openReleaseNotes()
    else checkRelease().then(openReleaseNotes)
  }
  if (e.target.closest('[data-hide-update]')) { hiddenBar = true; renderUpdateBar() }
})
