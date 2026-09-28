// Home and Settings: a sidebar with your profile and open sessions, next to
// either the start/join page or your settings. Sessions themselves live in session.js.
import { I, state, $, esc, basename, ago, toast, api, decodeInvite, avatar, PALETTE } from './common.js'
import { go, pickFolder } from './app.js'

export const tildify = (p) => state.defaults.home && String(p).startsWith(state.defaults.home) ? `~${String(p).slice(state.defaults.home.length)}` : p
const hostOf = (url) => { try { return new URL(String(url).replace(/^ws/, 'http')).host } catch { return url } }
const isHosted = () => state.profile.relayMode === 'hosted' && !!state.profile.relay
const firstName = () => String(state.profile.name || '').split(/[\s._-]/)[0] || state.profile.name

function greeting () {
  const h = new Date().getHours()
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

// ---------------------------------------------------------------- shell --
export function renderShell (view) {
  const page = $('#page')
  const scroll = page ? page.scrollTop : 0
  $('#app').innerHTML = `
    <div class="app-shell">
      ${sidebarHtml(view)}
      <main class="page" id="page">${view === 'settings' ? settingsHtml() : homeHtml()}</main>
    </div>`
  if (page && view === state.shellView) $('#page').scrollTop = scroll
  state.shellView = view
  bindSidebar()
  if (view === 'settings') bindSettings()
  else bindHome()
  paintRelayStatus()
  refreshRelayStatus()
}

function sidebarHtml (view) {
  const p = state.profile
  const running = [...state.sessions.values()]
  return `
  <aside class="side">
    <button class="brand" data-view="home" aria-label="Home"><img src="/logo.svg" alt=""><span>co<i>wo</i>ve</span></button>

    <button class="me-card" data-view="settings" title="Edit your profile">
      ${avatar(p.name, p.color)}
      <span class="me-text"><b>${esc(p.name)}</b><span>${esc(p.tool)}</span></span>
      <span class="me-edit">Edit</span>
    </button>

    <nav class="side-nav" aria-label="Main">
      <button data-view="home" class="${view === 'home' ? 'on' : ''}">${I.home}<span>Home</span></button>
      <button data-view="settings" class="${view === 'settings' ? 'on' : ''}">${I.gear}<span>Settings</span></button>
    </nav>

    ${running.length ? `
    <div class="side-label">Open now</div>
    <div class="side-sessions">
      ${running.map((s) => `<button data-go="${s.id}" title="${esc(s.dir)}">
        <span class="dot" style="background:${s.status.connected ? 'var(--ok)' : 'var(--warn)'}"></span>
        <span class="nm">${esc(basename(s.dir))}</span>
        <span class="ct" title="People here">${s.status.peers.length + 1}</span>
      </button>`).join('')}
    </div>` : ''}

    <div class="side-foot">
      <button class="relay-status" id="relay-status" data-view="settings" data-anchor="relay-sec" title="Relay settings"></button>
      <button class="btn sm ghost side-off" data-shutdown>${I.power}<span>Shut down</span></button>
    </div>
  </aside>`
}

function bindSidebar () {
  document.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => {
      go(b.dataset.view)
      if (b.dataset.anchor) requestAnimationFrame(() => $(`#${b.dataset.anchor}`)?.scrollIntoView({ block: 'start' }))
    }
  })
  document.querySelectorAll('.side [data-go]').forEach((b) => { b.onclick = () => go(b.dataset.go) })
}

// ---------------------------------------------------------- relay status --
async function refreshRelayStatus (force = false) {
  const url = isHosted() ? state.profile.relay.url : null
  if (!url) { state.relayStatus = null; return paintRelayStatus() }
  const fresh = state.relayStatus && state.relayStatus.url === url && Date.now() - state.relayStatus.at < 60000
  if (fresh && !force) return
  try {
    const r = await api('POST', '/api/relay/check', { url })
    state.relayStatus = { url, ok: true, latencyMs: r.latencyMs, at: Date.now() }
  } catch (err) {
    state.relayStatus = { url, ok: false, error: err.message, at: Date.now() }
  }
  paintRelayStatus()
}

