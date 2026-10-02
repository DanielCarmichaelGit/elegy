// What someone may do in a session: the access types people define, the grants that
// give someone a type in one session (narrowed, never widened), and the access that
// works out to. Pure and shared: the accounts API works access out and signs it into
// passes, the relay enforces it, and the app shows it.
//
// Two shapes:
// - access, as the API and passes carry it: { files: 'edit'|'view', folders, foldersExcept, talk }
//   (empty folders means every folder);
// - relay access, as the relay and the app have always kept members: { role: 'editor'|'viewer',
//   scopes, scopesExcept, talk }.
import { globMatcher } from './pathrules.js'

export const BUILTIN_TYPES = Object.freeze([
  Object.freeze({ id: 'builtin:edit', name: 'Can edit', files: 'edit', folders: Object.freeze([]), talk: true, builtin: true }),
  Object.freeze({ id: 'builtin:view', name: 'View only', files: 'view', folders: Object.freeze([]), talk: true, builtin: true })
])
export const DEFAULT_TYPE = 'builtin:edit'
// Where grants go when their type is deleted: the safe default.
export const FALLBACK_TYPE = 'builtin:view'
export const MAX_TYPES = 50
export const MAX_FOLDERS = 20
export const MAX_FOLDER_LENGTH = 200
export const TYPE_NAME_MAX = 40
export const TALK_REFUSED = "You can't post in this session."
export const BAD_FOLDER = 'Folders must be paths inside the project, like src or docs.'
export const TOO_MANY_FOLDERS = 'An access type can list at most 20 folders.'

// Control and format characters (zero-width, bidi overrides) never belong in a name or a folder.
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu

export const builtinType = (id) => BUILTIN_TYPES.find((t) => t.id === id) || null

/** Folders as the relay checks them: trimmed, no leading "./" or trailing "/", each once. Throws BAD_FOLDER or TOO_MANY_FOLDERS. */
export function cleanFolders (input) {
  if (input == null) return []
  if (!Array.isArray(input)) throw new Error(BAD_FOLDER)
  const out = []
  for (const raw of input) {
    if (typeof raw !== 'string') throw new Error(BAD_FOLDER)
    const s = raw.replace(INVISIBLE, '').trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '')
    if (!s) continue
    if (s.startsWith('/') || s.includes('\\') || s.length > MAX_FOLDER_LENGTH || /^[A-Za-z]:/.test(s)) throw new Error(BAD_FOLDER)
    if (s.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw new Error(BAD_FOLDER)
    if (!out.includes(s)) out.push(s)
  }
  if (out.length > MAX_FOLDERS) throw new Error(TOO_MANY_FOLDERS)
  return out
}

/** A type's name, trimmed: 1 to 40 characters with nothing invisible. Throws otherwise. */
export function cleanTypeName (value) {
  const name = [...String(value ?? '').replace(INVISIBLE, '').trim()]
  if (!name.length || name.length > TYPE_NAME_MAX) throw new Error('Give the access type a name of 1 to 40 characters.')
  return name.join('')
}

/** A new or changed access type's fields, checked. `partial` keeps fields that weren't sent out of the result. */
export function cleanTypeFields (body, { partial = false } = {}) {
  const b = body || {}
  const out = {}
  if (!partial || b.name !== undefined) out.name = cleanTypeName(b.name)
  if (!partial || b.files !== undefined) {
    if (b.files !== 'edit' && b.files !== 'view') throw new Error('files must be edit or view.')
    out.files = b.files
  }
  if (!partial || b.folders !== undefined) out.folders = cleanFolders(b.folders ?? [])
  if (!partial || b.talk !== undefined) {
    if (b.talk !== undefined && typeof b.talk !== 'boolean') throw new Error('talk must be true or false.')
    out.talk = b.talk !== false
  }
  return out
}

/** How a grant narrows its type: { files?: 'view', foldersRemove?: [...], talk?: false }. Anything else is dropped. */
export function cleanTighten (raw) {
  const t = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  if (t.files === 'view') out.files = 'view'
  const remove = cleanFolders(t.foldersRemove ?? [])
  if (remove.length) out.foldersRemove = remove
  if (t.talk === false) out.talk = false
  return out
}

/**
 * What a grant comes to: its type, narrowed. A type limited to folders loses the ones
 * removed; removing from "all folders" (or a folder the type doesn't list) is kept as
 * foldersExcept. Removing every folder a limited type has leaves nothing to change: view.
 */
