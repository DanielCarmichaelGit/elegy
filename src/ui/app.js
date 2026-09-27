// elegy local UI. Plain JS, no build step.

// ---------------------------------------------------------------- token --
const params = new URLSearchParams(location.search)
if (params.get('t')) {
  try { sessionStorage.setItem('elegy-token', params.get('t')) } catch {}
  history.replaceState(null, '', '/')
}
let TOKEN = params.get('t')
try { TOKEN = TOKEN || sessionStorage.getItem('elegy-token') } catch {}

// ---------------------------------------------------------------- icons --
const I = {
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>'
}

const TOOLS = ['Claude Code', 'Cursor', 'Codex', 'Windsurf', 'GitHub Copilot', 'Zed', 'Aider', 'Other']

// ---------------------------------------------------------------- state --
const state = {
  loaded: false,
  sessions: new Map(), // id -> summary
  messages: new Map(), // id -> [message]
  recent: [],
  defaults: {},
  relay: null,
  maxFileBytes: 0,
  view: 'home', // 'home' | session id
  pane: 'chat', // mobile pane
  to: '', // chat recipient ('' = everyone)
  pending: [], // files queued in the composer
  error: null
}

// -------------------------------------------------------------- helpers --
const $ = (sel, root = document) => root.querySelector(sel)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const basename = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p
const bytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return new Date(ts).toLocaleDateString()
}
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const PALETTE = ['#e06c75', '#5b8def', '#3fae6b', '#b267e6', '#d8a23a', '#2fb3c4', '#e0864f']
const colorFor = (name, given) => given || PALETTE[Math.abs([...String(name)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)) % PALETTE.length]
const avatar = (name, color, online = false) =>
  `<div class="avatar${online ? ' online' : ''}" style="background:${esc(colorFor(name, color))}">${esc(String(name || '?').slice(0, 1))}</div>`

function toast (msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400)
}