function paintRelayStatus () {
  const el = $('#relay-status')
  if (!el) return
  const st = state.relayStatus
  if (!isHosted()) {
    el.innerHTML = `<span class="dot"></span><span class="rs-main"><b>This computer</b><span>Same network only</span></span>`
    return
  }
  const host = hostOf(state.profile.relay.url)
  const line = !st ? 'Checking…' : st.ok ? `Online · ${st.latencyMs} ms` : 'Can’t reach it'
  el.innerHTML = `<span class="dot" style="background:${!st ? 'var(--faint)' : st.ok ? 'var(--ok)' : 'var(--bad)'}"></span>
    <span class="rs-main"><b>${esc(host)}</b><span>${esc(line)}</span></span>`
  el.title = st && !st.ok ? st.error : 'Relay settings'
}

// ------------------------------------------------------------------ home --
function sessionRows () {
  const running = [...state.sessions.values()].map((s) => ({
    live: true, id: s.id, dir: s.dir, name: s.status.me.name, tool: s.status.me.tool,
    server: s.status.server, peers: s.status.peers.length
  }))
  const recent = state.recent.map((r) => ({ live: false, dir: r.dir, name: r.name, tool: r.tool, server: r.server, lastUsed: r.lastUsed }))
  return [...running, ...recent]
}

function relayLabel (server) {
  if (!server) return ''
  return /^ws:\/\/(127\.0\.0\.1|localhost)/.test(server) ? 'This computer' : hostOf(server)
}

function homeHtml () {
  const p = state.profile
  const rows = sessionRows()
  return `
  <header class="page-head">
    <h1>${greeting()}, ${esc(firstName())}</h1>
    <p>Start a session from one of your folders, or join one a partner shared with you.</p>
  </header>

  <section class="choices">
    <form class="card choice" id="create-form" autocomplete="off">
      <div class="choice-head"><span class="choice-ico">${I.plus}</span><div><h2>Start a session</h2><p>Share a folder and invite someone in.</p></div></div>
      <div class="field">
        <label for="c-dir">Project folder</label>
        <div class="row"><input class="input grow" id="c-dir" name="dir" placeholder="~/code/my-app" value="${esc(tildify(state.lastCreateDir || state.defaults.cwd || ''))}" required>
        <button type="button" class="btn icon" data-browse="c-dir" title="Browse" aria-label="Browse">${I.folder}</button></div>
      </div>
      <button class="btn primary full" type="submit">Start session</button>
      <p class="error" id="create-error"></p>
      <p class="choice-foot">${I.globe}<span>${isHosted() ? `Partners connect through <b>${esc(hostOf(p.relay.url))}</b>` : 'Partners must be on your network'}</span>
        <button type="button" class="linkish" data-view="settings" data-anchor="relay-sec">Change</button></p>
    </form>

    <form class="card choice" id="join-form" autocomplete="off">
      <div class="choice-head"><span class="choice-ico">${I.link}</span><div><h2>Join a session</h2><p>Paste the invite your partner sent you.</p></div></div>
      <div class="field">
        <label for="j-invite">Invite</label>
        <textarea class="input mono" id="j-invite" name="invite" rows="2" placeholder="cowove join eyJz…" required></textarea>
        <span class="hint warn" id="invite-hint" hidden>That doesn’t look like a cowove invite. Copy the whole thing they sent.</span>
      </div>
      <button class="btn primary full" type="submit">Join session</button>
      <p class="error" id="join-error"></p>
      <details class="choice-foot more" id="join-more">
        <summary>${I.folder}<span>Files go to <b id="j-dir-summary">${esc(p.joinDir)}/&lt;room&gt;</b></span><u>Change</u></summary>
        <div class="row" style="margin-top:10px"><input class="input grow" id="j-dir" name="dir" placeholder="${esc(p.joinDir)}/their-app">
        <button type="button" class="btn icon" data-browse="j-dir" title="Browse" aria-label="Browse">${I.folder}</button></div>
        <span class="hint">Just for this session. Set the usual place in <button type="button" class="linkish" data-view="settings" data-anchor="sessions-sec">Settings</button>.</span>
      </details>
    </form>
  </section>

  <section class="sessions">
    <div class="sec-head"><h2>Your sessions</h2>${rows.length ? `<span class="count">${rows.length}</span>` : ''}</div>
    ${rows.length ? `<div class="card session-list">${rows.map((r) => `
      <div class="session-row${r.live ? ' live' : ''}">
        <div class="folder-ico${r.live ? ' live' : ''}">${I.folder}</div>
        <div class="meta">
          <div class="name">${esc(basename(r.dir))}${r.live ? '<span class="pill ok"><span class="dot"></span>Open</span>' : ''}</div>
          <div class="sub">${esc(tildify(r.dir))}</div>
        </div>
        <div class="facts">
          <span title="Your name there">${I.user}${esc(r.name || '')}</span>
          ${r.server ? `<span title="Relay">${I.globe}${esc(relayLabel(r.server))}</span>` : ''}
          <span>${r.live ? `${r.peers ? `${r.peers} other${r.peers === 1 ? '' : 's'} here` : 'Just you'}` : esc(ago(r.lastUsed))}</span>
        </div>
        <div class="acts">
          ${r.live
            ? `<button class="btn sm primary" data-go="${r.id}">Open</button>`
            : `<button class="btn sm" data-rejoin="${esc(r.dir)}">Rejoin</button>
               <button class="btn sm ghost icon" data-forget="${esc(r.dir)}" title="Remove from this list" aria-label="Remove ${esc(basename(r.dir))} from this list">${I.x}</button>`}
        </div>
      </div>`).join('')}</div>`
    : `<div class="card empty-card">${I.folder}<div><b>No sessions yet</b><p class="hint">Sessions you start or join show up here, so you can pick them up again in one click.</p></div></div>`}
  </section>`
}

