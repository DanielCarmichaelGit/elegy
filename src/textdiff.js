// Turning a whole-file rewrite into small CRDT edits, so concurrent changes
// to different parts of a file both survive. Shared by the CLI and web app.
import diff from 'fast-diff'

/** Applies the minimal set of inserts/deletes to turn ytext into `next`. Returns "+added -removed" lines. */
export function applyTextDiff (ytext, next) {
  const prev = ytext.toString()
  if (prev === next) return ''
  let pos = 0; let added = 0; let removed = 0
  for (const [op, str] of diff(prev, next)) {
    if (op === diff.EQUAL) pos += str.length
    else if (op === diff.DELETE) { ytext.delete(pos, str.length); removed += countLines(str) } else { ytext.insert(pos, str); pos += str.length; added += countLines(str) }
  }
  return `+${added} -${removed}`
}

function countLines (s) {
  const n = s.split('\n').length - 1
  return n || 1
}
