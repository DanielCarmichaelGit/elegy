# Required Sign-in, Session Passes and join.heyquilt.com Invites

Date: 2026-10-01. Builds on `2026-09-29-orgs-roles-agents-design.md` ("Session passes and the relay",
"Desktop app"), which this spec replaces for build-order item 3. Agent sign-in (item 2) is built.

## Goal

Nobody uses Quilt anonymously. The desktop app and the command line must be signed in to a heyquilt.com
account. The hosted relay only lets signed-in accounts and agents in, using short-lived passes signed by
the accounts API. Invites are links on `join.heyquilt.com`.

## Decisions

| Topic | Decision |
|---|---|
| What sign-in protects | The app **and** the relay. The relay refuses anyone without a valid pass. |
| Relays | Only the hosted relay, `wss://relay.heyquilt.com`. Relay settings and "This computer" are removed. Custom relays come later. |
| Command line and agents | `quilt login` uses the same browser approval as the app. Agents use their existing access keys. |
| Switchover | All at once. Older apps are told to update and sign in. No grace period. |
| Invites | Links only, on `join.heyquilt.com`. The owner still approves who gets in. No email invites. |
| Team sessions | Out of scope. Teams joining without owner approval is a later plan; the pass format leaves room for it. |

## Signing in

### Desktop app

- At boot, before the shell renders, the app checks for a computer token. Without one it shows a single
  screen: the Quilt logo, "Sign in to Quilt", a **Sign in** button, and "New to Quilt? Create an account"
  (opens `https://heyquilt.com/signup`).
- **Sign in** calls `POST /v1/device/start` (exists) with the computer's identity public key
  (`~/.quilt/identity.json`), then opens the returned `verificationUrl`
  (`https://heyquilt.com/link?code=XXXX-XXXX`, exists) in the browser. While waiting it shows the code and
  "Approve this computer in your browser", plus **Cancel** and **Open the page again**. It polls
  `POST /v1/device/poll` at the returned interval. On approval it signs the challenge and receives the
  computer token (`qd_…`) and profile. The code expires after 10 minutes; the screen then offers to start over.
- The token is saved to `~/.quilt/account.json`, mode `0600`, written atomically, refusing symlinks:
  `{ token, account: { id, name, email }, signedInAt }`.
- **Sign out** (Settings): calls the API to revoke this computer's token (best effort), deletes
  `account.json`, stops running sessions, and returns to the sign-in screen.
- A revoked or invalid token (401 from the API) also returns to the sign-in screen, with
  "This computer was signed out. Sign in again."
- Your name in sessions is your account profile name. The app's name field becomes read-only, with
  "Change it on heyquilt.com". Colour and AI tool stay app settings.

### Command line

- `quilt login`: the same device flow. Prints the link and code, opens the browser when it can, waits, and
  saves `~/.quilt/account.json`. `quilt logout` revokes and deletes it. `quilt whoami` prints the account
  name and email, or "Not signed in".
- Every command that starts or joins a session first requires a token. Without one: "Run quilt login first."

### Device-link signature fix (security, must ship first)

Device linking gets its own signature context, `quilt-device-link-v1` (`signDeviceLink` /
`verifyDeviceLink`), instead of reusing the relay's challenge format. The relay client refuses a room named
`device-link`. A computer-link signature can never be replayed to join a session.

## Session passes

### Getting a pass

- `POST /v1/passes`, authenticated by either a computer token (`Authorization: Bearer qd_…`) or an agent
  access key (`Bearer qa_…`). No body.
- Response: `{ pass, expiresAt }`. Revoked computers and revoked agents get 401.
- Pass format: `base64url(JSON payload) + "." + base64url(Ed25519 signature)`, signed with the API's pass
  key (Fly secret `PASS_SIGNING_KEY` on `quilt-api`).
- Payload: `{ v: 1, sub: <account id or agent id>, kind: 'person' | 'agent', name, key: <identity public key>, exp }`.
  - `exp` = now + **10 minutes** (epoch ms).
  - `key` for a person is the identity public key the computer registered when it was linked.
  - For an agent, `key` is the public key it registered when it joined. An agent with no registered key
    can't get a pass: 409 "This agent has no key. Invite it again."
  - Team fields (`team`, `access`, `scopes`) are reserved for the later team-sessions plan and absent here.
- Rate limit: 60 passes per minute per token.

### What the relay checks

- The relay is configured with the API's public key (`QUILT_PASS_PUBLIC_KEY`). With it set, **every**
  WebSocket connection and every HTTP route that touches a session (`/files`, `/blobs`, `/agent/link`)
  needs a valid pass:
  - WebSocket: `pass` query parameter.
  - HTTP: `x-quilt-pass` header.
- Valid means:
  - the signature verifies;
  - `v` is 1;
  - `exp` is in the future;
  - for WebSocket, `key` equals the public key the client then proves with the existing challenge.
- Refusals:
  - WebSocket upgrade without a valid pass: `reject 401 "Update Quilt and sign in to continue"`.
  - HTTP: 401 with the same text.
- Names: the relay uses the pass's `name`, not a client-chosen name. A room's name-to-key binding stays as
  today.
- Members are identified to the owner by name and `kind`. The member list shows account names; agents
  keep their badge.
- Keeping a pass fresh: the client sends a new pass in a `MSG_PASS` message at least every **5 minutes**.
  The relay records each connection's pass expiry. A connection whose pass expires without a replacement
  is closed with a new close code `4419` ("Your sign-in expired. Reconnecting.") and reconnects with a
  fresh pass. A revoked computer or agent can't get a new pass, so it's out within 10 minutes.