async function api (method, path, body, headers = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'x-elegy-token': TOKEN || '', ...(body && !(body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

function decodeInvite (code) {
  try {
    const raw = code.trim().replace(/^elegy join\s+/, '')
    const j = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')))
    return j && j.s && j.r ? { server: j.s, room: j.r } : null
  } catch { return null }
}

function remember (key, value) { try { localStorage.setItem(`elegy-${key}`, value) } catch {} }
function recall (key, fallback = '') { try { return localStorage.getItem(`elegy-${key}`) ?? fallback } catch { return fallback } }

// ---------------------------------------------------------------- boot --
async function boot () {
  if (!TOKEN) return renderLocked()
  try {
    const s = await api('GET', '/api/state')
    state.recent = s.recent
    state.defaults = s.defaults
    state.relay = s.relay
    state.maxFileBytes = s.maxFileBytes
    for (const sum of s.sessions) state.sessions.set(sum.id, sum)
    state.loaded = true
    const last = recall('view')
    state.view = state.sessions.has(last) ? last : (state.sessions.size ? [...state.sessions.keys()][0] : 'home')
    if (state.view !== 'home') await loadMessages(state.view)
    connectEvents()
    render()
  } catch (err) {
    renderLocked(err.message)
  }
}

function connectEvents () {
  const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`)
  es.addEventListener('session', (e) => {
    const sum = JSON.parse(e.data)
    const isNew = !state.sessions.has(sum.id)
    state.sessions.set(sum.id, sum)
    if (isNew) renderTopbar()
    if (state.view === sum.id) renderSessionPanels()
    else renderTabs()
  })
  es.addEventListener('message', (e) => {
    const { id, message } = JSON.parse(e.data)
    const list = state.messages.get(id)
    if (list && !list.some((m) => m.id === message.id)) list.push(message)
    if (state.view === id) {
      renderMessages(true)
      if (document.visibilityState === 'visible') markRead(id)
    }
    if (message.by !== state.sessions.get(id)?.status.me.name && document.visibilityState !== 'visible') {
      document.title = `• ${message.by}: ${message.text || message.file?.name || ''}`.slice(0, 60)
    }
  })
  es.addEventListener('log', (e) => {
    const { id, ts, line } = JSON.parse(e.data)
    const s = state.sessions.get(id)
    if (s) { s.logs.push({ ts, line }); if (s.logs.length > 200) s.logs.shift() }
    if (state.view === id) renderLogs()
  })
  es.addEventListener('stopped', (e) => {
    const { id } = JSON.parse(e.data)
    state.sessions.delete(id)
    state.messages.delete(id)
    if (state.view === id) { state.view = 'home'; refreshRecent() }
    render()
  })
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    document.title = 'elegy'
    if (state.view !== 'home') markRead(state.view)
  }
})

async function loadMessages (id) {
  const { messages } = await api('GET', `/api/sessions/${id}/messages`)
  state.messages.set(id, messages)
}

async function markRead (id) {
  const list = state.messages.get(id) || []
  if (!list.some((m) => m.unread)) return
  for (const m of list) m.unread = false
  await api('POST', `/api/sessions/${id}/read`).catch(() => {})
}

async function refreshRecent () {
  try { state.recent = (await api('GET', '/api/state')).recent } catch {}
}

async function go (view) {
  state.view = view
  state.pending = []
  state.to = ''
  remember('view', view)
  if (view !== 'home' && !state.messages.has(view)) await loadMessages(view)
  render()
  if (view !== 'home') markRead(view)
}

// --------------------------------------------------------------- render --
function render () {
  const app = $('#app')
  if (state.view === 'home') {
    app.innerHTML = state.sessions.size ? `<div class="shell">${topbarHtml()}<div style="overflow:auto;flex:1">${homeHtml()}</div></div>` : homeHtml()
    bindHome()
    bindTopbar()
  } else {
    app.innerHTML = `<div class="shell">${topbarHtml()}${sessionHtml()}</div>`
    bindTopbar()
    bindSession()
    renderSessionPanels()
    renderMessages(false, true)
  }
}

function renderLocked (msg) {
  $('#app').innerHTML = `
    <div class="home"><div class="hero">
      <img src="/logo.svg" alt="">
      <div class="wordmark"><span>elegy</span></div>
      <p class="tagline">${esc(msg || 'Open elegy using the link printed in your terminal by')} ${msg ? '' : '<code>elegy ui</code>.'}</p>
    </div></div>`
}

function topbarHtml () {
  return `
    <header class="topbar">
      <button class="brand" data-go="home" aria-label="Home"><img src="/logo.svg" alt="">elegy</button>
      <nav class="tabs" id="tabs"></nav>
      <button class="btn sm" data-go="home">${I.plus}<span>New</span></button>
    </header>`
}

function renderTopbar () {
  if ($('.topbar')) renderTabs()
}

function renderTabs () {
  const el = $('#tabs')
  if (!el) return
  el.innerHTML = [...state.sessions.values()].map((s) => {
    const unread = s.status.unread
    return `<button class="tab${state.view === s.id ? ' on' : ''}" data-go="${s.id}">
      <span class="dot" style="background:${s.status.connected ? 'var(--ok)' : 'var(--warn)'}"></span>
      ${esc(basename(s.dir))}
      ${unread && state.view !== s.id ? `<span class="badge">${unread}</span>` : ''}
    </button>`
  }).join('')
}

function bindTopbar () {
  renderTabs()
  document.querySelectorAll('[data-go]').forEach((b) => { if (!b.closest('#tabs')) b.onclick = () => go(b.dataset.go) })
  $('#tabs')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]')
    if (b) go(b.dataset.go)
  })
}

// ----------------------------------------------------------------- home --
function toolOptions (selected) {
  return TOOLS.map((t) => `<option ${t === selected ? 'selected' : ''}>${t}</option>`).join('')
}

function homeHtml () {
  const name = recall('name', state.defaults.name || '')
  const tool = recall('tool', 'Claude Code')
  const relayMode = recall('relayMode', 'host')
  const running = [...state.sessions.values()]
  return `
  <main class="home">
    <section class="hero">
      <img src="/logo.svg" alt="">
      <div class="wordmark"><span>elegy</span></div>
      <p class="tagline">Vibe code together in real time, from anywhere, each in whatever AI tool you like.</p>
    </section>

    <section class="choices">
      <form class="card choice" id="create-form" autocomplete="off">
        <h2>Start a session</h2>
        <p>Share a project folder and invite someone to build with you.</p>
        <div class="field">
          <label for="c-dir">Project folder</label>
          <div class="row"><input class="input grow" id="c-dir" name="dir" placeholder="~/code/my-app" value="${esc(recall('createDir', state.defaults.cwd || ''))}" required>
          <button type="button" class="btn icon" data-browse="c-dir" title="Browse" aria-label="Browse">${I.folder}</button></div>
        </div>
        <div class="row">
          <div class="field grow"><label for="c-name">Your name</label><input class="input" id="c-name" name="name" value="${esc(name)}" required></div>
          <div class="field grow"><label for="c-tool">Coding with</label><select class="input" id="c-tool" name="tool">${toolOptions(tool)}</select></div>
        </div>
        <div class="relay-box">
          <div class="segmented" role="tablist">
            <button type="button" data-relay="host" class="${relayMode === 'host' ? 'on' : ''}">Host relay here</button>
            <button type="button" data-relay="remote" class="${relayMode === 'remote' ? 'on' : ''}">Use a relay server</button>
          </div>
          <div id="relay-host" ${relayMode === 'host' ? '' : 'hidden'}>
            <div class="field">
              <label for="c-public">Public address <span class="hint">(optional)</span></label>
              <input class="input" id="c-public" name="publicUrl" placeholder="wss://your-tunnel.trycloudflare.com" value="${esc(recall('publicUrl'))}">
              <span class="hint">Leave empty if your partner is on the same network. Otherwise run <code>cloudflared tunnel --url http://localhost:4321</code> and paste the https address here.</span>
            </div>
          </div>
          <div id="relay-remote" ${relayMode === 'remote' ? '' : 'hidden'}>
            <div class="field">
              <label for="c-server">Relay address</label>
              <input class="input" id="c-server" name="server" placeholder="wss://relay.example.com" value="${esc(recall('server'))}">
            </div>
          </div>
        </div>
        <button class="btn grad full" type="submit">Start session</button>
        <p class="error" id="create-error"></p>
      </form>

      <form class="card choice" id="join-form" autocomplete="off">
        <h2>Join a session</h2>
        <p>Paste the invite your partner sent you.</p>
        <div class="field">
          <label for="j-invite">Invite code</label>
          <textarea class="input mono" id="j-invite" name="invite" rows="3" placeholder="elegy join eyJz…" required></textarea>
          <span class="hint" id="invite-hint">&nbsp;</span>
        </div>
        <div class="field">
          <label for="j-dir">Put the project in</label>
          <div class="row"><input class="input grow" id="j-dir" name="dir" placeholder="~/code/their-app" value="${esc(recall('joinDir'))}" required>
          <button type="button" class="btn icon" data-browse="j-dir" title="Browse" aria-label="Browse">${I.folder}</button></div>
          <span class="hint">An empty folder is best. It will fill with their files.</span>
        </div>
        <div class="row">
          <div class="field grow"><label for="j-name">Your name</label><input class="input" id="j-name" name="name" value="${esc(name)}" required></div>
          <div class="field grow"><label for="j-tool">Coding with</label><select class="input" id="j-tool" name="tool">${toolOptions(recall('tool', 'Cursor'))}</select></div>
        </div>
        <label class="check"><input type="checkbox" name="preferLocal"> Keep my versions of files that already exist in this folder</label>
        <button class="btn primary full" type="submit">Join session</button>
        <p class="error" id="join-error"></p>
      </form>
    </section>

    ${running.length ? `
      <h3 class="section-title">Running now</h3>
      <div class="list">${running.map((s) => `
        <div class="card list-item">
          <div class="folder-ico">${I.folder}</div>
          <div class="meta"><div class="name">${esc(basename(s.dir))}</div><div class="sub">${esc(s.dir)} · ${s.status.peers.length} other${s.status.peers.length === 1 ? '' : 's'} online</div></div>
          <button class="btn sm" data-go="${s.id}">Open</button>
        </div>`).join('')}</div>` : ''}

    ${state.recent.length ? `
      <h3 class="section-title">Recent</h3>
      <div class="list">${state.recent.map((r) => `
        <div class="card list-item">
          <div class="folder-ico">${I.folder}</div>
          <div class="meta"><div class="name">${esc(basename(r.dir))}</div><div class="sub">${esc(r.dir)} · as ${esc(r.name)} · ${esc(ago(r.lastUsed))}</div></div>
          <button class="btn sm" data-rejoin="${esc(r.dir)}">Rejoin</button>
        </div>`).join('')}</div>` : ''}

    <p class="footer-note">Files sync live between everyone in a session. Chat, direct messages and file sharing live inside each session.</p>
  </main>`
}

function bindHome () {
  const create = $('#create-form')
  const join = $('#join-form')
  if (!create) return

  let relayMode = recall('relayMode', 'host')
  create.querySelectorAll('[data-relay]').forEach((b) => {
    b.onclick = () => {
      relayMode = b.dataset.relay
      remember('relayMode', relayMode)
      create.querySelectorAll('[data-relay]').forEach((x) => x.classList.toggle('on', x === b))
      $('#relay-host').hidden = relayMode !== 'host'
      $('#relay-remote').hidden = relayMode !== 'remote'
    }
  })
  document.querySelectorAll('[data-browse]').forEach((b) => { b.onclick = () => pickFolder($(`#${b.dataset.browse}`)) })

  $('#j-invite').addEventListener('input', (e) => {
    const inv = e.target.value.trim()
    const hint = $('#invite-hint')
    if (!inv) { hint.innerHTML = '&nbsp;'; hint.className = 'hint'; return }
    const d = decodeInvite(inv)
    hint.className = d ? 'hint' : 'hint warn'
    hint.textContent = d ? `Room ${d.room} on ${d.server}` : 'That doesn’t look like an elegy invite.'
    if (d && !$('#j-dir').value) $('#j-dir').value = `${state.defaults.home}/elegy/${d.room}`
  })

  create.onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(create)
    remember('name', f.get('name')); remember('tool', f.get('tool')); remember('createDir', f.get('dir'))
    remember('publicUrl', f.get('publicUrl') || ''); remember('server', f.get('server') || '')
    await submit(create, '#create-error', {
      mode: 'create', dir: f.get('dir'), name: f.get('name'), tool: f.get('tool'),
      hostRelay: relayMode === 'host', publicUrl: f.get('publicUrl'), server: f.get('server')
    }, true)
  }
  join.onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(join)
    remember('name', f.get('name')); remember('tool', f.get('tool')); remember('joinDir', f.get('dir'))
    await submit(join, '#join-error', {
      mode: 'join', invite: f.get('invite'), dir: f.get('dir'), name: f.get('name'), tool: f.get('tool'),
      prefer: f.get('preferLocal') ? 'local' : 'remote'
    })
  }
  document.querySelectorAll('[data-rejoin]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true
      b.textContent = 'Connecting…'
      try {
        const sum = await api('POST', '/api/sessions', { mode: 'rejoin', dir: b.dataset.rejoin })
        state.sessions.set(sum.id, sum)
        await go(sum.id)
      } catch (err) {
        toast(err.message)
        b.disabled = false
        b.textContent = 'Rejoin'
      }
    }
  })
}

