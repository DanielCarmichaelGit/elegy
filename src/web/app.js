// The elegy website: share a folder or join one from an invite link, then
// keep the tab open while it syncs. No accounts: a session is its link.
import { WebSession } from './engine.js'
import { handleFolder } from './folders.js'
import { encodeInvite, decodeInvite, inviteLink, newRoom } from './invite.js'
import { saveSession, listSessions, getSession, forgetSession, prefs } from './store.js'

const $ = (sel, el = document) => el.querySelector(sel)
const app = $('#app')
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const TOOLS = ['Claude Code', 'Cursor', 'Codex', 'Other']
const canPickFolders = typeof window.showDirectoryPicker === 'function'
const testFolder = new URLSearchParams(location.search).get('testfolder') // automated tests: use the browser's private file system
const relayAddress = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`

let session = null // the running WebSession
let current = null // { room, server, secret, name, tool, folderName }
let relayInfo = null

// ----------------------------------------------------------------- misc --

function toast (msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('on')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => t.classList.remove('on'), 2600)
}

async function copy (text, msg = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(msg) } catch { toast('Copy failed: select the text and copy it') }
}

function ago (ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

const initials = (name) => String(name || '?').trim().slice(0, 1).toUpperCase()
// Colors are applied from script: the page's security policy blocks inline style attributes.
const avatar = (p) => `<span class="av" data-color="${esc(p.color || '#7a6cff')}">${esc(initials(p.name))}</span>`
const paintAvatars = (root) => root.querySelectorAll('[data-color]').forEach((el) => { el.style.background = el.dataset.color })

async function pickFolder () {
  if (testFolder) {
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle(testFolder, { create: true })
  }
  return window.showDirectoryPicker({ id: 'elegy', mode: 'readwrite' })
}

async function ensurePermission (handle) {
  if (!handle.queryPermission) return true
  const opts = { mode: 'readwrite' }
  if ((await handle.queryPermission(opts)) === 'granted') return true
  return (await handle.requestPermission(opts)) === 'granted'
}

async function loadRelayInfo () {
  try { relayInfo = await (await fetch('/healthz', { cache: 'no-store' })).json() } catch { relayInfo = null }
}

// ---------------------------------------------------------------- views --

const logo = '<img src="/logo.svg" alt="" class="logo">'

function identityFields () {
  const tool = prefs.get('tool', 'Claude Code')
  return `
    <label class="field"><span>Your name</span>
      <input id="name" class="input" autocomplete="nickname" maxlength="40" placeholder="e.g. Sam" value="${esc(prefs.get('name'))}"></label>
    <div class="field"><span>Coding with</span>
      <div class="chips" role="radiogroup" aria-label="Coding with">
        ${TOOLS.map((t) => `<button type="button" role="radio" class="chip${t === tool ? ' on' : ''}" aria-checked="${t === tool}" data-tool="${esc(t)}">${esc(t)}</button>`).join('')}
      </div></div>
    ${relayInfo && relayInfo.requiresKey && !location.hash ? `<label class="field"><span>Server key <em>(this server needs one to start sessions)</em></span>
      <input id="relaykey" class="input" type="password" autocomplete="off" value="${esc(prefs.get('relayKey'))}"></label>` : ''}`
}

function bindIdentity (root) {
  root.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('[data-tool]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b) })
  }))
}

function readIdentity () {
  const name = $('#name').value.trim()
  const tool = ($('[data-tool].on') || {}).dataset?.tool || 'Other'
  if (!name) { $('#name').focus(); toast('Add your name so others know who you are'); return null }
  prefs.set('name', name)
  prefs.set('tool', tool)
  const key = $('#relaykey') ? $('#relaykey').value.trim() : ''
  if (key) prefs.set('relayKey', key)
  return { name, tool, key }
}

function unsupported () {
  return `<div class="notice">
    <strong>This browser can't open folders.</strong>
    elegy syncs a folder on your computer, which only Chrome, Edge, Brave and Arc allow websites to do.
    Open this page in one of those to take part.</div>`
}

async function renderHome () {
  const recent = await listSessions()
  app.innerHTML = `
  <main class="home">
    <header class="hero">${logo}
      <h1>Code together, live.</h1>
      <p>Share a project folder. Everyone keeps using their own AI tool, and every change shows up on everyone's computer as it happens.</p>
    </header>
    <section class="card">
      ${canPickFolders || testFolder ? identityFields() : unsupported()}
      ${canPickFolders || testFolder ? '<button id="share" class="btn grad big">Share a folder</button><p class="fine">You\'ll pick your project folder and allow elegy to edit it. Nothing to install.</p>' : ''}
    </section>
    ${recent.length ? `<section class="card recent"><h2>Your sessions</h2>
      ${recent.map((r) => `<div class="row-item">
        <div><strong>${esc(r.folderName || r.room)}</strong><span class="muted"> · ${esc(ago(r.lastUsed))}</span></div>
        <div class="row-actions"><button class="btn sm" data-resume="${esc(r.room)}">Open</button>
        <button class="btn sm ghost" data-forget="${esc(r.room)}" aria-label="Forget ${esc(r.folderName || r.room)}">Forget</button></div></div>`).join('')}
    </section>` : ''}
    <footer class="foot">Works in Chrome, Edge, Brave and Arc · <a href="/status">server status</a></footer>
  </main>`
  bindIdentity(app)
  $('#share')?.addEventListener('click', async () => {
    const id = readIdentity()
    if (!id) return
    let handle
    try { handle = await pickFolder() } catch { return } // cancelled
    const conn = { ...newRoom(relayAddress), key: id.key }
    await begin({ conn, handle, ...id, started: true })
  })
  app.querySelectorAll('[data-resume]').forEach((b) => b.addEventListener('click', () => resume(b.dataset.resume)))
  app.querySelectorAll('[data-forget]').forEach((b) => b.addEventListener('click', async () => { await forgetSession(b.dataset.forget); renderHome() }))
}

async function renderJoin (conn) {
  const known = await getSession(conn.room)
  if (known && known.handle) return renderResume(known)
  app.innerHTML = `
  <main class="home">
    <header class="hero">${logo}
      <h1>You're invited to a live session</h1>
      <p>Pick a folder for the project. Its files will appear there and stay in sync with everyone, and you can open it in any editor or AI tool.</p>
    </header>
    <section class="card">
      ${canPickFolders || testFolder ? identityFields() : unsupported()}
      ${canPickFolders || testFolder ? '<button id="join" class="btn grad big">Choose a folder for the project</button><p class="fine">Best in an empty folder. If files are already there, the session\'s versions win and yours are kept in <code>.elegy/conflicts</code>.</p>' : ''}
    </section>
    <footer class="foot"><a href="/">Start your own session instead</a></footer>
  </main>`
  bindIdentity(app)
  $('#join')?.addEventListener('click', async () => {
    const id = readIdentity()
    if (!id) return
    let handle
    try { handle = await pickFolder() } catch { return }
    await begin({ conn, handle, ...id })
  })
}

function renderResume (s) {
  app.innerHTML = `
  <main class="home">
    <header class="hero">${logo}<h1>${esc(s.folderName || s.room)}</h1>
      <p>You've been in this session before. Continue where you left off; anything that changed meanwhile gets merged.</p></header>
    <section class="card"><button id="go" class="btn grad big">Continue syncing ${esc(s.folderName || 'this folder')}</button>
    <p class="fine">Your browser may ask again for permission to edit the folder.</p></section>
    <footer class="foot"><a href="/">Home</a></footer>
  </main>`
  $('#go').addEventListener('click', () => resume(s.room))
}

async function resume (room) {
  const s = await getSession(room)
  if (!s || !s.handle) return toast('That session is no longer saved here')
  try {
    if (!(await ensurePermission(s.handle))) return toast('elegy needs permission to edit the folder')
  } catch { return toast('That folder is no longer available') }
  await begin({ conn: { server: s.server, room: s.room, secret: s.secret, key: s.key }, handle: s.handle, name: s.name, tool: s.tool })
}

// ------------------------------------------------------------- session --

async function begin ({ conn, handle, name, tool, key, started = false }) {
  if (session) await session.stop()
  app.innerHTML = `<main class="home"><section class="card center"><div class="spinner"></div><p>Connecting and syncing <strong>${esc(handle.name)}</strong>…</p></section></main>`
  current = { ...conn, key: key || conn.key || '', name, tool, folderName: handle.name }
  session = new WebSession({ folder: handleFolder(handle), server: conn.server, room: conn.room, secret: conn.secret, key: current.key, name, tool })
  const logs = []
  session.on('log', (l) => { logs.push(l); if (logs.length > 30) logs.shift() })
  window.elegyLogs = logs // for troubleshooting from the console
  session.on('fatal', (err) => { toast(err.message); session.stop(); session = null; renderError(err.message) })
  try {
    await session.start()
  } catch (err) {
    session.stop().catch(() => {})
    session = null
    return renderError(err.message)
  }
  await saveSession({ room: conn.room, server: conn.server, secret: conn.secret, key: current.key, name, tool, handle, folderName: handle.name })
  history.replaceState(null, '', `/#${encodeInvite(conn)}`)
  renderSession()
  if (started) showInvite(true)
}

