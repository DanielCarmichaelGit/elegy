// cowove app: boot, live events, home screen, folder picker and invites.
// The session workspace lives in session.js. Plain ES modules, no build step.
import { TOKEN, I, TOOLS, state, $, esc, basename, ago, toast, api, decodeInvite, remember, recall } from './common.js'
import { mountSession, sessionUpdated, sessionMessage, sessionFeed, sessionFileChanged, sessionLog, sessionUnmount } from './session.js'

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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    document.title = 'cowove'
    if (state.view !== 'home') markRead(state.view)
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
  try { state.recent = (await api('GET', '/api/state')).recent } catch {}
}

export async function go (view) {
  state.view = view
  state.pending = []
  state.to = ''
  remember('view', view)
  if (view !== 'home' && !state.messages.has(view)) await loadMessages(view)
  render()
  if (view !== 'home') markRead(view)
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
  const app = $('#app')
  sessionUnmount()
  if (state.view === 'home') {
    app.innerHTML = state.sessions.size ? `<div class="shell">${topbarHtml()}<div style="overflow:auto;flex:1">${homeHtml()}</div></div>` : homeHtml()
    bindHome()
    bindTopbar()
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

function topbarHtml () {
  return `
    <header class="topbar">
      <button class="brand" data-go="home" aria-label="Home"><img src="/logo.svg" alt=""><span>co<i>wo</i>ve</span></button>
      <nav class="tabs" id="tabs"></nav>
      <button class="btn sm" data-go="home">${I.plus}<span>New</span></button>
      <button class="btn sm ghost icon" data-shutdown title="Shut down cowove" aria-label="Shut down cowove">${I.power}</button>
    </header>`
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

// ----------------------------------------------------------------- home --
function toolOptions (selected) {
  return TOOLS.map((t) => `<option ${t === selected ? 'selected' : ''}>${t}</option>`).join('')
}

// Who you are and what you code with rarely change, so they're a single
// line on the home screen instead of fields on every form.
const me = () => ({
  name: recall('name', state.defaults.name || ''),
  tool: recall('tool', state.defaults.tool || 'Claude Code')
})

const tildify = (p) => state.defaults.home && p.startsWith(state.defaults.home) ? `~${p.slice(state.defaults.home.length)}` : p

const hostOf = (url) => { try { return new URL(url.replace(/^ws/, 'http')).host } catch { return url } }

function relaySummary () {
  const saved = state.defaults.relay
  const mode = recall('relayMode', saved ? 'remote' : 'host')
  const server = saved ? saved.url : recall('server')
  if (mode === 'remote' && server) return `Relay: ${esc(hostOf(server))} (works from anywhere)`
  if (recall('publicUrl')) return `Relay: this computer, via ${esc(recall('publicUrl'))}`
  return 'Relay: this computer (same network)'
}

function homeHtml () {
  const { name, tool } = me()
  const saved = state.defaults.relay // your hosted relay, from `cowove relay set` or this form
  const relayMode = recall('relayMode', saved ? 'remote' : 'host')
  const running = [...state.sessions.values()]
  const recent = state.recent.slice(0, 3)
  return `
  <main class="home">
    <section class="hero${running.length || recent.length ? ' small' : ''}">
      <img src="/logo.svg" alt="">
      <div class="wordmark">co<i>wo</i>ve</div>
      <p class="tagline">Code together in real time, each in your own AI tool.</p>
    </section>

    ${running.length || recent.length ? `
    <section class="resume">
      <h3 class="section-title">Pick up where you left off</h3>
      <div class="list">
        ${running.map((s) => `
        <button class="card list-item" data-go="${s.id}">
          <div class="folder-ico live">${I.folder}</div>
          <div class="meta"><div class="name">${esc(basename(s.dir))}</div><div class="sub">Running · ${s.status.peers.length ? `${s.status.peers.length} other${s.status.peers.length === 1 ? '' : 's'} here` : 'just you so far'}</div></div>
          <span class="go">Open</span>
        </button>`).join('')}
        ${recent.map((r) => `
        <button class="card list-item" data-rejoin="${esc(r.dir)}">
          <div class="folder-ico">${I.folder}</div>
          <div class="meta"><div class="name">${esc(basename(r.dir))}</div><div class="sub">${esc(tildify(r.dir))} · ${esc(ago(r.lastUsed))}</div></div>
          <span class="go">Rejoin</span>
        </button>`).join('')}
      </div>
    </section>` : ''}

    <section class="choices">
      <form class="card choice" id="create-form" autocomplete="off">
        <h2>Start a session</h2>
        <p>Pick a project folder. You'll get an invite to send.</p>
        <div class="field">
          <label for="c-dir">Project folder</label>
          <div class="row"><input class="input grow" id="c-dir" name="dir" placeholder="~/code/my-app" value="${esc(tildify(recall('createDir', state.defaults.cwd || '')))}" required>
          <button type="button" class="btn icon" data-browse="c-dir" title="Browse" aria-label="Browse">${I.folder}</button></div>
        </div>
        <button class="btn primary full" type="submit">Start session</button>
        <p class="error" id="create-error"></p>
        <details class="more">
          <summary><span id="relay-summary">${relaySummary()}</span> · <u>change</u></summary>
          <div class="segmented" role="tablist">
            <button type="button" data-relay="remote" class="${relayMode === 'remote' ? 'on' : ''}">Hosted relay</button>
            <button type="button" data-relay="host" class="${relayMode === 'host' ? 'on' : ''}">This computer</button>
          </div>
          <div id="relay-host" ${relayMode === 'host' ? '' : 'hidden'}>
            <div class="field">
              <label for="c-public">Public address <span class="hint">(only if your partner is elsewhere)</span></label>
              <input class="input" id="c-public" name="publicUrl" placeholder="wss://your-tunnel.trycloudflare.com" value="${esc(recall('publicUrl'))}">
              <span class="hint">Run <code>cloudflared tunnel --url http://localhost:4321</code> and paste the https address it prints.</span>
            </div>
          </div>
          <div id="relay-remote" ${relayMode === 'remote' ? '' : 'hidden'}>
            <div class="field">
              <label for="c-server">Relay address</label>
              <input class="input" id="c-server" name="server" placeholder="wss://relay.example.com" value="${esc(saved ? saved.url : recall('server'))}" autocomplete="off" spellcheck="false">
              <span class="hint" id="relay-check">${saved ? 'Your default relay' : 'Anyone you invite connects here too. See docs/hosting.md to run your own.'}</span>
            </div>
            <div class="field">
              <label for="c-key">Relay key <span class="hint">(only if your relay needs one)</span></label>
              <input class="input" id="c-key" name="relayKey" type="password" autocomplete="off" placeholder="${saved && saved.hasKey ? 'Saved' : 'Not needed for most relays'}">
            </div>
            <label class="check"><input type="checkbox" name="saveDefault" ${saved ? '' : 'checked'}> Make this my default relay</label>
          </div>
        </details>
      </form>

      <form class="card choice" id="join-form" autocomplete="off">
        <h2>Join a session</h2>
        <p>Paste the invite your partner sent you.</p>
        <div class="field">
          <label for="j-invite">Invite</label>
          <textarea class="input mono" id="j-invite" name="invite" rows="2" placeholder="cowove join eyJz…" required></textarea>
          <span class="hint" id="invite-hint" hidden></span>
        </div>
        <button class="btn primary full" type="submit">Join session</button>
        <p class="error" id="join-error"></p>
        <details class="more" id="join-more">
          <summary>Files go to <span id="j-dir-summary">a new folder in ~/cowove</span> · <u>change</u></summary>
          <div class="field">
            <label for="j-dir">Put the project in</label>
            <div class="row"><input class="input grow" id="j-dir" name="dir" placeholder="~/cowove/their-app">
            <button type="button" class="btn icon" data-browse="j-dir" title="Browse" aria-label="Browse">${I.folder}</button></div>
            <span class="hint">An empty folder is best. It fills with their files.</span>
          </div>
          <label class="check"><input type="checkbox" name="preferLocal"> Keep my versions of files already in this folder</label>
        </details>
      </form>
    </section>

    <div class="identity" id="identity">
      <span>You'll show up as <b>${esc(name)}</b>, coding with <b>${esc(tool)}</b>.</span>
      <button type="button" class="linkish" id="edit-identity">Change</button>
      <form class="identity-edit" id="identity-form" hidden>
        <input class="input" name="name" value="${esc(name)}" aria-label="Your name" required>
        <select class="input" name="tool" aria-label="AI tool">${toolOptions(tool)}</select>
        <button class="btn sm primary" type="submit">Save</button>
      </form>
    </div>

    ${running.length ? '' : `<p class="footer-note"><button class="btn sm ghost" data-shutdown>${I.power}<span>Shut down cowove</span></button></p>`}
  </main>`
}

function bindHome () {
  const create = $('#create-form')
  const join = $('#join-form')
  if (!create) return

  let relayMode = recall('relayMode', state.defaults.relay ? 'remote' : 'host')
  const updateRelay = () => { $('#relay-summary').innerHTML = relaySummary() }
  create.querySelectorAll('[data-relay]').forEach((b) => {
    b.onclick = () => {
      relayMode = b.dataset.relay
      remember('relayMode', relayMode)
      create.querySelectorAll('[data-relay]').forEach((x) => x.classList.toggle('on', x === b))
      $('#relay-host').hidden = relayMode !== 'host'
      $('#relay-remote').hidden = relayMode !== 'remote'
      updateRelay()
    }
  })
  $('#c-public').onchange = (e) => { remember('publicUrl', e.target.value.trim()); updateRelay() }
  const serverInput = $('#c-server')
  const checkRelay = async () => {
    const url = serverInput.value.trim()
    const hint = $('#relay-check')
    if (!url) return
    hint.className = 'hint'
    hint.textContent = 'Checking…'
    try {
      const r = await api('POST', '/api/relay/check', { url })
      hint.className = 'hint ok'
      hint.textContent = `✓ Online · ${r.latencyMs} ms${r.requiresKey ? ' · needs a relay key to start sessions' : ''}`
    } catch (err) {
      hint.className = 'hint warn'
      hint.textContent = err.message
    }
  }
  serverInput.onchange = () => { remember('server', serverInput.value.trim()); updateRelay(); checkRelay() }
  document.querySelectorAll('[data-browse]').forEach((b) => {
    b.onclick = async () => {
      const input = $(`#${b.dataset.browse}`)
      const before = input.value
      await pickFolder(input)
      if (b.dataset.browse === 'j-dir' && input.value !== before) { joinDirTouched = true; syncJoinDir() }
    }
  })

  let joinDirTouched = false
  const syncJoinDir = () => { $('#j-dir-summary').textContent = $('#j-dir').value || 'a new folder in ~/cowove' }
  $('#j-dir').addEventListener('input', () => { joinDirTouched = true; syncJoinDir() })
  $('#j-invite').addEventListener('input', (e) => {
    const inv = e.target.value.trim()
    const hint = $('#invite-hint')
    const d = inv && decodeInvite(inv)
    hint.hidden = !inv || !!d
    hint.className = 'hint warn'
    hint.textContent = 'That doesn’t look like a cowove invite. Copy the whole thing they sent.'
    if (d && !joinDirTouched) { $('#j-dir').value = `~/cowove/${d.room}`; syncJoinDir() }
  })

  const idForm = $('#identity-form')
  $('#edit-identity').onclick = () => { idForm.hidden = !idForm.hidden; if (!idForm.hidden) idForm.name.focus() }
  idForm.onsubmit = (e) => {
    e.preventDefault()
    remember('name', idForm.name.value.trim())
    remember('tool', idForm.tool.value)
    render()
  }

  create.onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(create)
    const who = me()
    remember('createDir', f.get('dir'))
    const server = (f.get('server') || '').trim()
    const saveDefault = relayMode === 'remote' && !!f.get('saveDefault') && !!server
    if (saveDefault) state.defaults.relay = { url: server, hasKey: !!f.get('relayKey') || !!state.defaults.relay?.hasKey }
    await submit(create, '#create-error', {
      mode: 'create', dir: f.get('dir'), name: who.name, tool: who.tool,
      hostRelay: relayMode === 'host', publicUrl: recall('publicUrl'), server,
      relayKey: f.get('relayKey') || undefined, saveDefault
    })
  }
  join.onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(join)
    const d = decodeInvite(f.get('invite') || '')
    if (!d) { $('#join-error').textContent = 'Paste the invite your partner sent you.'; return }
    const dir = (f.get('dir') || '').trim() || `~/cowove/${d.room}`
    const who = me()
    await submit(join, '#join-error', {
      mode: 'join', invite: f.get('invite'), dir, name: who.name, tool: who.tool,
      prefer: f.get('preferLocal') ? 'local' : 'remote'
    })
  }
  document.querySelectorAll('[data-rejoin]').forEach((b) => {
    b.onclick = async () => {
      const label = b.querySelector('.go')
      b.disabled = true
      label.textContent = 'Connecting…'
      try {
        const sum = await api('POST', '/api/sessions', { mode: 'rejoin', dir: b.dataset.rejoin })
        state.sessions.set(sum.id, sum)
        await go(sum.id)
      } catch (err) {
        toast(err.message)
        b.disabled = false
        label.textContent = 'Rejoin'
      }
    }
  })
}

async function submit (form, errSel, body) {
  const btn = form.querySelector('button[type=submit]')
  const label = btn.textContent
  btn.disabled = true
  btn.textContent = 'Connecting…'
  $(errSel).textContent = ''
  try {
    const sum = await api('POST', '/api/sessions', body)
    state.sessions.set(sum.id, sum)
    await go(sum.id)
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
    <p class="lead">Send them this code. They paste it into <b>Join a session</b> in cowove, or run the command in a terminal.</p>
    <div class="label" style="margin-bottom:6px">Invite code</div>
    <div class="codebox"><code id="inv-code">${esc(s.invite)}</code><button class="btn icon" data-copy="inv-code" title="Copy" aria-label="Copy invite code">${I.copy}</button></div>
    <div class="label" style="margin-bottom:6px">Or in a terminal</div>
    <div class="codebox"><code id="inv-cmd">cowove join ${esc(s.invite)}</code><button class="btn icon" data-copy="inv-cmd" title="Copy" aria-label="Copy command">${I.copy}</button></div>
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

boot()