async function submit (form, errSel, body, showInvite = false) {
  const btn = form.querySelector('button[type=submit]')
  const label = btn.textContent
  btn.disabled = true
  btn.textContent = 'Connecting…'
  $(errSel).textContent = ''
  try {
    const sum = await api('POST', '/api/sessions', body)
    state.sessions.set(sum.id, sum)
    await go(sum.id)
    if (showInvite) openInvite(sum.id)
  } catch (err) {
    $(errSel).textContent = err.message
    btn.disabled = false
    btn.textContent = label
  }
}

// -------------------------------------------------------- folder picker --
async function pickFolder (input) {
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
  const close = () => back.remove()
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
      $('#pick-note', back).textContent = d.hasSession ? 'This folder has been used with elegy before.' : d.isEmpty ? 'This folder is empty.' : ''
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
}

// -------------------------------------------------------------- session --
function sessionHtml () {
  const s = state.sessions.get(state.view)
  return `
    <div class="subbar">
      <div class="title">${esc(basename(s.dir))}</div>
      <span class="pill" id="conn-pill"></span>
      <div class="path" title="${esc(s.dir)}">${esc(s.dir)}</div>
      <div class="spacer"></div>
      <button class="btn sm" id="invite-btn">${I.link}<span>Invite</span></button>
      <button class="btn sm ghost" id="leave-btn">Leave</button>
    </div>
    <div class="mobile-tabs"><div class="segmented" style="flex:1">
      <button data-pane="people">People</button><button data-pane="chat">Chat</button><button data-pane="activity">Activity</button>
    </div></div>
    <div class="grid" data-pane="${state.pane}">
      <aside class="col left">
        <div class="panel">
          <div class="panel-title">You</div>
          <div id="me"></div>
          <form id="focus-form" class="row" style="margin-top:8px">
            <input class="input grow" id="focus-input" placeholder="What are you working on?" style="height:34px">
          </form>
        </div>
        <div class="panel"><div class="panel-title">Online <span id="online-count"></span></div><div id="people"></div></div>
        <div class="panel">
          <div class="panel-title">Claimed files</div>
          <div id="claims"></div>
          <form id="claim-form" class="row" style="margin-top:8px">
            <input class="input grow mono" id="claim-input" placeholder="src/auth/**" style="height:34px" aria-label="Path or glob to claim">
            <button class="btn sm" type="submit">Claim</button>
          </form>
        </div>
      </aside>
      <section class="col center" id="center">
        <div class="chat-head"><h3>Chat</h3><span class="hint" id="chat-sub"></span></div>
        <div class="messages" id="messages"></div>
        <div class="drop">Drop files to send</div>
        <form class="composer" id="composer">
          <div class="to"><label for="to-select">To</label><select id="to-select"></select></div>
          <div class="attachments" id="attachments"></div>
          <div class="box">
            <button type="button" class="btn ghost icon" id="attach-btn" title="Send a file" aria-label="Send a file">${I.clip}</button>
            <input type="file" id="file-input" multiple hidden>
            <textarea id="msg-input" rows="1" placeholder="Message everyone…"></textarea>
            <button type="submit" class="btn grad icon" id="send-btn" title="Send" aria-label="Send">${I.send}</button>
          </div>
        </form>
      </section>
      <aside class="col right">
        <div class="panel"><div class="panel-title">Activity</div><div id="activity"></div></div>
        <div class="panel"><div class="panel-title">Events</div><div id="logs"></div></div>
      </aside>
    </div>`
}

