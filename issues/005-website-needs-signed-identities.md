# 005: The website and the relay-hosted AI tools can't join sessions since identities became signed

**Status:** Won't fix (the browser version of the app was shelved on 2026-09-28; the relay-hosted AI part moves to the agents work in [002](002-cloud-sessions-dont-share.md)) · **Reported:** 2026-09-28 · **Seen on:** `npm test` after merging the website branch into main

## What happens

The website (src/web/) connects to the relay with only `?secret=` and the
relay-hosted MCP (src/relay-mcp.js) writes into a room as the person it works
for. Main's relay now requires every connection to send a name and an Ed25519
public key and sign a challenge (src/identity.js, src/connection.js), and
clients ignore presence, claims and feed entries that don't come from that
person's key. So the website gets "Could not reach the session", and entries
the relay-hosted AI writes as its person are dropped.

## What should happen

Browser users join sessions like CLI and app users, and their AI's work shows
up under their name.

## What we know

- Tests skipped with `NEEDS_IDENTITY` in test/web-engine.test.js (7) and
  test/relay-mcp.test.js (1) cover exactly this; they passed before the merge.
- Rate limiting of new rooms and the /status page work with signed identities
  (test/relay.test.js).

## Next steps

1. src/web/connection.js: keep an Ed25519 key pair per browser (WebCrypto
   `Ed25519`, stored in IndexedDB), send `name` and `key`, and answer the
   relay's MSG_AUTH challenge with the same payload as `signChallenge`.
2. src/relay-mcp.js: the relay can't sign as the person. Either have the
   linked browser tab relay the AI's entries (it holds the key), or let the
   relay vouch for writes from a linked token.
3. Un-skip the `NEEDS_IDENTITY` tests.
