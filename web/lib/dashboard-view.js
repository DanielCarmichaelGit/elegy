// Pure helpers for the personal dashboard, so they can be unit-tested directly.

/** "1 computer linked", "3 computers linked", the empty text for 0, or a gentle fallback when unknown. */
export function countLabel (n, one, many, none) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 'Couldn’t count these right now.'
  if (n === 0) return none
  return `${n} ${n === 1 ? one : many}`
}
