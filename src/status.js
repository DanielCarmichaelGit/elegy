// Renders a session status snapshot as Markdown. Used for .elegy/STATUS.md,
// `elegy status`, and the MCP `elegy_status` tool, so every tool sees the same view.

const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export function renderStatus (st) {
  const out = []
  out.push(`# Elegy pair session: room \`${st.room}\``)
  out.push('')
  out.push(`Relay: ${st.connected ? 'connected' : '**disconnected** (edits are kept and will sync on reconnect)'} · ${st.fileCount} shared files`)
  out.push(`You: **${st.me.name}** (${st.me.tool})${st.me.focus ? ` · focus: ${st.me.focus}` : ''}`)
  out.push('')

  out.push('## Partners online')
  if (!st.peers.length) out.push('_Nobody else is connected right now._')
  for (const p of st.peers) {
    const tools = [p.tool, ...(p.agents || [])].filter((t) => t && t !== 'unknown')
    out.push(`- **${p.name}**${tools.length ? ` (${[...new Set(tools)].join(', ')})` : ''}${p.focus ? `: working on: ${p.focus}` : ''}`)
    const editing = p.editing.slice(0, 8)
    if (editing.length) out.push(`  - recently edited: ${editing.map((e) => `\`${e.path}\` (${e.secondsAgo}s ago)`).join(', ')}`)
  }
  out.push('')

  out.push('## Claimed files')
  if (!st.claims.length) out.push('_No claims._')
  for (const c of st.claims) {
    const who = c.by === st.me.name ? 'you' : c.by
    out.push(`- \`${c.pattern}\`: ${who}${c.note ? `: ${c.note}` : ''} (${ago(c.ts)})`)
  }
  out.push('')

  out.push('## Recent activity')
  const act = st.activity.slice(-15).reverse()
  if (!act.length) out.push('_Nothing yet._')
  for (const a of act) {
    const who = a.by === st.me.name ? 'you' : a.by
    out.push(`- ${ago(a.ts)}: ${who} ${a.kind} \`${a.path}\`${a.detail ? ` (${a.detail})` : ''}`)
  }
  out.push('')

  out.push('## Messages')
  if (!st.chat.length) out.push('_No messages._')
  for (const m of st.chat.slice(-10)) out.push(`- ${ago(m.ts)} **${m.by === st.me.name ? 'you' : m.by}:** ${m.text}`)
  out.push('')
  return out.join('\n')
}