function bindSession () {
  const id = state.view
  $('#invite-btn').onclick = () => openInvite(id)
  $('#leave-btn').onclick = async () => {
    if (!confirm('Stop syncing this folder? Your files stay where they are, and you can rejoin later.')) return
    await api('POST', `/api/sessions/${id}/stop`).catch((err) => toast(err.message))
  }
  document.querySelectorAll('[data-pane]').forEach((b) => {
    if (b.tagName !== 'BUTTON') return
    b.classList.toggle('on', b.dataset.pane === state.pane)
    b.onclick = () => {
      state.pane = b.dataset.pane
      $('.grid').dataset.pane = state.pane
      document.querySelectorAll('.mobile-tabs [data-pane]').forEach((x) => x.classList.toggle('on', x === b))
    }
  })

  const focusInput = $('#focus-input')
  focusInput.value = state.sessions.get(id).status.me.focus || ''
  $('#focus-form').onsubmit = async (e) => {
    e.preventDefault()
    await api('POST', `/api/sessions/${id}/focus`, { text: focusInput.value })
    focusInput.blur()
    toast(focusInput.value ? 'Focus shared' : 'Focus cleared')
  }
  $('#claim-form').onsubmit = async (e) => {
    e.preventDefault()
    const pattern = $('#claim-input').value.trim()
    if (!pattern) return
    try {
      const r = await api('POST', `/api/sessions/${id}/claim`, { pattern, note: focusInput.value })
      $('#claim-input').value = ''
      toast(r.overlapping?.length ? `Claimed, but it overlaps ${r.overlapping.map((c) => c.by).join(', ')}` : `Claimed ${pattern}`)
    } catch (err) { toast(err.message) }
  }
  $('#claims').onclick = async (e) => {
    const b = e.target.closest('[data-release]')
    if (b) await api('POST', `/api/sessions/${id}/release`, { pattern: b.dataset.release }).catch((err) => toast(err.message))
  }
  $('#people').onclick = (e) => {
    const b = e.target.closest('[data-dm]')
    if (!b) return
    state.to = b.dataset.dm
    renderRecipients()
    document.querySelector('.mobile-tabs [data-pane=chat]')?.click()
    $('#msg-input').focus()
  }

  // composer
  const input = $('#msg-input')
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px` }
  input.addEventListener('input', grow)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit() }
  })
  $('#to-select').onchange = (e) => { state.to = e.target.value; updatePlaceholder() }
  $('#attach-btn').onclick = () => $('#file-input').click()
  $('#file-input').onchange = (e) => { addFiles(e.target.files); e.target.value = '' }
  $('#attachments').onclick = (e) => {
    const b = e.target.closest('[data-unqueue]')
    if (b) { state.pending.splice(Number(b.dataset.unqueue), 1); renderAttachments() }
  }
  $('#composer').onsubmit = async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    const files = state.pending.slice()
    if (!text && !files.length) return
    $('#send-btn').disabled = true
    try {
      if (files.length) {
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          await api('POST', `/api/sessions/${id}/send`, f, {
            'x-filename': encodeURIComponent(f.name),
            'x-to': encodeURIComponent(state.to),
            'x-text': encodeURIComponent(i === 0 ? text : '')
          })
        }
      } else {
        const r = await api('POST', `/api/sessions/${id}/say`, { text, to: state.to || null })
        if (state.to && !r.recipientOnline) toast(`${state.to} is offline. They'll see it when they’re back.`)
      }
      input.value = ''
      state.pending = []
      renderAttachments()
      grow()
    } catch (err) {
      toast(err.message)
    } finally {
      $('#send-btn').disabled = false
      input.focus()
    }
  }

  // drag & drop
  const center = $('#center')
  let depth = 0
  center.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; center.classList.add('dragging') } })
  center.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) center.classList.remove('dragging') })
  center.addEventListener('dragover', (e) => e.preventDefault())
  center.addEventListener('drop', (e) => {
    e.preventDefault()
    depth = 0
    center.classList.remove('dragging')
    addFiles(e.dataTransfer.files)
  })
  // paste images/files
  input.addEventListener('paste', (e) => {
    if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files) }
  })
}

