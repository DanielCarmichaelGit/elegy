# 022: A peer's presence colour is injected into inline CSS and can cover the whole window

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** app UI from main, reproduced live

## What happens
`avatar()` in `src/ui/common.js:89-90` writes
`style="background:${esc(colorFor(name, color))}"`. `esc()` only escapes
quotes and angle brackets, so `;`, `(` and `)` pass. A peer whose awareness
colour is `red;position:fixed;inset:0;z-index:9999;width:100vw;height:100vh`
turns every one of their avatars into a full-window red layer that hides the
people menu, file view and chat. `url(http://…)` would also load a tracking
image per viewer (no CSP). Your own colour is checked by `COLOR_RE` in
`src/ui-server.js:23`; peers' colours (`src/session.js:1426`) never are.

## What should happen
Only `#rrggbb` is accepted; anything else falls back to the palette colour.

## Next steps
1. `colorFor`: return `given` only if `/^#[0-9a-f]{6}$/i.test(given)`.
2. Validate in `status()` (`src/session.js:1426`) too, so the CLI and MCP never see junk.

## Log
- 2026-10-01: found by the audit; screenshots at 1280x800 and 900x600 fully red.
