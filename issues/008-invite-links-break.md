# 008: Invite links stop working

**Status:** Needs info · **Reported:** 2026-09-30 · **Seen on:** desktop app, hosted relay cowove-relay.fly.dev

## What happens

An invite link that worked before stops working: opening it doesn't get the
person into the session. (Exact symptom still to confirm: error message,
page that doesn't open the app, or the app opening but not joining.)

## What should happen

An invite link keeps working for as long as the session exists. When it
can't work, the person sees why (session deleted, too big, relay down) and
what to do next, e.g. "Ask for a new link".

## What we know

- A link looks like `https://<relay>/join/<room>#<secret>`
  (`encodeInvite` / `decodeInvite` in `src/runner.js`). The secret is in the
  `#` part, which browsers never send to the server.
- Opening it in a browser shows the relay's join page (`/join/<room>` in
  `src/server.js`). Its **Open in Quilt** button hands the link to the app
  as `quilt://join?invite=…`, handled by `open-url` / `second-instance` in
  `desktop/main.js`.
- Ways a link breaks today:
  - **The session is gone.** The relay deletes sessions idle for 30 days, and
    on 2026-09-30 two oversized sessions were deleted by hand
    ([007](007-relay-crashes-on-oversized-session.md)). The relay then treats
    the room as new; joining needs the relay key, so the person gets "Relay
    key required to create rooms" or "Wrong room secret" instead of "this
    session no longer exists".
  - **The session is too big** (007): refused with "over the size limit".
  - **The relay is down or restarting** (as in the 007 crash loop): the app
    keeps retrying with no clear message.
  - **The `#secret` part gets cut off** when the link is pasted into some
    chat apps or email clients, or retyped: "Wrong room secret".
  - **The relay's address changes** (it's still `cowove-relay.fly.dev` after
    the rename to Quilt): every old link points at the old host.
  - **The app isn't installed or `quilt://` isn't registered** (e.g. the app
    was never opened after install, or runs from a dev build): **Open in
    Quilt** does nothing.

## Likely causes, most likely first

1. The session behind the link was deleted (007 cleanup or expiry), and the
   error doesn't say so.
2. The relay was down (007) when the link was opened.
3. The `#secret` was stripped along the way.
4. `quilt://` not handled on the person's machine.

## Next steps

1. Ask for the exact link shape (without the secret), what was clicked, and
   the message shown.
2. Relay: remember deleted/expired room names (tombstones) and answer
   "This session has ended. Ask for a new link." instead of treating the
   link as a new room.
3. App: map each refusal to a plain message with a next step, and stop
   retrying forever when the relay is unreachable.
4. Join page: if the `#secret` is missing, say the link was cut off (the
   page already has a hidden "missing its secret" note; check it shows).
5. Before moving the relay to a quilt-named host, keep the old host
   redirecting so existing links keep working.

## Log
- 2026-09-30: reported.
