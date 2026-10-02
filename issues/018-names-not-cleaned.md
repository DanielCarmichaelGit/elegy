# 018: Person display names and computer names are not cleaned, so invisible/bidi characters reach passes, sessions and the approve page

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** accounts API from main

## What happens
- `cleanProfile` (`src/api/server.js:94-100`) only trims and slices the
  person's name. Org, role, team and agent names go through `cleanName`,
  which strips controls, zero-width and bidi characters, but the one name
  everyone sees in a session does not. `passHolder` signs it into the pass and
  the relay takes names from passes. The name seeded by `handle_new_user`
  from sign-up metadata is client-controlled too.
  Reproduced: `PUT /v1/me/profile` with `"Mo‮ nimdA​"` → stored and
  issued in the pass verbatim.
- `deviceName` from the unauthenticated `POST /v1/device/start` is only
  sliced (`:115`). `/link?code=…` renders it in bold as the thing the person
  is asked to approve. A phishing link can show a deceptive name (U+202E).
  A NUL byte would also make Postgres raise `22021` → logged 500 (reasoned, not run).
- `PUT /v1/me/profile` with `name: null` saves the string `"null"` (`:96`).

## What should happen
Profile names and device names get the `cleanName` treatment; the pass never
carries invisible characters; `name: null` is a 400.

## Next steps
1. `out.name = cleanName(b.name, 60, 'name is empty')` in `cleanProfile`; explicit 400 for `null`.
2. `deviceName: stripInvisible(deviceName).join('').trim().slice(0, 80) || 'A computer'`; same for `platform`.
3. Strip invisibles in `passHolder` (person and agent branches) and in `verifyPass` on the relay.

## Log
- 2026-10-01: found by the audit (`scratchpad/api/probe2.mjs` §A, `probe.mjs` §3, §8).
