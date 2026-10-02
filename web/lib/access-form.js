// Pure helpers for the Access types page, no Next imports, so they're unit-tested directly.

/** A type's fields from its form: folders one per line ("All folders" when empty), the switch for posting. */
export function typeFromForm (formData) {
  const folders = String(formData.get('folders') || '').split('\n').map((f) => f.trim()).filter(Boolean)
  return {
    name: String(formData.get('name') || '').trim(),
    files: formData.get('files') === 'view' ? 'view' : 'edit',
    folders,
    talk: formData.get('talk') === 'on'
  }
}

/** Folders as the form's text: one per line. */
export const foldersText = (folders) => (folders || []).join('\n')

/** "Can edit · src, docs · may post": a type at a glance. */
export function describeType (t) {
  const parts = [t.files === 'view' ? 'View only' : 'Can edit']
  if (t.files !== 'view') parts.push(t.folders && t.folders.length ? t.folders.join(', ') : 'all folders')
  parts.push(t.talk === false ? 'no posting' : 'may post')
  return parts.join(' · ')
}