function addFiles (list) {
  for (const f of list) {
    if (state.maxFileBytes && f.size > state.maxFileBytes) { toast(`${f.name} is larger than ${bytes(state.maxFileBytes)}`); continue }
    state.pending.push(f)
  }
  renderAttachments()
  $('#msg-input').focus()
}

function renderAttachments () {
  const el = $('#attachments')
  if (!el) return
  el.innerHTML = state.pending.map((f, i) => `<span class="tag">${esc(f.name)} · ${bytes(f.size)}<button type="button" data-unqueue="${i}" aria-label="Remove">×</button></span>`).join('')
  updatePlaceholder()
}

function updatePlaceholder () {
  const input = $('#msg-input')
  if (!input) return
  const who = state.to ? state.to : 'everyone'
  input.placeholder = state.pending.length ? `Add a note for ${who} (optional)…` : `Message ${who}…`
}

function renderRecipients () {
  const s = state.sessions.get(state.view)
  const sel = $('#to-select')
  if (!s || !sel) return
  const names = new Set(s.status.peers.map((p) => p.name))
  for (const m of state.messages.get(state.view) || []) {
    if (m.by !== s.status.me.name) names.add(m.by)
    if (m.to && m.to !== s.status.me.name) names.add(m.to)
  }
  if (state.to) names.add(state.to)
  const online = new Set(s.status.peers.map((p) => p.name))
  sel.innerHTML = `<option value="">Everyone</option>` + [...names].sort().map((n) =>
    `<option value="${esc(n)}" ${n === state.to ? 'selected' : ''}>${esc(n)} (direct${online.has(n) ? '' : ', offline'})</option>`).join('')
  sel.value = state.to
  updatePlaceholder()
}

