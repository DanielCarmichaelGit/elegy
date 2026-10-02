# 017: The API accepts public keys with junk in them, so "one key, one agent/computer" can be bypassed

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** accounts API from main, reproduced on the in-memory store

## What happens
`parsePublicKey` (`src/identity.js:50-55`) validates with
`Buffer.from(b64, 'base64url')`, and Node's decoder silently drops characters
outside the alphabet. `KEY + ',,,junk!!'` or `KEY` with a space parse to the
same Ed25519 key, but the API stores and compares the raw string:
- A second agent joins with a key already registered to another agent
  (`agentByPublicKey` finds nothing for the other spelling; the DB `unique` on
  `agents.public_key` is defeated).
- Relinking a computer with the junk spelling creates a second `devices` row,
  so the old token is **not** retired as the relink flow promises.
- `passHolder` copies the raw string into the signed pass, so the relay sees
  `key: "…,,,junk!!"`. Not an escalation there (it string-compares against what
  the same client sent), but the invariant is gone.

## What should happen
Keys are canonicalised (re-exported from the parsed key) before being stored,
compared or signed into a pass; input that differs from its canonical form is rejected.

## What we know
Reproduced (`scratchpad/api/probe.mjs` §2): two agents joined with the same
DER key; two device rows for one key with the first token still alive.
Relevant code: `src/api/routes/join.js:32,50`, `src/api/server.js:84,108-116`.

## Next steps
1. Add `canonicalPublicKey()` in `identity.js` (`parsePublicKey(b64)?.export({type:'spki',format:'der'}).toString('base64url')`), use it in `POST /v1/device/start`, `join.js profile()` and `passHolder`; 400 when `canon !== input`.
2. Back it with a DB check `public_key ~ '^[A-Za-z0-9_-]{60}$'` on `devices`, `device_links`, `agents`.

## Log
- 2026-10-01: found by the audit.
