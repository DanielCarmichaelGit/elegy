# 014: Session ownership and creation go to whoever connects first, not to the person who started the session

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** relay from main (98eb68b)

## What happens
1. **A view-only invitee can become the owner.** `accessFor`
   (`src/server.js:173`) gives ownership to the first key that completes the
   challenge, ignoring `invitedAs`. The creator's upgrade sets the secrets and
   persists the room, but ownership is only set one round-trip later. If the
   creator's first connection drops before it answers the challenge, or an
   invitee is simply faster, the invitee gets `owner: true` (approve, deny,
   remove, end) and the real creator lands in `pending`.
2. **An invitee can create the room.** The app generates room name, edit
   secret and view secret locally (`src/runner.js:41-43`) before the relay has
   seen the room. If someone opens a view link before the creator's connection
   lands, the relay creates the room with the *view* secret as its edit secret
   and uncontrolled; the creator is then refused with `401 Wrong room secret`.

## What should happen
Only the connection that created the room (or at least one admitted as
`editor`) can become owner. A room can only be created with its full secret,
or the creator is recorded at creation time.

## What we know
- Reproduced: `owner-takeover.mjs` (creator upgrades with `secret=EDIT&viewSecret=VIEW`, closes before signing; a `VIEW` connection then gets `{"state":"approved","role":"editor","owner":true}`; the creator's reconnect gets `pending`), `first-come.mjs` (a `VIEW` connection to a not-yet-created room is `approved, controlled:false`; the creator then gets 401). Both under the audit's `scratchpad/relay/`.
- With sign-in on (010) the same logic applies; passes do not change who is first.

## Next steps
1. In `authorize`, when creating a controlled room, record `meta.creator = publicKey` from the upgrade; in `accessFor` set `owner` only when `key === meta.creator` (fallback: `invitedAs === 'editor'`).
2. Have the app finish creating the room (complete the challenge) before it shows the invite link.
3. Tests for both races in `test/relay.test.js`.

## Log
- 2026-10-01: found by the audit.