function renderSessionPanels () {
  const s = state.sessions.get(state.view)
  if (!s || !$('#people')) return
  const st = s.status
  renderTabs()

  const pill = $('#conn-pill')
  pill.className = `pill ${st.connected ? 'ok' : 'warn'}`
  pill.innerHTML = `<span class="dot"></span>${st.connected ? 'Live' : 'Reconnecting…'}`

  const tools = (p) => [...new Set([p.tool, ...(p.agents || [])].filter((t) => t && t !== 'unknown'))]
  $('#me').innerHTML = `<div class="person">${avatar(st.me.name, st.me.color, st.connected)}<div>
    <div class="who">${esc(st.me.name)} ${tools(st.me).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <div class="hint">${st.fileCount} shared file${st.fileCount === 1 ? '' : 's'}</div></div></div>`
  const focusInput = $('#focus-input')
  if (document.activeElement !== focusInput) focusInput.value = st.me.focus || ''

  $('#online-count').textContent = st.peers.length ? String(st.peers.length) : ''
  $('#people').innerHTML = st.peers.length
    ? st.peers.map((p) => `
      <div class="person">${avatar(p.name, p.color, true)}<div style="min-width:0;flex:1">
        <div class="who">${esc(p.name)} ${tools(p).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        <div class="focus ${p.focus ? '' : 'empty'}">${esc(p.focus || 'No focus set')}</div>
        ${p.editing.length ? `<div class="files">${p.editing.slice(0, 4).map((e) => `<code title="${e.secondsAgo}s ago">${esc(e.path)}</code>`).join('')}</div>` : ''}
        <button class="btn sm ghost" style="margin:6px 0 -4px -8px" data-dm="${esc(p.name)}">Message</button>
      </div></div>`).join('')
    : '<div class="empty-note">Nobody else is here yet. Click <b>Invite</b> to bring someone in.</div>'

  $('#claims').innerHTML = st.claims.length
    ? st.claims.map((c) => `<div class="claim"><div class="meta"><code>${esc(c.pattern)}</code>
        <div class="sub">${c.by === st.me.name ? 'you' : esc(c.by)}${c.note ? ` · ${esc(c.note)}` : ''}</div></div>
        ${c.by === st.me.name ? `<button class="btn sm ghost icon" data-release="${esc(c.pattern)}" title="Release" aria-label="Release">${I.x}</button>` : ''}</div>`).join('')
    : '<div class="empty-note">Claim files you’re changing so nobody (human or agent) edits over you.</div>'

  $('#activity').innerHTML = st.activity.length
    ? st.activity.slice().reverse().slice(0, 40).map((a) => `<div class="feed-item"><span class="when">${esc(ago(a.ts))}</span>
        <div><b>${a.by === st.me.name ? 'You' : esc(a.by)}</b> ${esc(a.kind)} <code>${esc(a.path)}</code> ${a.detail ? `<span class="detail">${esc(a.detail)}</span>` : ''}</div></div>`).join('')
    : '<div class="empty-note">File changes will show up here.</div>'

  $('#chat-sub').textContent = st.peers.length ? `with ${st.peers.map((p) => p.name).join(', ')}` : 'room ' + st.room
  renderLogs()
  renderRecipients()
}

