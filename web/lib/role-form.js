// Pure: reads the role grid's checkboxes (named g.<resource>.<op>) from a submitted form.
import { RESOURCES, normalizeGrants } from './permissions.js'

export function grantsFromForm (formData) {
  const raw = {}
  for (const [key, value] of formData.entries()) {
    const m = /^g\.([a-z_]+)\.([crud])$/.exec(key)
    // Only known rows, so a crafted field name can't touch Object.prototype.
    if (m && value === 'on' && RESOURCES.includes(m[1])) (raw[m[1]] ||= {})[m[2]] = true
  }
  return normalizeGrants(raw)
}
