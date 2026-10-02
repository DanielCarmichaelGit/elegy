// Which agent conversations a feed holds, and which one to show. Pure, so it
// can be tested without a browser.
const LABEL_CHARS = 48

/**
 * The conversations in a feed, newest activity first:
 * [{ conv, tool, label, ts, count }]. Named after the first prompt, or the
 * tool when there is none. Entries without a conversation id share one bucket.
 */
export function conversations (entries) {
  const byConv = new Map()
  for (const e of entries) {
    if (!e || e.kind === 'paused' || e.kind === 'resumed') continue
    const conv = e.conv || ''
    let c = byConv.get(conv)
    if (!c) { c = { conv, tool: e.tool || null, label: null, ts: e.ts || 0, count: 0 }; byConv.set(conv, c) }
    if (e.kind === 'prompt' && c.label === null && e.text) c.label = shortLabel(e.text)
    if (!c.tool && e.tool) c.tool = e.tool
    if ((e.ts || 0) > c.ts) c.ts = e.ts
    c.count++
  }
  return [...byConv.values()]
    .map((c) => ({ ...c, label: c.label || c.tool || 'Conversation' }))
    .sort((a, b) => b.ts - a.ts)
}

function shortLabel (text) {
  const line = String(text).split('\n').map((l) => l.trim()).find(Boolean) || ''
  return line.length > LABEL_CHARS ? line.slice(0, LABEL_CHARS) + '…' : line
}

/** The conversation to show: the pinned one if it still exists, else the newest. */
export function pickConversation (list, pinned) {
  if (!list.length) return null
  if (pinned !== undefined && list.some((c) => c.conv === pinned)) return pinned
  return list[0].conv
}
