// Pure, no React, so it can be unit-tested directly: which option a key moves to in a listbox.

/** The new active index after `key`, or null when the key doesn't move. Arrows stop at the ends. */
export function moveIndex (key, index, length) {
  if (!length) return null
  const last = length - 1
  const from = Math.min(Math.max(index, 0), last)
  if (key === 'ArrowDown') return Math.min(from + 1, last)
  if (key === 'ArrowUp') return Math.max(from - 1, 0)
  if (key === 'Home' || key === 'PageUp') return 0
  if (key === 'End' || key === 'PageDown') return last
  return null
}