function renderError (msg) {
  app.innerHTML = `<main class="home"><section class="card center"><h2>Couldn't connect</h2><p class="muted">${esc(msg)}</p>
    <button class="btn" id="back">Back</button></section></main>`
  $('#back').addEventListener('click', () => route())
}

function link () { return inviteLink(location.origin, current) }

function showInvite (fresh) {
  const d = document.createElement('dialog')
  d.className = 'modal'
  d.innerHTML = `<h2>${fresh ? 'Your folder is live' : 'Invite people'}</h2>
    <p class="muted">Send this link. Anyone who opens it can join and edit, so share it only with people you trust.</p>
    <div class="linkbox"><input class="input mono" readonly value="${esc(link())}" aria-label="Invite link"><button class="btn primary" id="cp">Copy link</button></div>
    <div class="actions"><button class="btn ghost" id="close">Done</button></div>`
  document.body.appendChild(d)
  d.showModal()
  $('#cp', d).addEventListener('click', () => copy(link(), 'Invite link copied'))
  $('#close', d).addEventListener('click', () => d.close())
  d.addEventListener('close', () => d.remove())
  $('input', d).select()
}

function renderSession () {
  app.innerHTML = `
  <div class="shell">
    <header class="top">
      <a href="/" class="brand" id="home">${logo}<span>elegy</span></a>
      <div class="where"><span class="dot" id="dot"></span><strong>${esc(current.folderName)}</strong><span class="muted" id="conn"></span></div>
      <div class="grow"></div>
      <button class="btn sm grad" id="invite">Invite</button>
      <button class="btn sm ghost" id="stop">Stop</button>
    </header>
    <div class="keepopen">Keep this tab open while you work. It's what keeps <strong>${esc(current.folderName)}</strong> in sync.</div>
    <div class="grid">
      <aside class="col">
        <section class="panel"><h3>People</h3><div id="people"></div></section>
        <section class="panel"><h3>Recent changes</h3><div id="activity" class="list"></div></section>
      </aside>
      <section class="panel feed-panel"><h3>What their AI is doing</h3><div id="feed" class="feed"></div></section>
      <section class="panel chat-panel"><h3>Chat</h3><div id="chat" class="chat"></div>
        <form id="say" class="say"><input class="input" id="msg" placeholder="Message everyone" autocomplete="off" maxlength="4000"><button class="btn primary">Send</button></form>
      </section>
    </div>
  </div>`
  $('#invite').addEventListener('click', () => showInvite(false))
  $('#stop').addEventListener('click', stop)
  $('#home').addEventListener('click', (e) => { e.preventDefault(); if (confirm('Stop syncing and go home?')) stop() })
  $('#say').addEventListener('submit', (e) => {
    e.preventDefault()
    const m = $('#msg')
    if (session && session.say(m.value)) m.value = ''
  })
  session.on('change', schedule)
  session.on('file-changed', schedule)
  update()
  clearInterval(renderSession.tick)
  renderSession.tick = setInterval(update, 15000) // refresh "2m ago"
}

