// Inline SVG marks for AI coding tools shown in the partner feed (conversation
// chips and AI reply badges). Names match profile/tool strings in TOOLS.
// Browser-free so unit tests can import it from Node.

function esc (s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/** Accessible display name for a tool string (empty → "AI"). */
export function toolLabel (tool) {
  const t = String(tool || '').trim()
  return t || 'AI'
}

// Compact monochrome marks (currentColor). Distinct enough to tell tools apart
// at ~14px; not official brand assets.
const svg = (paths, view = '0 0 24 24') =>
  `<svg class="tool-mark" viewBox="${view}" width="16" height="16" aria-hidden="true" focusable="false">${paths}</svg>`

const ICONS = {
  'Claude Code': svg(
    // Anthropic-ish starburst (four diamond petals)
    '<path fill="currentColor" d="M12 2.2 13.8 8.2 19.8 10 13.8 11.8 12 17.8 10.2 11.8 4.2 10 10.2 8.2z"/>' +
    '<path fill="currentColor" d="M18.5 15.2 19.3 17.6 21.7 18.4 19.3 19.2 18.5 21.6 17.7 19.2 15.3 18.4 17.7 17.6z"/>'
  ),
  Cursor: svg(
    // Stylized cursor / pointer wedge
    '<path fill="currentColor" d="M5 3.5 19.5 12 12.2 13.6 9.8 20.5z"/>'
  ),
  Codex: svg(
    // OpenAI-ish blossom (six petals around a hub)
    '<circle cx="12" cy="12" r="2.2" fill="currentColor"/>' +
    '<g fill="currentColor">' +
    '<ellipse cx="12" cy="5.2" rx="2" ry="3.2"/>' +
    '<ellipse cx="12" cy="18.8" rx="2" ry="3.2"/>' +
    '<ellipse cx="5.2" cy="12" rx="3.2" ry="2"/>' +
    '<ellipse cx="18.8" cy="12" rx="3.2" ry="2"/>' +
    '<ellipse cx="7.2" cy="7.2" rx="2.2" ry="3" transform="rotate(-45 7.2 7.2)"/>' +
    '<ellipse cx="16.8" cy="16.8" rx="2.2" ry="3" transform="rotate(-45 16.8 16.8)"/>' +
    '</g>'
  ),
  Windsurf: svg(
    // Wave / surf lines
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M3 14c2.5-3 5-4.5 9-4.5S18.5 11 21 14"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M3 18c2.5-3 5-4.5 9-4.5S18.5 15 21 18"/>' +
    '<path fill="currentColor" d="M14 4.5 17.5 11H10.5z"/>'
  ),
  'GitHub Copilot': svg(
    // Copilot-ish twin nodes + link (no octocat)
    '<circle cx="8" cy="10" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<circle cx="16" cy="14" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M10.4 11.6 13.6 12.4"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M7 6.5V5M9.5 7.2 10.5 5.8M6.5 7.2 5.5 5.8"/>'
  ),
  Zed: svg(
    // Bold Z
    '<path fill="currentColor" d="M6 5h12l-9 7H18v2H6l9-7H6z"/>'
  ),
  Aider: svg(
    // Terminal prompt
    '<rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="m7 10 3 2-3 2M12 14h5"/>'
  ),
  Other: null // use generic
}

const GENERIC = svg(
  // Same sparkle family as the old text badge mark
  '<path fill="currentColor" d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9z"/>' +
  '<path fill="currentColor" d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'
)

const ALIASES = {
  claude: 'Claude Code',
  'claude code': 'Claude Code',
  'claude-code': 'Claude Code',
  anthropic: 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
  openai: 'Codex',
  windsurf: 'Windsurf',
  codeium: 'Windsurf',
  copilot: 'GitHub Copilot',
  'github copilot': 'GitHub Copilot',
  'vs code': 'GitHub Copilot',
  vscode: 'GitHub Copilot',
  zed: 'Zed',
  aider: 'Aider',
  other: 'Other'
}

/** Canonical TOOLS key for a free-form tool string, or null if unknown. */
export function resolveToolKey (tool) {
  const raw = String(tool || '').trim()
  if (!raw) return null
  if (Object.prototype.hasOwnProperty.call(ICONS, raw)) return raw
  const lower = raw.toLowerCase()
  if (ALIASES[lower]) return ALIASES[lower]
  for (const key of Object.keys(ICONS)) {
    if (key.toLowerCase() === lower) return key
  }
  return null
}

/**
 * HTML for a provider logo. Uses title + aria-label for the tool name so the
 * visible string can be dropped from chips/badges. Unknown tools get a generic
 * AI mark (still labeled with the original name when provided).
 */
export function toolLogo (tool, { className = 'tool-logo' } = {}) {
  const label = toolLabel(tool)
  const key = resolveToolKey(tool)
  const mark = (key && ICONS[key]) || GENERIC
  const cls = className ? ` class="${esc(className)}"` : ''
  return `<span${cls} title="${esc(label)}" aria-label="${esc(label)}">${mark}</span>`
}
