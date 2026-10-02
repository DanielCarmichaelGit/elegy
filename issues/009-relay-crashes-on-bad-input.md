# 009: Any client can crash the relay with one request (two ways)

**Status:** **Fixed** (4637800) · **Reported:** 2026-10-01 (audit) · **Seen on:** relay.heyquilt.com (crashed in production 2026-10-01 04:52 UTC), reproduced locally on main (98eb68b)

## What happens
The relay process exits, every session drops, and Fly restarts it about five
seconds later. Both triggers need no account, pass, relay key or room secret.

1. **A WebSocket upgrade with a bad %-escape.** `GET /%E0%A4%A` with
   `Upgrade: websocket` headers. `decodeURIComponent` throws `URIError` inside
   the `upgrade` listener and nothing catches it.
2. **Any socket error on a connected client.** The relay never attaches
   `ws.on('error')`, so a frame bigger than `maxPayload` (32 MB on the current
   config), or a connection reset mid-frame, becomes an unhandled `'error'`
   event and kills the process. This is what happened in production today.

## What should happen
Bad input closes that one connection with a 4xx or a WebSocket close code.
The process never exits because of something a client sent.

## What we know
- `src/server.js:985`: `const name = decodeURIComponent(url.pathname.slice(1))`
  runs before any check, outside a try/catch.
- `src/server.js:1023-1036`: `handleUpgrade` attaches `'pong'` and `'close'`
  only. `grep "on('error'" src/server.js` finds handlers only on file
  upload/download streams.
- Reproduced (1) locally: healthz 200 → relay gone, stack trace ends in
  `onParserExecute (node:_http_server)`.
- Production log (`fly logs --app cowove-relay`), 2026-10-01T04:52:50Z:
  `RangeError: Max payload size exceeded` / `Emitted 'error' event on WebSocket
  instance` / `Receiver.receiverOnError (/app/node_modules/ws/lib/websocket.js:1232)`,
  then the health check failed and the machine restarted at 04:52:55Z.
- No `process.on('uncaughtException')` guard exists in `src/server.js` or `bin/quilt.js`.

## Likely causes
Exactly the two code paths above.

## Next steps
1. Wrap the URL parsing in the `upgrade` handler in try/catch and `reject(socket, 400, 'Bad request')`.
2. In `handleUpgrade`, add `ws.on('error', () => ws.terminate())`.
3. Add a process-level `uncaughtException`/`unhandledRejection` handler that logs and keeps serving, so the next unexpected throw does not drop every session.
4. Add a regression test in `test/relay.test.js` for both inputs.
5. Deploy (`fly deploy`), then re-run the two probes against relay.heyquilt.com.

## Log
- 2026-10-01: found by the audit; (1) reproduced locally, (2) confirmed from the production log.
- 2026-10-01: fixed in 4637800 (400 on a bad path, 'error' listener on every relay socket, `quilt serve` logs unexpected errors instead of exiting; tests in test/relay.test.js). Deployed; probing relay.heyquilt.com with the bad path now answers `400 Bad room name` and healthz stays 200.