async function stop () {
  clearInterval(renderSession.tick)
  const s = session
  session = null
  if (s) await s.stop()
  history.replaceState(null, '', '/')
  route()
}

let pending = false
function schedule () {
  if (pending) return
  pending = true
  requestAnimationFrame(() => { pending = false; update() })
}

function aiLine (p) {
  const a = p.agent
  if (p.via === 'web' && !(a && a.status === 'working')) return 'in the browser' // AI chats aren't shared from the web yet
  if (!a) return ''
  if (a.sharing === false) return 'AI sharing paused'
  if (a.status === 'unavailable') return `${esc(a.tool || 'AI')} feed unavailable`
  if (a.tool && a.status === 'working') return `<span class="working">${esc(a.tool)} working</span>`
  return p.via === 'web' ? 'in the browser' : a.tool ? `${esc(a.tool)} idle` : 'no AI activity yet'
}

function update () {
  if (!session || !$('#people')) return
  const st = session.status()
  $('#dot').className = `dot ${st.connected ? 'ok' : 'bad'}`
  $('#conn').textContent = st.connected ? ` · ${st.fileCount} files synced` : ' · reconnecting…'

  const me = { ...st.me }
  $('#people').innerHTML = [
    `<div class="person">${avatar(me)}<div><strong>${esc(me.name)}</strong> <span class="muted">(you) · ${esc(me.tool)}</span></div></div>`,
    ...st.peers.map((p) => `<div class="person">${avatar(p)}<div><strong>${esc(p.name)}</strong> <span class="muted">· ${esc(p.tool || '')}${p.kind === 'agent' ? ' · agent' : ''}</span>
      <div class="sub">${aiLine(p)}${p.focus ? ` · ${esc(p.focus)}` : ''}</div></div></div>`)
  ].join('') + (st.peers.length ? '' : `<p class="empty">Nobody else yet. <button class="linkish" id="inv2">Invite someone</button></p>`)
  paintAvatars($('#people'))
  $('#inv2')?.addEventListener('click', () => showInvite(false))

  const acts = st.activity.slice(-25).reverse()
  $('#activity').innerHTML = acts.length
    ? acts.map((a) => `<div class="act"><span class="kind ${esc(a.kind)}">${esc(a.kind)}</span> <code>${esc(a.path)}</code><div class="sub">${esc(a.by === st.me.name ? 'you' : a.by)} · ${esc(ago(a.ts))}</div></div>`).join('')
    : '<p class="empty">Changes to files show up here.</p>'

  const feed = st.feed.slice(-120)
  const feedEl = $('#feed')
  const nearBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 60
  feedEl.innerHTML = feed.length
    ? feed.map((e) => feedEntry(e)).join('')
    : '<p class="empty">When someone\'s AI (Claude Code or Cursor) works in this project, you\'ll see their prompts, its replies and what it changed, live.</p>'
  if (nearBottom) feedEl.scrollTop = feedEl.scrollHeight

  const chatEl = $('#chat')
  const chatBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60
  chatEl.innerHTML = st.chat.length
    ? st.chat.map((m) => `<div class="msg${m.by === st.me.name ? ' mine' : ''}"><div class="sub">${esc(m.by === st.me.name ? 'you' : m.by)} · ${esc(ago(m.ts))}</div>${esc(m.text)}${m.file ? ` <span class="muted">📎 ${esc(m.file.name)}</span>` : ''}</div>`).join('')
    : '<p class="empty">Say hi.</p>'
  if (chatBottom) chatEl.scrollTop = chatEl.scrollHeight
}

