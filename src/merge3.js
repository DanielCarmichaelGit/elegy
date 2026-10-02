// Three-way merge of text, line by line, the way git does it: changes to
// different lines combine on their own; the same lines changed on both sides
// are a conflict. Used when someone comes back to a session after editing
// offline (base: what they last had; ours: their disk; theirs: the session).
import { diff3Merge } from 'node-diff3'

export const MARK = { start: '<<<<<<< mine', mid: '=======', end: '>>>>>>> session' }

const lines = (s) => s.split('\n')

/**
 * Merges ours and theirs against base. `conflicts` is empty when the merge
 * is clean; `text` then holds the merged file. With conflicts, `text` holds
 * the merge with ours taken for each conflicted region (callers decide what
 * to do with it; see withMarkers).
 */
export function merge3 (base, ours, theirs) {
  const regions = diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true })
  const out = []
  const conflicts = []
  for (const r of regions) {
    if (r.ok) { out.push(...r.ok); continue }
    const c = r.conflict
    conflicts.push({ base: c.o, ours: c.a, theirs: c.b })
    out.push(...c.a)
  }
  return { text: out.join('\n'), conflicts }
}

/** The merge written out with git-style markers around each conflict, labelled with people's names. */
export function withMarkers (base, ours, theirs, names) {
  const regions = diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true })
  const out = []
  for (const r of regions) {
    if (r.ok) { out.push(...r.ok); continue }
    out.push(`${MARK.start} (${names.mine})`, ...r.conflict.a, MARK.mid, ...r.conflict.b, `${MARK.end} (${names.theirs})`)
  }
  return out.join('\n')
}

/** True when the text still holds markers that withMarkers put there. */
export function hasMarkers (text) {
  return typeof text === 'string' && text.split('\n').some((l) => l.startsWith(`${MARK.start} (`) || l.startsWith(`${MARK.end} (`))
}
