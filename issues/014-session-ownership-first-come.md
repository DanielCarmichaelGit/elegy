# 014: Session ownership and creation go to whoever connects first, not to the person who started the session

**Status:** **Fixed** (7028258), part 1; part 2 is a design limit, see the log · **Reported:** 2026-10-01 (audit) · **Seen on:** relay from main (98eb68b)

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
- 2026-10-02: part 1 fixed (7028258). The upgrade handler now checks the identity key before the
  room is touched, and `authorize` records it as `meta.creator` when it creates the room. `accessFor`
  makes only that key the owner; everyone else who signs in before the creator waits in `pending`,
  whatever secret they came with (for rooms stored before creators were recorded, with no owner yet,
  the first editor invitee still becomes owner). Test: "only the creator of a session becomes its
  owner, even if an invitee signs in first" in `test/relay.test.js`.
  Part 2 (an invitee creating the room with the view secret before the creator's connection lands) is
  not enforceable on the relay: before the room exists, a view secret and an edit secret look the
  same, and the client doesn't tell the relay whether it is creating or joining (`Session` passes no
  such flag to `Connection`, and tests and older clients create plain rooms with only a secret). In
  practice the app only hands out the invite after `session.start()` has synced, by which point the
  room exists with its creator recorded, so the race needs an invite shared before the app connected.
  Closing it properly means a "joining" flag from `Session` to `Connection` (sent as a header) that
  makes the relay refuse to create a room for a joiner; that touches `src/session.js`.
