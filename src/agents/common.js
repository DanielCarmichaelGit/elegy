export const MAX_ENTRY_CHARS = 8000

export function capText (text) {
  text = String(text ?? '')
  return text.length > MAX_ENTRY_CHARS ? text.slice(0, MAX_ENTRY_CHARS) + '…(truncated)' : text
}

/** "claude-code" -> "Claude Code" etc., from the MCP client's name. */
export function toolLabel (client) {
  const n = String(client || '')
  if (/claude/i.test(n)) return 'Claude Code'
  if (/cursor/i.test(n)) return 'Cursor'
  if (/codex/i.test(n)) return 'Codex'
  if (/windsurf|codeium/i.test(n)) return 'Windsurf'
  if (/zed/i.test(n)) return 'Zed'
  return n || 'AI agent'
}
