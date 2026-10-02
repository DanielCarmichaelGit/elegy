# 021: Stored XSS in the chat panel through a peer-controlled message id

**Status:** **Fixed** (a95063c) · **Reported:** 2026-10-01 (audit) · **Seen on:** app UI from main (0.3.1), reproduced live with two clients on a local relay

## What happens
Chat messages are plain objects in the shared Yjs array; any room member can
push one with any `id`. `src/ui/session.js:993` builds the file-card link as
`href="/api/sessions/${current}/files/${m.id}?t=…"` without `esc()` or
`encodeURIComponent`. A message with
`id: 'zz" onmouseover="window.__xss=1" data-x="'` renders as an anchor with an
inline `onmouseover` handler; hovering it runs the script. There is no CSP
(`src/ui/index.html`), and the page holds the UI server's launch token in
`sessionStorage`, so injected script can call every local API: start a
session on any folder (and sync it to the relay), list any directory
(`GET /api/fs`), run "open in" (which launches the Claude CLI), git
commit/push/PR, shut the app down.

## What should happen
Peer data never reaches an attribute unescaped; ids that are not hex are
dropped before they reach the UI; a CSP blocks inline handlers as a second line.

## What we know
- Server route only matches `/files/([a-f0-9]+)`, but the client embeds the raw id.
- `src/session.js:1170` `messages()` only checks `m && m.id`.
- Every other peer-controlled string in the UI was found escaped (names, chat
  text, file names, focus, claims, feed, tree, git); this is the one miss.

## Next steps
1. `esc(encodeURIComponent(m.id))` in the href; in `messages()` drop entries whose `id` is not `/^[a-f0-9]{8,32}$/` or whose `by`/`to`/`text` are not strings.
2. Add a CSP via `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:">` in `index.html` (or `onHeadersReceived` in `desktop/main.js`).
3. A UI test that renders a hostile message and asserts no inline handler.

## Log
- 2026-10-01: found by the audit; live-confirmed (`window.__xss === 1`).
- 2026-10-02: fixed in a95063c: the file-card href is built by `fileCardHref()` in `src/ui/chat.js` (percent-encoded, then escaped), and the chat panel renders only messages passing `validMessage()` (id `/^[a-f0-9]{8,32}$/`, string `by`, string-or-absent `to`/`text`, well-typed `file`). The UI server now sends a CSP on the page (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`); home, settings, the dropdown, the sessions menu and the New session / Join / Shut down dialogs render with an empty console. Tests in test/ui.test.js ("a hostile chat message id never reaches the file link unescaped", "the app page carries a Content-Security-Policy that blocks inline script").
