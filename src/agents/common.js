export const MAX_ENTRY_CHARS = 8000

export function capText (text) {
  text = String(text ?? '')
  return text.length > MAX_ENTRY_CHARS ? text.slice(0, MAX_ENTRY_CHARS) + '…(truncated)' : text
}
