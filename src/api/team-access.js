// What a team membership grants: editor or viewer, and for agents, optional
// folders (the relay's scope rules: up to 20 relative path prefixes).
import { HttpError, stripInvisible } from './http.js'

export const ACCESS = ['editor', 'viewer']
export const MAX_SCOPES = 20
export const MAX_SCOPE_LENGTH = 200
const BAD_FOLDER = 'Folders must be paths inside the project, like src or docs.'

export function accessOf (v) {
  if (!ACCESS.includes(v)) throw new HttpError(400, 'access must be editor or viewer')
  return v
}

/** Folders as the relay wants them: trimmed, no leading "./" or trailing "/", each once. */
export function cleanScopes (input) {
  if (!Array.isArray(input)) throw new HttpError(400, BAD_FOLDER)
  const out = []
  for (const raw of input) {
    if (typeof raw !== 'string') throw new HttpError(400, BAD_FOLDER)
    const s = stripInvisible(raw).join('').trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '')
    if (!s) continue
    if (s.startsWith('/') || s.includes('\\') || s.length > MAX_SCOPE_LENGTH || /^[A-Za-z]:/.test(s)) throw new HttpError(400, BAD_FOLDER)
    // Every segment must be a real folder name: no "", ".", or ".." anywhere in the path.
    if (s.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw new HttpError(400, BAD_FOLDER)
    if (!out.includes(s)) out.push(s)
  }
  if (out.length > MAX_SCOPES) throw new HttpError(400, 'An agent can be limited to at most 20 folders.')
  return out
}