export function effectiveAccess (type, tighten = {}) {
  const t = tighten || {}
  const typeFolders = type.folders || []
  const removed = t.foldersRemove || []
  let files = type.files === 'view' || t.files === 'view' ? 'view' : 'edit'
  let folders = typeFolders.filter((f) => !removed.includes(f))
  let foldersExcept = removed.filter((f) => !typeFolders.includes(f))
  if (typeFolders.length && !folders.length) { files = 'view'; folders = []; foldersExcept = [] }
  return { files, folders, foldersExcept, talk: type.talk !== false && t.talk !== false }
}

const inside = (rel, folder) => globMatcher(folder)(rel)

/**
 * What both allow. The relay uses it so an owner's live change can only narrow what a
 * person's pass allows. Folders: those of one that lie inside the other's; none left
 * means nothing to change (view). Exceptions and "no posting" add up.
 */
export function narrowAccess (a, b) {
  let files = a.files === 'view' || b.files === 'view' ? 'view' : 'edit'
  const fa = a.folders || []
  const fb = b.folders || []
  let folders
  if (!fa.length) folders = [...fb]
  else if (!fb.length) folders = [...fa]
  else {
    folders = [...new Set([...fa.filter((x) => fb.some((y) => inside(x, y))), ...fb.filter((y) => fa.some((x) => inside(y, x)))])]
    if (!folders.length) files = 'view'
  }
  const foldersExcept = [...new Set([...(a.foldersExcept || []), ...(b.foldersExcept || [])])]
  return { files, folders, foldersExcept, talk: a.talk !== false && b.talk !== false }
}

/** Access from anywhere it isn't trusted to be well formed (a pass, an owner's request): checked, or null. */
export function cleanAccess (raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.files !== 'edit' && raw.files !== 'view') return null
  try {
    return { files: raw.files, folders: cleanFolders(raw.folders ?? []), foldersExcept: cleanFolders(raw.foldersExcept ?? []), talk: raw.talk !== false }
  } catch { return null }
}

/** The relay's shape: { role, scopes, scopesExcept, talk }. */
export function relayAccess (access) {
  return { role: access.files === 'view' ? 'viewer' : 'editor', scopes: [...(access.folders || [])], scopesExcept: [...(access.foldersExcept || [])], talk: access.talk !== false }
}

/** Back from the relay's shape (a member saved before access types has no exceptions and may talk). */
export function fromRelay (m) {
  return { files: m.role === 'viewer' ? 'view' : 'edit', folders: [...(m.scopes || [])], foldersExcept: [...(m.scopesExcept || [])], talk: m.talk !== false }
}

/** May someone with this relay access change `rel`? */
export function mayChange (a, rel) {
  if (!a || a.role === 'viewer') return false
  if (a.scopes && a.scopes.length && !a.scopes.some((s) => inside(rel, s))) return false
  return !(a.scopesExcept || []).some((s) => inside(rel, s))
}

/** Why someone with this relay access may not change `rel`, in words, or null. */
export function changeRefusal (a, rel) {
  if (!a || a.role === 'viewer') return 'you can only view this session'
  if (a.scopes && a.scopes.length && !a.scopes.some((s) => inside(rel, s))) return `you may only change files in ${a.scopes.join(', ')}`
  const except = (a.scopesExcept || []).find((s) => inside(rel, s))
  return except ? `you may not change files in ${except}` : null
}

/** Same access? (Folder order doesn't matter.) */
export function sameAccess (a, b) {
  const set = (x) => [...(x || [])].sort().join('\n')
  return a.files === b.files && set(a.folders) === set(b.folders) && set(a.foldersExcept) === set(b.foldersExcept) && (a.talk !== false) === (b.talk !== false)
}

/** "Can edit · src, docs · except src/secrets · no posting": one line for menus and lists. */
export function describeAccess (a) {
  const parts = [a.files === 'view' ? 'View only' : 'Can edit']
  if (a.files !== 'view') parts.push(a.folders && a.folders.length ? a.folders.join(', ') : 'all folders')
  if (a.files !== 'view' && a.foldersExcept && a.foldersExcept.length) parts.push(`except ${a.foldersExcept.join(', ')}`)
  if (a.talk === false) parts.push('no posting')
  return parts.join(' · ')
}
