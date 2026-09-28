// Shared state and helpers for the cowove app (native ES modules, no build step).

// ---------------------------------------------------------------- token --
const params = new URLSearchParams(location.search)
if (params.get('t')) {
  try { sessionStorage.setItem('cowove-token', params.get('t')) } catch {}
  history.replaceState(null, '', '/')
}
export let TOKEN = params.get('t')
try { TOKEN = TOKEN || sessionStorage.getItem('cowove-token') } catch {}

// ---------------------------------------------------------------- icons --
export const I = {
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></svg>',
  bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M9 14h.01M15 14h.01"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></svg>',
  tree: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h6M3 12h18M3 19h18M13 5h8"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>'
}

export const TOOLS = ['Claude Code', 'Cursor', 'Codex', 'Windsurf', 'GitHub Copilot', 'Zed', 'Aider', 'Other']

// ---------------------------------------------------------------- state --
export const state = {
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
  error: null,
  feeds: new Map(), // session id -> Map(person -> entries[])
  trees: new Map(), // session id -> { files, claims }
  files: new Map(), // `${id}\n${path}` -> file contents from /file
  ws: new Map() // session id -> workspace layout (mode, tabs, expanded folders)
}

// -------------------------------------------------------------- helpers --
export const $ = (sel, root = document) => root.querySelector(sel)
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const basename = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p
export const bytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
export const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return new Date(ts).toLocaleDateString()
}
export const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
export const PALETTE = ['#e06c75', '#5b8def', '#3fae6b', '#b267e6', '#d8a23a', '#2fb3c4', '#e0864f']
export const colorFor = (name, given) => given || PALETTE[Math.abs([...String(name)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)) % PALETTE.length]
export const avatar = (name, color, online = false) =>
  `<div class="avatar${online ? ' online' : ''}" style="background:${esc(colorFor(name, color))}">${esc(String(name || '?').slice(0, 1))}</div>`

export function toast (msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400)
}

export async function api (method, path, body, headers = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'x-cowove-token': TOKEN || '', ...(body && !(body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

export function decodeInvite (code) {
  try {
    const raw = code.trim().replace(/^cowove join\s+/, '')
    const j = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')))
    return j && j.s && j.r ? { server: j.s, room: j.r } : null
  } catch { return null }
}

export function remember (key, value) { try { localStorage.setItem(`cowove-${key}`, value) } catch {} }
export function recall (key, fallback = '') { try { return localStorage.getItem(`cowove-${key}`) ?? fallback } catch { return fallback } }

/** Tools someone is using, for badges. */
export const toolsOf = (p) => [...new Set([p.tool, ...(p.agents || [])].filter((t) => t && t !== 'unknown'))]

