// Invite codes, readable by both the web app and the CLI: base64url JSON
// { s: relay address, r: room, k: room secret }. An invite link is the site's
// address with the code after "#", so the secret never reaches the server.
export function encodeInvite ({ server, room, secret }) {
  return b64url(new TextEncoder().encode(JSON.stringify({ s: server, r: room, k: secret })))
}

export function decodeInvite (text) {
  let code = String(text || '').trim()
  if (code.includes('#')) code = code.slice(code.indexOf('#') + 1)
  code = code.replace(/^cowove join\s+/, '').replace(/^join=/, '')
  try {
    const j = JSON.parse(new TextDecoder().decode(unb64url(code)))
    if (j && j.s && j.r) return { server: j.s, room: j.r, secret: j.k || '' }
  } catch {}
  return null
}

export function inviteLink (origin, conn) {
  return `${origin.replace(/\/+$/, '')}/#${encodeInvite(conn)}`
}

export function newRoom (server) {
  const rnd = (n) => b64url(globalThis.crypto.getRandomValues(new Uint8Array(n)))
  const hex = [...globalThis.crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')
  return { server, room: `room-${hex}`, secret: rnd(18) }
}

function b64url (bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url (s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