function feedEntry (e) {
  const who = `<span class="who">${esc(e.by)}${e.tool ? ` · ${esc(e.tool)}` : ''}</span>`
  if (e.kind === 'prompt') return `<div class="fe prompt">${who}<div class="bubble">${esc(e.text)}</div></div>`
  if (e.kind === 'reply') return `<div class="fe reply">${who}<div class="text${e.text.length > 600 ? ' long' : ''}">${esc(e.text)}</div></div>`
  if (e.kind === 'action') return `<div class="fe action"><span class="tick">›</span> ${esc(e.text)} <span class="muted">· ${esc(e.by)}</span></div>`
  if (e.kind === 'paused' || e.kind === 'resumed') return `<div class="fe note">${esc(e.by)} ${e.kind} sharing their AI chat</div>`
  return ''
}

// ---------------------------------------------------------------- route --

async function route () {
  if (session) return
  const conn = location.hash.length > 1 ? decodeInvite(location.hash) : null
  if (location.hash.length > 1 && !conn) {
    app.innerHTML = `<main class="home"><section class="card center"><h2>That invite link doesn't work</h2><p class="muted">It may have been cut off when it was copied. Ask for the link again.</p><a class="btn" href="/">Home</a></section></main>`
    return
  }
  if (conn) return renderJoin(conn)
  renderHome()
}

window.addEventListener('hashchange', () => { if (!session) route() })
window.addEventListener('beforeunload', (e) => { if (session) { e.preventDefault(); e.returnValue = '' } })
loadRelayInfo().then(route)
