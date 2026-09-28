// cowove app: boot, live events, home screen, folder picker and invites.
// The session workspace lives in session.js. Plain ES modules, no build step.
import { TOKEN, I, state, $, esc, basename, toast, api, decodeInvite, remember, recall } from './common.js'
import { renderShell } from './home.js'
import { mountSession, sessionUpdated, sessionMessage, sessionFeed, sessionFileChanged, sessionLog, sessionUnmount } from './session.js'

// ---------------------------------------------------------------- boot --
async function boot () {
  if (!TOKEN) return renderLocked()
  try {
    const s = await api('GET', '/api/state')
    state.recent = s.recent
    state.defaults = s.defaults
    state.profile = s.profile
    state.relay = s.relay
    state.maxFileBytes = s.maxFileBytes
    for (const sum of s.sessions) state.sessions.set(sum.id, sum)
    state.loaded = true
    const last = recall('view')
    state.view = state.sessions.has(last) || last === 'settings' ? last : (state.sessions.size ? [...state.sessions.keys()][0] : 'home')
    if (isSession(state.view)) await loadMessages(state.view)
    connectEvents()
    render()
  } catch (err) {
    renderLocked(err.message)
  }
}

function connectEvents () {
  const es = state.events = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`)
  es.addEventListener('session', (e) => {
    const sum = JSON.parse(e.data)
    const prev = state.sessions.get(sum.id)
    // Session summaries don't carry the full log; keep what we have.
    state.sessions.set(sum.id, prev ? { ...sum, logs: prev.logs } : sum)
    if (state.view === sum.id) sessionUpdated(sum.id)
    else renderTabs()
  })
  es.addEventListener('feed', (e) => {
    const { id, entries } = JSON.parse(e.data)
    sessionFeed(id, entries)
  })
  es.addEventListener('file-changed', (e) => {
    const { id, ...change } = JSON.parse(e.data)
    sessionFileChanged(id, change)
  })
  es.addEventListener('message', (e) => {
    const { id, message } = JSON.parse(e.data)
    const list = state.messages.get(id)
    if (list && !list.some((m) => m.id === message.id)) list.push(message)
    if (state.view === id) {
      sessionMessage(id, message)
      if (document.visibilityState === 'visible') markRead(id)
    } else renderTabs()
    if (message.by !== state.sessions.get(id)?.status.me.name && document.visibilityState !== 'visible') {
      document.title = `• ${message.by}: ${message.text || message.file?.name || ''}`.slice(0, 60)
    }
  })
  es.addEventListener('log', (e) => {
    const { id, ts, line } = JSON.parse(e.data)
    const s = state.sessions.get(id)
    if (s) { s.logs.push({ ts, line }); if (s.logs.length > 200) s.logs.shift() }
    if (state.view === id) sessionLog(id)
  })
  es.addEventListener('stopped', (e) => {
    const { id } = JSON.parse(e.data)
    state.sessions.delete(id)
    state.messages.delete(id)
    state.feeds.delete(id)
    state.trees.delete(id)
    if (state.view === id) { state.view = 'home'; refreshRecent() }
    render()
  })
}

const isSession = (view) => view !== 'home' && view !== 'settings'

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    document.title = 'cowove'
    if (isSession(state.view)) markRead(state.view)
  }
})

export async function loadMessages (id) {
  const { messages } = await api('GET', `/api/sessions/${id}/messages`)
  state.messages.set(id, messages)
}

export async function markRead (id) {
  const list = state.messages.get(id) || []
  if (!list.some((m) => m.unread)) return
  for (const m of list) m.unread = false
  await api('POST', `/api/sessions/${id}/read`).catch(() => {})
}

async function refreshRecent () {
  try {
    const s = await api('GET', '/api/state')
    state.recent = s.recent
    state.profile = s.profile
  } catch {}
}

export async function go (view) {
  state.view = view
  state.pending = []
  state.to = ''
  remember('view', view)
  if (view === 'home') await refreshRecent()
  if (isSession(view) && !state.messages.has(view)) await loadMessages(view)
  render()
  if (isSession(view)) markRead(view)
}

// --------------------------------------------------------------- render --
export async function shutdown () {
  if (!confirm('Shut down cowove? This stops every session, the relay, and this app. Your files stay where they are.')) return
  try {
    await api('POST', '/api/shutdown')
    state.events?.close() // don't re-render or reconnect as sessions stop
    renderLocked('cowove is shut down. You can close this tab.')
  } catch (err) {
    toast(err.message)
  }
}

document.addEventListener('click', (e) => { if (e.target.closest('[data-shutdown]')) shutdown() })

export function render () {
  sessionUnmount()
  if (!isSession(state.view)) {
    renderShell(state.view)
  } else {
    mountSession(state.view)
    bindTopbar()
  }
}

export function renderLocked (msg) {
  $('#app').innerHTML = `
    <div class="home"><div class="hero">
      <img src="/logo.svg" alt="">
      <div class="wordmark">co<i>wo</i>ve</div>
      <p class="tagline">${esc(msg || 'Open cowove using the link printed in your terminal by')} ${msg ? '' : '<code>cowove ui</code>.'}</p>
    </div></div>`
}

export function renderTabs () {
  const el = $('#tabs')
  if (!el) return
  // One session is the normal case; tabs only help when there are several.
  el.hidden = state.sessions.size < 2 && state.view !== 'home'
  el.innerHTML = [...state.sessions.values()].map((s) => {
    const unread = s.status.unread
    return `<button class="tab${state.view === s.id ? ' on' : ''}" data-go="${s.id}">
      <span class="dot" style="background:${s.status.connected ? 'var(--ok)' : 'var(--warn)'}"></span>
      ${esc(basename(s.dir))}
      ${unread && state.view !== s.id ? `<span class="badge">${unread}</span>` : ''}
    </button>`
  }).join('')
}

export function bindTopbar () {
  renderTabs()
  document.querySelectorAll('[data-go]').forEach((b) => { if (!b.closest('#tabs')) b.onclick = () => go(b.dataset.go) })
  $('#tabs')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]')
    if (b) go(b.dataset.go)
  })
}

// -------------------------------------------------------- folder picker --
export async function pickFolder (input) {
  const back = document.createElement('div')
  back.className = 'modal-back'
  back.innerHTML = `<div class="card modal" role="dialog" aria-modal="true" aria-labelledby="pick-title">
    <h3 id="pick-title">Choose a folder</h3>
    <p class="lead">Pick the project folder, or type a path. New folders are created for you.</p>
    <div class="row"><button class="btn icon" id="pick-up" title="Up" aria-label="Up">${I.up}</button><input class="input grow mono" id="pick-path"><button class="btn" id="pick-go">Go</button></div>
    <div class="dirlist" id="pick-list"></div>
    <div class="hint" id="pick-note"></div>
    <div class="actions"><button class="btn ghost" id="pick-cancel">Cancel</button><button class="btn primary" id="pick-use">Use this folder</button></div>
  </div>`
  document.body.appendChild(back)
  let done
  const closed = new Promise((resolve) => { done = resolve })
  const close = () => { back.remove(); done() }
  let current = null
  const load = async (p) => {
    try {
      const d = await api('GET', `/api/fs?path=${encodeURIComponent(p)}`)
      current = d
      $('#pick-path', back).value = d.path
      $('#pick-up', back).disabled = !d.parent
      $('#pick-list', back).innerHTML = d.dirs.length
        ? d.dirs.map((n) => `<button data-dir="${esc(n)}">${I.folder}<span>${esc(n)}</span></button>`).join('')
        : '<div class="empty-note" style="padding:14px">No subfolders</div>'
      $('#pick-note', back).textContent = d.hasSession ? 'This folder has been used with cowove before.' : d.isEmpty ? 'This folder is empty.' : ''
      $('#pick-list', back).querySelectorAll('[data-dir]').forEach((b) => {
        b.onclick = () => load(`${d.path.replace(/[\\/]$/, '')}/${b.dataset.dir}`)
      })
    } catch (err) {
      $('#pick-note', back).textContent = err.message
    }
  }
  $('#pick-up', back).onclick = () => current?.parent && load(current.parent)
  $('#pick-go', back).onclick = () => load($('#pick-path', back).value)
  $('#pick-path', back).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); load(e.target.value) } }
  $('#pick-cancel', back).onclick = close
  $('#pick-use', back).onclick = () => { input.value = $('#pick-path', back).value; close() }
  back.onclick = (e) => { if (e.target === back) close() }
  back.onkeydown = (e) => { if (e.key === 'Escape') close() }
  await load(input.value || state.defaults.home)
  $('#pick-path', back).focus()
  return closed
}


// --------------------------------------------------------------- invite --
export function openInvite (id) {
  const s = state.sessions.get(id)
  if (!s) return
  const d = decodeInvite(s.invite)
  const local = d && !d.server.startsWith('wss://')
  const back = document.createElement('div')
  back.className = 'modal-back'
  back.innerHTML = `<div class="card modal" role="dialog" aria-modal="true" aria-labelledby="inv-title">
    <h3 id="inv-title">Invite someone</h3>
    <p class="lead">Send them a link. They paste it into <b>Join a session</b> in cowove, or run <code>cowove join &lt;link&gt;</code>. Opening it in a browser explains what to do.</p>
    <div class="label" style="margin-bottom:6px">${s.viewInvite ? 'Can edit' : 'Invite link'}</div>
    <div class="codebox"><code id="inv-code">${esc(s.invite)}</code><button class="btn icon" data-copy="inv-code" title="Copy" aria-label="Copy invite link">${I.copy}</button></div>
    ${s.viewInvite ? `<div class="label" style="margin-bottom:6px">View only</div>
    <div class="codebox"><code id="inv-view">${esc(s.viewInvite)}</code><button class="btn icon" data-copy="inv-view" title="Copy" aria-label="Copy view-only link">${I.copy}</button></div>` : ''}
    ${d ? `<p class="hint">Room <code>${esc(d.room)}</code> via <code>${esc(d.server)}</code></p>` : ''}
    ${local ? '<p class="hint warn">This is a local-network address. If your partner is somewhere else, run <code>cloudflared tunnel --url http://localhost:4321</code> and start a new session with the tunnel address as the public address (or use a hosted relay).</p>' : ''}
    <p class="hint">${s.viewInvite ? 'Everyone who uses a link waits until you let them in, and you can change what they may do later from the people menu.' : 'Anyone with this link can edit the project. Only share it with people you trust.'}</p>
    <div class="actions"><button class="btn primary" id="inv-done">Done</button></div>
  </div>`
  document.body.appendChild(back)
  const close = () => back.remove()
  back.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      const text = $(`#${b.dataset.copy}`, back).textContent
      try { await navigator.clipboard.writeText(text); toast('Copied') } catch {
        const r = document.createRange(); r.selectNodeContents($(`#${b.dataset.copy}`, back))
        getSelection().removeAllRanges(); getSelection().addRange(r); toast('Press ⌘/Ctrl+C to copy')
      }
    }
  })
  $('#inv-done', back).onclick = close
  back.onclick = (e) => { if (e.target === back) close() }
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
  $('#inv-done', back).focus()
}

boot()
