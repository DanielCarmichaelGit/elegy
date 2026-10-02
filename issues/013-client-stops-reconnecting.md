# 013: The app stops reconnecting after a 429 or a proxy 502/503 (for example during a relay restart)

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** app/CLI from main (0.3.1), any relay behind a proxy

## What happens
If the upgrade request gets an HTTP answer that is not 101 and not one of the
"fatal" codes, the connection stays in `CONNECTING` forever. Nothing retries.
Fly's proxy answers 502/503 while the single relay machine restarts (every
deploy, and every crash in 009), so the app can be stranded until it is
restarted by hand. The same happens for 429 "Too many connections".

## What should happen
docs/hosting.md: "Clients reconnect on their own, and edits made during the
restart sync once it's back."

## What we know
- `src/connection.js:145-172`: the `unexpected-response` handler for 429 and
  the `else` branch only emit a warning. `ws` 8.x aborts the handshake only
  when nobody listens to `unexpected-response`; with a listener attached it
  does nothing more and never emits `close`, so the backoff loop in the
  `close` handler never runs.
- Reproduced with a fake proxy answering 503 once, relay reachable 0.5 s
  later: after 3.5 s `connected? false`, `readyState 0`. Same with
  `maxConnsPerIp: 1` and the slot freed after 0.3 s. Scripts:
  `scratchpad/relay/client-hang.mjs` from the audit.

## Next steps
1. In the non-fatal branches do what the 401 branch does: set `ws.retrying = true` and `req.destroy()` / `ws.terminate()` so `close` fires and the normal reconnect runs.
2. Test in `test/relay.test.js`: a 503 then a healthy relay must end in `connected`.

## Log
- 2026-10-01: found by the audit.