function renderLogs () {
  const s = state.sessions.get(state.view)
  const el = $('#logs')
  if (!s || !el) return
  // Chat lines are already in the chat panel.
  el.innerHTML = s.logs.filter((l) => !l.line.startsWith('💬')).slice(-25).reverse().map((l) => `<div class="log-line"><span class="hint">${esc(clock(l.ts))}</span> ${esc(l.line)}</div>`).join('') || '<div class="empty-note">Nothing yet.</div>'
}

function renderMessages (incoming = false, force = false) {
  const el = $('#messages')
  const s = state.sessions.get(state.view)
  if (!el || !s) return
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  const list = state.messages.get(state.view) || []
  const me = s.status.me.name
  const colors = new Map(s.status.peers.map((p) => [p.name, p.color]))
  colors.set(me, s.status.me.color)
  el.innerHTML = list.length
    ? list.map((m) => {
      const mine = m.by === me
      const dm = m.to ? `<span class="dm">${mine ? `to ${esc(m.to)}` : 'direct'}</span>` : ''
      const file = m.file ? `<a class="file-card" href="/api/sessions/${state.view}/files/${m.id}?t=${encodeURIComponent(TOKEN)}" download="${esc(m.file.name)}">
          <span class="fi">${I.file}</span><span style="min-width:0"><div class="fn">${esc(m.file.name)}</div><div class="fs">${bytes(m.file.size)} · ${mine ? 'sent' : 'download'}</div></span></a>` : ''
      return `<div class="msg${mine ? ' mine' : ''}">${mine ? '' : avatar(m.by, colors.get(m.by))}
        <div style="min-width:0"><div class="head"><b>${mine ? 'You' : esc(m.by)}</b>${dm}<span>${esc(clock(m.ts))}</span></div>
        <div class="bubble">${m.text ? `<div class="text">${esc(m.text)}</div>` : ''}${file}</div></div></div>`
    }).join('')
    : `<div class="day-empty"><img src="/logo.svg" alt=""><div><b>Say hi.</b></div><div class="hint">Messages, direct messages and files you share appear here. Drop a file anywhere in this panel to send it.</div></div>`
  if (force || nearBottom || (incoming && list[list.length - 1]?.by === me)) el.scrollTop = el.scrollHeight
}

