// Chat messages come from the shared room, so every field is peer-controlled.
// Pure helpers (no DOM) so the UI's handling of them can be tested in node.

// Message ids are made locally from random bytes (src/session.js); nothing else is ours.
export const MESSAGE_ID = /^[a-f0-9]{8,32}$/

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const optionalString = (v) => v == null || typeof v === 'string'

/** True when a message from the room has the shape the UI renders; anything else is dropped. */
export function validMessage (m) {
  if (!m || typeof m !== 'object') return false
  if (typeof m.id !== 'string' || !MESSAGE_ID.test(m.id)) return false
  if (typeof m.by !== 'string' || !optionalString(m.to) || !optionalString(m.text)) return false
  if (m.file != null && (typeof m.file !== 'object' || typeof m.file.name !== 'string' || typeof m.file.size !== 'number')) return false
  return true
}

/** The messages of a session the UI will render, in order. */
export const renderable = (list) => (Array.isArray(list) ? list : []).filter(validMessage)

/** The link that downloads the file a message carries, from the local UI server. Safe in an attribute. */
export function fileCardHref (session, id, token) {
  return esc(`/api/sessions/${encodeURIComponent(session)}/files/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`)
}