- The relay key is no longer used when `QUILT_PASS_PUBLIC_KEY` is set. New sessions are limited to
  **30 per account per hour** (keyed on `sub`), replacing the per-address limit.
- Without `QUILT_PASS_PUBLIC_KEY` (tests, future custom relays) the relay behaves as today.
- Unchanged: the invite secret, the owner's approval, editor/viewer roles, agent folders, large files and
  ending sessions. A pass proves who you are; the invite proves you were invited; the owner lets you in.
- Existing sessions keep their owners: ownership is the identity key, and linking a computer ties that key
  to the account.

### Clients

- The app and CLI fetch a pass before connecting and before HTTP calls, cache it until 2 minutes before
  `exp`, refresh it every 5 minutes while connected, and send it with `MSG_PASS`.
- An agent session uses the agent's saved access key (refreshing it with its refresh key as today) to get
  passes.

## One relay

- The app and CLI always use `wss://relay.heyquilt.com`. The `QUILT_SERVER` environment variable still
  overrides it, for development and tests only; it isn't shown in the app.
- The app's whole Relay section in Settings is removed: hosted or "This computer", address, relay key,
  check. `quilt relay set|check|clear` is removed. `relay`, `relayKey` and `relayMode` in
  `~/.quilt/settings.json` are ignored, and removed the next time settings are saved.
- The app no longer starts an in-process relay.
- Recent sessions:
  - Sessions on `cowove-relay.fly.dev` or `relay.heyquilt.com` reopen normally (same relay).
  - Sessions on a local relay (`ws://`) can't reopen. Their card reads "This session ran on your computer's
    own relay, which Quilt no longer supports. Your files are untouched." with **Remove from list**.

## Invites on join.heyquilt.com

- New invite links: `https://join.heyquilt.com/<room>#<secret>`. The relay is implied: the hosted relay.
- `decodeInvite` reads:
  - the new form;
  - `https://<relay>/join/<room>#<secret>`, the old form, which keeps its relay so old sessions work;
  - the existing `quilt join <link>` and `quilt:<code>` forms.
- The website serves the join page on the `join` host:
  - `web/proxy.js` rewrites `join.heyquilt.com/<room>` to an app route `/join/<room>`.
  - The route is public: not in the private path list.
  - The page reads the fragment in the browser and shows, in the site's look, "You're invited to a Quilt
    session", **Open in Quilt** (`quilt://join?invite=<encoded link>`) and **Download Quilt** for the
    visitor's system (existing `DownloadButtons`). A short line says Quilt will ask you to sign in.
  - With no secret in the fragment: "This link is missing part of it. Ask for a new invite." and no
    Open button.
  - Responses carry `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`.
- The relay's `/join/<room>` page becomes a redirect (302) to `https://join.heyquilt.com/<room>`. Browsers
  keep the `#secret`.
- DNS: a Cloudflare CNAME `join` → `heyquilt.netlify.app` (DNS only), and `join.heyquilt.com` added as a
  domain alias on the Netlify site `heyquilt`.

## Switchover

In order:

1. Deploy the accounts API with `PASS_SIGNING_KEY` and the device-link fix.
2. Deploy the website (join page, proxy rewrite) and add the `join` domain.
3. Release the desktop app (new version on GitHub releases; the download links point at the latest release).
4. Deploy the relay with `QUILT_PASS_PUBLIC_KEY`. Older apps are then refused with
   "Update Quilt and sign in to continue".

Before step 4, a live check on a test relay (or the hosted relay with the variable set briefly):

- sign in on a Mac;
- start a session;
- join it from a second signed-in account;
- an unsigned client is refused;
- an invite from `join.heyquilt.com` opens the app.

## Testing

- **API:**
  - passes are minted for valid computer tokens and agent access keys;
  - 401 for revoked, expired or unknown tokens;
  - 409 for keyless agents;
  - the rate limit;
  - the payload fields;
  - device-link signatures use the new context and can't verify as relay challenges.
- **Relay:**
  - valid pass admits;
  - missing, expired, forged, wrong-`v` or key-mismatched passes are refused (WS 401 and HTTP 401);
  - the pass's name is used;
  - a lapsed pass closes with 4419;
  - `MSG_PASS` refresh extends a connection;
  - the per-account new-session limit;
  - without `QUILT_PASS_PUBLIC_KEY` behaviour is unchanged.
- **Clients:**
  - the device flow saves `account.json` (mode `0600`, refuses symlinks);
  - sign-out deletes it;
  - session commands require it;
  - passes are fetched, cached and refreshed;
  - the app's boot shows the sign-in screen without a token;
  - local-relay recents show the unsupported card.
- **Invites:**
  - new and old forms decode;
  - `encodeInvite` produces the new form;
  - the join page renders Open and Download with a secret and the missing-secret message without one;
  - the relay join route redirects.
- **Copy:** no em dashes in user-facing text (enforced on the website by the existing test).

## Security

- Passes are short-lived (10 minutes), bound to one identity key, and signed with a key only the API holds.
  The relay needs only the public key.
- Computer tokens and agent keys are stored hashed on the server and only on the owner's machine locally
  (`0600`).
- The invite secret stays in the URL fragment and never reaches a server.
- Revoking a computer or an agent removes its access within 10 minutes.
