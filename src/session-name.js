// Session names: the owner's app names a session after its folder, and the owner can
// rename it. The relay and the accounts API both check names with this.
export const SESSION_NAME_MAX = 80
// C0 and C1 control characters, including newlines and tabs.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** The name trimmed, or null unless it is 1 to 80 characters with no control characters. */
export function cleanSessionName (value) {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || [...name].length > SESSION_NAME_MAX || CONTROL.test(name)) return null
  return name
}

export const BAD_SESSION_NAME = 'Give the session a name of 1 to 80 characters.'
