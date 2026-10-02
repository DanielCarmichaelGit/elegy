// The owner's Access section (people menu): what each person's form shows, and what Save
// sends. Pure functions only, so they load in the browser and in tests. The form only ever
// saves from grants it loaded: a default type saved over a real grant could widen access.

export const LOADING_ACCESS = 'Loading access…'

/** This session's grants: loading, loaded (a Map by account) or failed. */
export const grantsLoading = () => ({ state: 'loading', grants: new Map() })
export const grantsLoaded = (list) => ({ state: 'ready', grants: new Map((list || []).map((g) => [g.account, g])) })
export const grantsFailed = (err) => ({ state: 'error', grants: new Map(), error: err?.message || String(err) })

/** What one person's form shows: a message while loading or after a failure, else the values. */
export function accessFormValues (load, m) {
  if (load.state === 'loading') return { state: 'loading', message: LOADING_ACCESS }
  if (load.state !== 'ready') return { state: 'error', message: `Couldn't load their access: ${load.error}` }
  const g = load.grants.get(m.key)
  const t = g?.tighten || {}
  return {
    state: 'ready',
    // No grant (let in before access types, or the API refused it): what the relay has.
    typeId: g?.typeId || (m.role === 'viewer' ? 'builtin:view' : 'builtin:edit'),
    viewOnly: t.files === 'view',
    noTalk: t.talk === false,
    foldersRemove: (t.foldersRemove || []).join(', ')
  }
}

/**
 * The body for POST /members/access, or null when there's nothing safe to send: the grants
 * or the owner's types haven't loaded, or the form names a type the owner doesn't have.
 */
export function accessSaveBody (load, types, key, form) {
  if (load.state !== 'ready' || !Array.isArray(types)) return null
  if (!types.some((t) => t.id === form.typeId)) return null
  const foldersRemove = String(form.foldersRemove || '').split(',').map((x) => x.trim()).filter(Boolean)
  return { key, typeId: form.typeId, tighten: { ...(form.viewOnly ? { files: 'view' } : {}), ...(form.noTalk ? { talk: false } : {}), foldersRemove } }
}
