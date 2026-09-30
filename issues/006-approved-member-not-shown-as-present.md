# 006: Someone who is let into a session doesn't show up as being in it

**Status:** Needs info (likely caused by [007](007-relay-crashes-on-oversized-session.md): the relay was crashing, so no presence got through) · **Reported:** 2026-09-30 · **Seen on:** desktop app, owner inviting a new person into a controlled session

## What happens

The owner invites someone new. They join, the owner lets them in, and their
name appears in the **Access** list of the people menu. But they never appear
in the people bubble (the avatar stack in the top bar), and nothing else shows
they're in the session: no avatar, no count change, no "Their AI" entry.

## What should happen

Once let in, the person appears in the avatar stack and the people menu as
online, the count goes up, and their AI shows in the AI view, the same as
someone who joined an uncontrolled session.

## What we know

- The **Access** list and the bubble come from different places:
  - Access = `st.members`, from the relay's `MSG_MEMBERS` (`broadcastMembers`
    in `src/server.js`). This updates on approval, which is why the name shows.
  - Bubble = `[st.me, ...st.peers]` in `renderTop()` (`src/ui/session.js`),
    where `peers` is built from **awareness (presence) states** in
    `status()` (`src/session.js`). So the new person's presence never reached
    the owner.
- The flow on approval:
  1. While waiting, the relay ignores everything the joiner sends
     (`if (waiting) return` in `src/server.js`), including the presence it
     sent on connect (`startSync()` in `src/connection.js`).
  2. `approve` calls `enter()` → `join()`, which sends the joiner the doc and
     everyone's presence.
  3. The joiner gets `MSG_ACCESS` approved and calls `startSync()` again,
     which re-sends its own presence. The relay should then forward it to the
     owner.
- On paper step 3 covers it, so something in that path isn't happening.

## Likely causes, most likely first

1. **Joiner's presence is never re-sent after approval.** e.g. `this.access`
   wasn't `pending` when approval arrived (so the `was.state === 'pending'`
   check in `src/connection.js` fails), or the local presence state is null
   at that moment.
2. **Relay drops it in `presenceAllowed`.** The presence `name` doesn't match
   the verified name stored in `this.names` (e.g. a display name vs the signed
   name), so the relay logs "dropped presence … under another name".
3. **Owner's UI doesn't re-render.** Presence arrives but the owner's status
   isn't rewritten / the top bar isn't redrawn after the awareness change.
4. **Stale presence clock.** The joiner's first (dropped) presence and the
   re-send carry the same clock, and something along the way treats it as
   already seen.

## Next steps

1. Reproduce: owner starts a session, second identity joins with an invite,
   owner approves. Watch the relay log for "dropped presence" and the owner's
   log for "👋 <name> joined".
2. Add a test in `test/` for the approval flow: after `approve`, the owner's
   `status().peers` includes the new person, and vice versa.
3. Fix whichever step fails; if it's cause 1, have the joiner always re-send
   presence on any `approved` access message.

## Log
- 2026-09-30: reported.
- 2026-09-30: the relay was in an out-of-memory crash loop at the time (007). Recheck in a fresh session after that fix.
