# 019: Accounts API: small correctness and hardening gaps

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** accounts API from main; HEAD check confirmed on api.heyquilt.com

Each item reproduced against the in-memory store unless noted
(`scratchpad/api/probe.mjs`, `probe2.mjs`).

1. **Bodies over 16 KB cut the connection instead of answering 413**
   (`src/api/server.js:274-287`): `req.destroy()` runs before the reject, so
   the client sees `UND_ERR_SOCKET`. Respond 413 + `connection: close` first.
2. **An org-kind account invited into someone else's org first can never
   create its own org** (`routes/orgs.js:61-69`, `create_org(p_first)`): the
   lookup returns any org the caller is a member of, so `POST /v1/orgs` answers
   200 with the *other* org. Add `and orgs.owner_id = p_owner`, or return `created: false`.
3. **No rate limit on `GET /v1/device/link/:code` and `POST /v1/device/approve`**
   (40-bit codes, 10-minute life). 50 rapid lookups → never 429. Reuse `limitInvites`.
4. **The invite-send limiter charges rejected attempts** (`routes/invites.js:83-88`):
   three typos → 429 for the next valid send. Charge only when mail is attempted.
5. **Email validation admits a trailing dot and `:`** (`routes/invites.js:17,32-36`):
   such invites can never be accepted (exact match on accept) and sit pending for 7 days.
6. **`HEAD` is 404 for every route** (`server.js:237`), including `/healthz`
   (verified on production). Match HEAD as GET.
7. **Nothing prunes `device_links`, `agent_keys`, `agent_invites`, closed
   `org_invites`**: growth is unbounded and partly unauthenticated
   (`POST /v1/device/start` is 10/min/IP). Production already has 7 expired
   links out of 9 after two days. Add a pg_cron job or a periodic API task.
8. **Approving a link an attacker started with the victim's own public key
   signs the victim's real computer out** (`server.js:154-156`,
   `upsertDevice` clears `token_hash` on conflict). Inherent to "relink retires
   the old token"; show "this will sign out your existing <name>" on `/link`
   (return `relink: true` from the lookup), or clear the old token only on collect.
9. **`/healthz` never touches the store**, so Fly keeps a machine "healthy"
   while every real request fails. Optional: a cheap store probe in the reply.
10. **`verifyUser` does not check `is_anonymous`**: if anonymous sign-ins are
    ever enabled in Supabase, anonymous users could approve device links and
    create agent invites. Add `if (payload.is_anonymous) return null`.

## Next steps
Fix in the order above; 3, 7 and 10 are the ones with a security angle.

## Log
- 2026-10-01: found by the audit.