// --------------------------------------------------------------- invite --
function openInvite (id) {
  const s = state.sessions.get(id)
  if (!s) return
  const d = decodeInvite(s.invite)
  const local = d && !d.server.startsWith('wss://')
  const back = document.createElement('div')
  back.className = 'modal-back'
  back.innerHTML = `<div class="card modal" role="dialog" aria-modal="true" aria-labelledby="inv-title">
    <h3 id="inv-title">Invite someone</h3>
    <p class="lead">Send them this code. They paste it into <b>Join a session</b> in elegy, or run the command in a terminal.</p>
    <div class="label" style="margin-bottom:6px">Invite code</div>
    <div class="codebox"><code id="inv-code">${esc(s.invite)}</code><button class="btn icon" data-copy="inv-code" title="Copy" aria-label="Copy invite code">${I.copy}</button></div>
    <div class="label" style="margin-bottom:6px">Or in a terminal</div>
    <div class="codebox"><code id="inv-cmd">elegy join ${esc(s.invite)}</code><button class="btn icon" data-copy="inv-cmd" title="Copy" aria-label="Copy command">${I.copy}</button></div>
    ${d ? `<p class="hint">Room <code>${esc(d.room)}</code> via <code>${esc(d.server)}</code></p>` : ''}
    ${local ? '<p class="hint warn">This is a local-network address. If your partner is somewhere else, run <code>cloudflared tunnel --url http://localhost:4321</code> and start a new session with the tunnel address as the public address (or use a hosted relay).</p>' : ''}
    <p class="hint">Anyone with this code can edit the project. Only share it with people you trust.</p>
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

// Refresh relative times.
setInterval(() => { if (state.view !== 'home') renderSessionPanels() }, 30000)

boot()
