# 011: Room secrets, the relay key and passes travel in the WebSocket URL and end up in proxy logs

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** relay.heyquilt.com via Fly's proxy logs

## What happens
`src/connection.js:50-55` puts `secret`, `relayKey`, `viewSecret` and (with
sign-in on) `pass` in the query string of the upgrade request. When Fly's edge
proxy fails to reach the machine (during the crash in 009) it logs the full
URL. The log for 2026-10-01T03:38:49Z contains a real room's `secret=…`,
`viewSecret=…` and the relay key `relayKey=…` in plaintext, readable by anyone
with Fly log access and kept for Fly's retention period.

## What should happen
Secrets never appear in URLs. They go in headers (the HTTP endpoints already
use `x-quilt-secret` / `x-quilt-key`) or in the first message after the
upgrade, and the relay closes the socket if that message does not arrive.

## What we know
- Browsers never send the `#secret` of an invite link, but the app does send
  the room secret as `?secret=` on every connect and reconnect.
- The relay key that leaked is still the one set on the Fly app.

## Next steps
1. Rotate `COWOVE_RELAY_KEY` now (or unset it once 010 is done) and consider
   the room from the log (`room-3fce2917`) compromised: end it or rotate its secret.
2. Move secret, viewSecret, pass and relayKey to request headers in
   `src/connection.js` and read them from `req.headers` in `src/server.js`'s
   upgrade handler (keep query fallback one release for old clients, then drop it).
3. Make the relay's own logging never print request URLs.

## Log
- 2026-10-01: found by the audit.