function bindHome () {
  const create = $('#create-form')
  const join = $('#join-form')

  let joinDirTouched = false
  const syncJoinDir = () => {
    const d = decodeInvite($('#j-invite').value)
    $('#j-dir-summary').textContent = $('#j-dir').value || `${state.profile.joinDir}/${d ? d.room : '<room>'}`
  }
  document.querySelectorAll('[data-browse]').forEach((b) => {
    b.onclick = async () => {
      const input = $(`#${b.dataset.browse}`)
      const before = input.value
      await pickFolder(input)
      if (b.dataset.browse === 'j-dir' && input.value !== before) { joinDirTouched = true; syncJoinDir() }
    }
  })
  $('#j-dir').addEventListener('input', () => { joinDirTouched = true; syncJoinDir() })
  $('#j-invite').addEventListener('input', (e) => {
    const inv = e.target.value.trim()
    $('#invite-hint').hidden = !inv || !!decodeInvite(inv)
    if (!joinDirTouched) syncJoinDir()
  })

  create.onsubmit = async (e) => {
    e.preventDefault()
    const dir = new FormData(create).get('dir')
    state.lastCreateDir = dir
    await submit(create, '#create-error', { mode: 'create', dir })
  }
  join.onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(join)
    if (!decodeInvite(f.get('invite') || '')) { $('#join-error').textContent = 'Paste the invite your partner sent you.'; return }
    await submit(join, '#join-error', { mode: 'join', invite: f.get('invite'), dir: (f.get('dir') || '').trim() || undefined })
  }

  document.querySelectorAll('.session-list [data-go]').forEach((b) => { b.onclick = () => go(b.dataset.go) })
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
  document.querySelectorAll('[data-forget]').forEach((b) => {
    b.onclick = async () => {
      try {
        state.recent = (await api('POST', '/api/recent/forget', { dir: b.dataset.forget })).recent
        renderShell('home')
        toast('Removed from the list. The folder is untouched.')
      } catch (err) { toast(err.message) }
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

// -------------------------------------------------------------- settings --
function toggle (name, checked, label, hint) {
  return `<label class="toggle"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}><span class="track"><span class="knob"></span></span>
    <span class="tg-text"><b>${label}</b><span class="hint">${hint}</span></span></label>`
}

function settingsHtml () {
  const p = state.profile
  const hosted = isHosted() || (!p.relay && p.relayMode === 'hosted')
  return `
  <header class="page-head">
    <h1>Settings</h1>
    <p>Saved on this computer and used for every new session.</p>
  </header>

  <form class="card settings-sec" id="profile-sec" autocomplete="off">
    <div class="sec-intro"><h2>Profile</h2><p>How you show up to the people you code with.</p></div>
    <div class="sec-body">
      <div class="profile-preview" id="pv">${avatar(p.name, p.color)}<div><b id="pv-name">${esc(p.name)}</b><span id="pv-tool">coding with ${esc(p.tool)}</span></div></div>
      <div class="field">
        <label for="s-name">Name</label>
        <input class="input" id="s-name" name="name" value="${esc(p.name)}" maxlength="64" required>
      </div>
      <div class="field">
        <span class="label">Color</span>
        <div class="swatches" role="radiogroup" aria-label="Color">
          <label class="swatch auto" title="Automatic"><input type="radio" name="color" value="" ${p.color ? '' : 'checked'}><span>Auto</span></label>
          ${PALETTE.map((c) => `<label class="swatch" title="${c}"><input type="radio" name="color" value="${c}" ${p.color === c ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}
        </div>
      </div>
      <div class="field">
        <label for="s-tool">AI tool you use</label>
        <select class="input" id="s-tool" name="tool">${state.defaults.tools.map((t) => `<option ${t === p.tool ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <span class="hint">Shown next to your name, and used to find your AI chat so partners can follow along.</span>
      </div>
      <div class="sec-actions"><span class="hint">New sessions use this. Rejoin a running session to update it there.</span><button class="btn primary" type="submit">Save profile</button></div>
    </div>
  </form>

  <form class="card settings-sec" id="sessions-sec" autocomplete="off">
    <div class="sec-intro"><h2>Sessions</h2><p>Defaults for starting and joining.</p></div>
    <div class="sec-body">
      <div class="field">
        <label for="s-joindir">Put projects you join in</label>
        <div class="row"><input class="input grow" id="s-joindir" name="joinDir" value="${esc(p.joinDir)}">
        <button type="button" class="btn icon" data-browse-settings="s-joindir" title="Browse" aria-label="Browse">${I.folder}</button></div>
        <span class="hint">Each session gets its own folder in here.</span>
      </div>
      ${toggle('shareAgent', p.shareAgent, 'Share my AI chat', 'Partners see your prompts, the replies and which files it touches. You can pause it inside any session.')}
      ${toggle('preferLocal', p.preferLocal, 'Keep my files when joining a folder that has some', 'When off, their versions of the same files win.')}
      <div class="sec-actions"><span></span><button class="btn primary" type="submit">Save</button></div>
    </div>
  </form>

  <form class="card settings-sec" id="relay-sec" autocomplete="off">
    <div class="sec-intro"><h2>Relay</h2><p>The server that connects you and your partners. Sessions left unused for 30 days are deleted from it.</p></div>
    <div class="sec-body">
      <div class="choice-cards" role="radiogroup" aria-label="Relay">
        <label class="choice-card"><input type="radio" name="relayMode" value="hosted" ${hosted ? 'checked' : ''}>
          <span><b>Hosted relay</b><span class="hint">Works from anywhere</span></span></label>
        <label class="choice-card"><input type="radio" name="relayMode" value="local" ${hosted ? '' : 'checked'}>
          <span><b>This computer</b><span class="hint">Same network, or through a tunnel</span></span></label>
      </div>
      <div id="relay-hosted" ${hosted ? '' : 'hidden'}>
        <div class="field">
          <label for="s-relay">Relay address</label>
          <input class="input mono" id="s-relay" name="relay" value="${esc(p.relay?.url || '')}" placeholder="wss://relay.example.com" spellcheck="false">
          <span class="hint" id="s-relay-check"></span>
        </div>
        <div class="field">
          <label for="s-key">Relay key</label>
          <input class="input" id="s-key" name="relayKey" type="password" autocomplete="off" placeholder="${p.relay?.hasKey ? 'Saved. Type a new one to replace it.' : 'Only if the relay needs one'}">
          <span class="hint">Needed to start sessions on a private relay. Partners joining don't need it.</span>
        </div>
      </div>
      <div id="relay-local" ${hosted ? 'hidden' : ''}>
        <div class="field">
          <label for="s-public">Public address <span class="hint">(optional)</span></label>
          <input class="input mono" id="s-public" name="publicUrl" value="${esc(p.publicUrl)}" placeholder="wss://your-tunnel.trycloudflare.com" spellcheck="false">
          <span class="hint">For partners elsewhere: run <code>cloudflared tunnel --url http://localhost:4321</code> and paste the address it prints.</span>
        </div>
      </div>
      <div class="sec-actions"><span></span><button class="btn primary" type="submit">Save relay</button></div>
    </div>
  </form>

  <section class="card settings-sec">
    <div class="sec-intro"><h2>This computer</h2><p>Where cowove keeps things.</p></div>
    <div class="sec-body">
      <div class="kv"><span>Identity key</span><code>~/.cowove/identity.json</code><span class="hint">Proves your name is yours. Copy it to another computer to keep your name there.</span></div>
      <div class="kv"><span>Settings</span><code>~/.cowove/settings.json</code></div>
      <div class="sec-actions"><span class="hint">Stops every session and this app. Your files stay put.</span><button class="btn" type="button" data-shutdown>${I.power}<span>Shut down cowove</span></button></div>
    </div>
  </section>`
}

function bindSettings () {
  const saveForm = (form, pick, done) => {
    form.onsubmit = async (e) => {
      e.preventDefault()
      const btn = form.querySelector('button[type=submit]')
      btn.disabled = true
      try {
        state.profile = await api('POST', '/api/settings', pick(new FormData(form)))
        if (form.id === 'relay-sec') state.relayStatus = null
        toast('Saved')
        renderShell('settings')
        done && done()
      } catch (err) {
        toast(err.message)
        btn.disabled = false
      }
    }
  }

  // Profile: live preview while typing.
  const prof = $('#profile-sec')
  const preview = () => {
    const f = new FormData(prof)
    const name = f.get('name') || '?'
    $('#pv').querySelector('.avatar').outerHTML = avatar(name, f.get('color') || null)
    $('#pv-name').textContent = name
    $('#pv-tool').textContent = `coding with ${f.get('tool')}`
  }
  prof.addEventListener('input', preview)
  prof.addEventListener('change', preview)
  saveForm(prof, (f) => ({ name: f.get('name'), color: f.get('color'), tool: f.get('tool') }))

  const sess = $('#sessions-sec')
  sess.querySelector('[data-browse-settings]').onclick = () => pickFolder($('#s-joindir'))
  saveForm(sess, (f) => ({ joinDir: f.get('joinDir'), shareAgent: !!f.get('shareAgent'), preferLocal: !!f.get('preferLocal') }))

  const relay = $('#relay-sec')
  relay.querySelectorAll('[name=relayMode]').forEach((r) => {
    r.onchange = () => {
      $('#relay-hosted').hidden = r.value !== 'hosted'
      $('#relay-local').hidden = r.value === 'hosted'
    }
  })
  const check = async () => {
    const url = $('#s-relay').value.trim()
    const hint = $('#s-relay-check')
    if (!url) { hint.textContent = ''; return }
    hint.className = 'hint'
    hint.textContent = 'Checking…'
    try {
      const r = await api('POST', '/api/relay/check', { url })
      hint.className = 'hint ok'
      hint.textContent = `✓ Online · ${r.latencyMs} ms${r.requiresKey ? ` · needs a relay key to start sessions${state.profile.relay?.hasKey && state.profile.relay.url === url ? ' (saved)' : ''}` : ''}`
    } catch (err) {
      hint.className = 'hint warn'
      hint.textContent = err.message
    }
  }
  $('#s-relay').addEventListener('change', check)
  if ($('#s-relay').value && !$('#relay-hosted').hidden) check()
  saveForm(relay, (f) => {
    const mode = f.get('relayMode')
    if (mode === 'hosted' && !f.get('relay')) throw new Error('Enter the relay address.')
    return mode === 'hosted'
      ? { relayMode: 'hosted', relay: f.get('relay'), relayKey: f.get('relayKey') || undefined }
      : { relayMode: 'local', publicUrl: f.get('publicUrl') }
  })
}
