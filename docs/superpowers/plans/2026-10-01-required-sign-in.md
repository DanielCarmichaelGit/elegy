# Required Sign-in, Session Passes and join.heyquilt.com Invites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nobody uses Quilt anonymously: the desktop app and the command line sign in to a heyquilt.com account, the hosted relay only admits holders of short-lived passes signed by the accounts API, and invites are `https://join.heyquilt.com/<room>#<secret>` links.

**Architecture:** The accounts API (`src/api/server.js`) signs 10-minute Ed25519 passes (`src/passes.js`) for a linked computer's `qd_` token or an agent's `qa_` access key. The relay (`src/server.js`) checks them, when `QUILT_PASS_PUBLIC_KEY` is set, on every WebSocket upgrade (`pass` query parameter) and session HTTP route (`x-quilt-pass` header), takes the person's name and kind from the pass, closes connections whose pass lapses with code 4419, and accepts fresh passes in a new `MSG_PASS` message. Clients get passes through a caching `PassSource` (`src/pass-source.js`) built from `~/.quilt/account.json` (written by the device flow in `src/account.js`) or a saved agent's keys; the app gains a sign-in screen and loses its relay settings and in-process relay; invites move to a public join page on the website.

**Tech Stack:** Node 22 (`node:crypto` Ed25519, `node:test`), `ws`, Yjs, plain-DOM app in `src/ui/`, Electron shell, Next.js 16 website in `web/` (proxy.js, app router), Fly.io (relay and API), Netlify (website), Cloudflare DNS.

**Spec:** `docs/superpowers/specs/2026-10-01-required-sign-in-design.md`. Read it before starting; this plan argues from it.

## Global Constraints

- Code style: StandardJS (no semicolons, 2-space indent, single quotes, a space before function parens), ES modules, matching the files around it. The website uses JSX in the same style.
- Run `npm test` from the repo root after every task; every test must pass before committing. Tasks that touch `web/` also run `cd web && npm test`.
- Device linking signs in its own context `quilt-device-link-v1`, with `signDeviceLink` / `verifyDeviceLink`. The relay client refuses a room named `device-link`.
- `POST /v1/passes`, authenticated by `Authorization: Bearer qd_…` (a computer token) or `Bearer qa_…` (an agent access key), no body. Response `{ pass, expiresAt }`. Revoked computers and revoked agents get 401.
- Pass format: `base64url(JSON payload) + "." + base64url(Ed25519 signature)`, signed with the API's pass key, Fly secret `PASS_SIGNING_KEY` on `quilt-api`.
- Payload: `{ v: 1, sub: <account id or agent id>, kind: 'person' | 'agent', name, key: <identity public key>, exp }`. `exp` = now + **10 minutes** (epoch ms). No `team`, `access` or `scopes` fields.
- An agent with no registered key gets 409 `This agent has no key. Invite it again.`
- Rate limit: 60 passes per minute per token.
- The relay reads the API's public key from `QUILT_PASS_PUBLIC_KEY`. With it set, every WebSocket connection needs a valid pass in the `pass` query parameter, and `/files`, `/blobs` and `/agent/link` need one in the `x-quilt-pass` header. Valid means: signature verifies, `v` is 1, `exp` is in the future, and (WebSocket) `key` equals the public key the client then proves.
- Refusals: WebSocket upgrade `reject 401 "Update Quilt and sign in to continue"`; HTTP 401 with the same text.
- The relay uses the pass's `name`, not a client-chosen name. The name-to-key binding in a room stays as today.
- Clients send a new pass in `MSG_PASS` at least every **5 minutes**. A connection whose pass expires is closed with code `4419` and reason `Your sign-in expired. Reconnecting.`
- With `QUILT_PASS_PUBLIC_KEY` set the relay key is not used, and new sessions are limited to **30 per account per hour**, keyed on `sub`. Without it the relay behaves exactly as today.
- Clients fetch a pass before connecting and before HTTP calls, cache it until 2 minutes before `exp`, and refresh it every 5 minutes while connected.
- `~/.quilt/account.json`: mode `0600`, written atomically, refusing symlinks, shaped `{ token, account: { id, name, email }, signedInAt }`.
- The only relay is `wss://relay.heyquilt.com`. `QUILT_SERVER` overrides it, for development and tests only, and is never shown in the app.
- Invite links: `https://join.heyquilt.com/<room>#<secret>`. The app link on the join page is `quilt://join?invite=<encoded link>`.
- User-facing copy, exactly:
  - App: `Sign in to Quilt`, **Sign in**, `New to Quilt? Create an account` (opens `https://heyquilt.com/signup`), `Approve this computer in your browser`, **Cancel**, **Open the page again**, `This computer was signed out. Sign in again.`, `Change it on heyquilt.com`.
  - CLI: `Run quilt login first.`, `Not signed in`.
  - Recent sessions: `This session ran on your computer's own relay, which Quilt no longer supports. Your files are untouched.` with **Remove from list**.
  - Website: `You're invited to a Quilt session`, **Open in Quilt**, **Download Quilt** (the existing `DownloadButtons`), and without a secret `This link is missing part of it. Ask for a new invite.` with no Open button.
- No em dashes in user-facing text (the website's `web/test/no-em-dash.test.js` enforces it there).
- Never paste or print a secret (the pass signing key, tokens) into chat or logs. Key material moves by pipe into `fly secrets import`.

## Decisions made in this plan

The spec leaves these open; this plan settles them:

1. **Key encodings.** Pass keys are Ed25519 in the same encodings as identity keys: `PASS_SIGNING_KEY` is PKCS8 DER in base64url, `QUILT_PASS_PUBLIC_KEY` is SPKI DER in base64url. `scripts/pass-keys.mjs` makes a pair and prints only `PASS_SIGNING_KEY=…` on stdout, for `fly secrets import`.
2. **The public key is public.** The API serves it at `GET /v1/passes/key` (`{ publicKey }`), so the relay can be configured without anyone copying keys by hand.
3. **API without a pass key.** `POST /v1/passes` and `GET /v1/passes/key` answer 503 `passes are not set up on this server`. `quilt api` refuses to start without `PASS_SIGNING_KEY` (except `--memory`, which makes a throwaway pair and prints the public key for a local relay).
4. **Rate limit details.** Counted per sha256 of the bearer token, after the token checks out (so junk tokens don't fill the limiter). The 61st pass in a minute gets 429 `too many passes; try again in a minute`.
5. **Pass name.** A person's pass carries their profile name (cut to 64 characters, or `Quilt user` when empty); an agent's carries its agent name.
6. **Email in profiles.** `POST /v1/device/poll` (approved) and `GET /v1/me` return `profile.email` too, so `account.json` can hold `{ id, name, email }`.
7. **`MSG_PASS` = 16**, client to relay, JSON `{ pass }`. A refresh counts only when it verifies and has the same `sub`, `kind` and `key` as the connection's pass; anything else is ignored (and the connection closes at its current expiry). People waiting for the owner can refresh too.
8. **Kind on the relay.** With passes on, `kind` is `agent` for agent passes and `human` for person passes; the URL's `name` and `kind` are ignored.
9. **Owner name.** The relay remembers the owner's current name (`meta.ownerName`), so the member list shows the account name even if the owner used another name in that room before.
10. **Routes without passes.** `/blobs/<room>/<id>/data` (the disk store's signed links) and `/mcp/<token>` need no pass: a signature or a link token already grants them. `/agent/link` names the link after the pass.
11. **Refreshing.** While connected, the client forces a new pass every 5 minutes (`PassSource.fresh()`), so a refresh never re-sends the same pass. Connecting and HTTP calls use the cache (`get()`). After a 4419 close, the reconnect forces a fresh pass.
12. **API address on clients.** `QUILT_API_URL` overrides `https://api.heyquilt.com` (the website already uses this variable name).
13. **Names come from passes everywhere.** `runSession` takes the session name (and the agent badge) from the first pass. `quilt join --name` and `quilt join --server` are removed; `quilt join --agent <name>` joins as a saved agent (`~/.quilt/agents/<name>.json`) instead of being a plain flag.
14. **MCP sessions are agents.** `quilt_join_session` and `quilt_start_session` join as a saved agent (new optional `agent` argument; the only saved agent when there is just one). With none saved they explain how to add one.
15. **CLI details.** `quilt login --no-browser` skips opening the browser (tests use it). `quilt whoami` exits 1 when not signed in. When the API turns a CLI session's token away, the CLI deletes `account.json` and says `This computer was signed out. Run quilt login again.`
16. **Hosted relay addresses.** `wss://relay.heyquilt.com` and the old `wss://cowove-relay.fly.dev` (the same Fly app) both count as the hosted relay: their invites use the join form. Any other relay (a `QUILT_SERVER` development relay) keeps the relay form, so tests and development keep working. A join link decodes to the current relay (`QUILT_SERVER` or the hosted one). A join link without a secret is refused with the website's wording.
17. **Local relays.** A session "ran on a local relay" when its address starts with `ws://` and isn't the current relay (so a `QUILT_SERVER=ws://…` development relay still reopens). `quilt join` in such a folder starts a new session and says why.
18. **`quilt serve` stays**: it is how the hosted relay runs. Only `quilt relay set|check|clear` is removed.
19. **Sign-in screen states** not worded by the spec: expired `That code expired. Start over to get a new one.`, declined `This computer was not approved. Start over to try again.`, with a **Start over** button. The app polls its own server every 2 seconds; its server polls the API at the API's interval (3 seconds).
20. **App gating.** Until signed in, the app's local server answers only the account routes, `/api/events` and `/api/shutdown`; everything else is 401 `{ error: 'Sign in to Quilt first.', signedOut: true }`, and the page switches to the sign-in screen when it sees that.
21. **Website join page.** On `join.heyquilt.com`, any single-segment path is a room; the root and anything else redirect to `https://heyquilt.com/`. The Open link always uses the canonical `https://join.heyquilt.com/<room>#<secret>`. The sign-in line reads `Quilt will ask you to sign in first.`, and above the downloads: `Don't have Quilt yet? Download it, then click Open in Quilt again.`
22. **Version.** The desktop release that carries this is `0.3.0`.
23. **Tests for the page boot.** There is no DOM test harness, so "boot shows the sign-in screen" is covered through the local API (`GET /api/account`, gating) and by checking the served `app.js` and `signin.js`.
24. **`desktop/main.js` is unchanged.** The sign-in screen opens the website with `window.open`, which the existing `setWindowOpenHandler` already sends to the browser.
25. **Reading `account.json`** also refuses a symlink (it reads as signed out).

## File Structure

New files:

- `src/passes.js`: pass format. `newPassKeys`, `passPublicKey`, `signPass`, `readPass`, `verifyPass`, `PASS_VERSION`, `PASS_TTL_MS`. Pure, no I/O. Used by the API, the relay, clients and tests.
- `src/private-file.js`: `isSymlink`, `writePrivateJson` (atomic `0600` writes that refuse symlinks), moved out of `src/agent-join.js` so `account.json` uses the same code.
- `src/account.js`: `~/.quilt/account.json` and the device flow: `apiUrl`, `accountFile`, `readAccount`, `saveAccount`, `clearAccount`, `accountFromProfile`, `startLink`, `pollLink`, `waitForLink`, `fetchMe`, `signOut`, copy constants.
- `src/pass-source.js`: `PassSource` (cache and refresh), `SignedOutError`, `personPasses`, `agentPasses`, `sessionPasses`, timing constants.
- `src/ui/signin.js`: the app's sign-in screen.
- `scripts/pass-keys.mjs`: makes the pass signing key for `fly secrets import`.
- `web/lib/join.js`: `JOIN_HOST`, `isRoom`, `joinView`, `joinPath`.
- `web/app/join/[room]/page.js`: the public join page.
- `web/components/JoinInvite.js`: the client part that reads the fragment.
- Tests: `test/identity.test.js`, `test/passes.test.js`, `test/api-passes.test.js`, `test/pass-helpers.js`, `test/relay-passes.test.js`, `test/account.test.js`, `test/cli-account.test.js`, `test/pass-source.test.js`, `test/session-passes.test.js`, `test/cli-join.test.js`, `test/ui-account.test.js`, `web/test/join.test.js`.

Modified files:

- `src/identity.js`: device-link signatures; refuse the `device-link` room.
- `src/api/server.js`: device-link verification, `POST /v1/passes`, `GET /v1/passes/key`, email in profiles.
- `src/protocol.js`: `MSG_PASS`, `CLOSE_PASS_EXPIRED`.
- `src/server.js`: pass checks, per-account limit, owner name, `/join/<room>` redirect (and the old join page removed).
- `src/connection.js`: refuse `device-link`, passes in the URL, refresh timer, 4419.
- `src/session.js`: `passes` option, `x-quilt-pass` on HTTP calls.
- `src/runner.js`: `runSession` takes `passes` and `identity`; `newConn` uses the one relay; new `encodeInvite` / `decodeInvite`.
- `src/agent-join.js`: uses `writePrivateJson`; adds `readAgent`, `agentAccess`, `savedAgents`, `pickAgent`.
- `src/settings.js`: one relay (`HOSTED_RELAY`, `relayUrl`, `isHostedRelay`, `ranOnLocalRelay`); relay settings dropped.
- `src/mcp.js`: agent passes; no relay argument.
- `src/ui-server.js`: no relay settings or in-process relay; account routes, gating, passes, sign-out; read-only name; unsupported recents.
- `src/ui/app.js`, `src/ui/home.js`, `src/ui/common.js`, `src/ui/session.js`, `src/ui/app.css`: sign-in, sign-out, account section, relay UI removed, new invite form.
- `bin/quilt.js`: `login`, `logout`, `whoami`; `join` needs a sign-in; `relay` removed; `api` reads `PASS_SIGNING_KEY`; `serve` prints the sign-in mode.
- `web/proxy.js`: the `join` host.
- `scripts/api-smoke.mjs`, `scripts/link-smoke.mjs`: new signatures, pass check.
- `test/api.test.js`, `test/api-helpers.js`, `test/relay.test.js`, `test/settings.test.js`, `test/ui.test.js`, `test/mcp.test.js`, `test/agent-join.test.js`, `web/test/routes.test.js`.
- `README.md`, `docs/hosting.md`, `fly.toml`, `fly.api.toml`, `package.json` (version).

---
### Task 1: Device-link signature fix

Today the app proves it holds its key by signing the device code with the relay's challenge format and the room name `device-link`. A relay could ask a client to sign a "challenge" for a room called `device-link` whose nonce is someone's device code. This task gives device linking its own signature context and makes the relay client refuse that room. It ships first.

**Files:**
- Modify: `src/identity.js`
- Modify: `src/api/server.js:6` (import) and `src/api/server.js:107-109` (poll check)
- Modify: `src/connection.js:14` (import) and the top of the `Connection` constructor
- Modify: `test/api.test.js:1-22` (imports and the `sign` helper), add one test
- Modify: `scripts/api-smoke.mjs`, `scripts/link-smoke.mjs`
- Create: `test/identity.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `signDeviceLink(identity: { publicKey, privateKey }, deviceCode: string): string` (base64url Ed25519 signature over `quilt-device-link-v1\0<deviceCode>`)
  - `verifyDeviceLink(key: KeyObject | null, deviceCode: string, signature: string): boolean`
  - `RESERVED_ROOM = 'device-link'` (exported from `src/identity.js`)
  - `signChallenge(identity, room, nonce)` throws `Error('"device-link" is not a session name')` for that room; `new Connection({ room: 'device-link', … })` throws the same.

- [ ] **Step 1: Write the failing tests**

Create `test/identity.test.js`:

```js
// Identity signatures: relay sign-ins and computer links use separate contexts,
// so a signature made for one can never be used for the other.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { generateIdentity, parsePublicKey, signChallenge, verifyChallenge, signDeviceLink, verifyDeviceLink } from '../src/identity.js'
import { Connection } from '../src/connection.js'

test('device links have their own signature context', () => {
  const id = generateIdentity()
  const key = parsePublicKey(id.publicKey)
  const sig = signDeviceLink(id, 'dc_abc')
  assert.equal(verifyDeviceLink(key, 'dc_abc', sig), true)
  assert.equal(verifyDeviceLink(key, 'dc_other', sig), false, 'bound to the device code')
  assert.equal(verifyDeviceLink(parsePublicKey(generateIdentity().publicKey), 'dc_abc', sig), false, 'bound to the key')
  assert.equal(verifyDeviceLink(key, 'dc_abc', 'not a signature'), false)
  assert.equal(verifyDeviceLink(null, 'dc_abc', sig), false)
  // Neither kind of signature verifies as the other.
  assert.equal(verifyChallenge(key, 'device-link', Buffer.from('dc_abc'), Buffer.from(sig, 'base64url')), false)
  const relaySig = Buffer.from(signChallenge(id, 'room-1', Buffer.from('dc_abc'))).toString('base64url')
  assert.equal(verifyDeviceLink(key, 'dc_abc', relaySig), false)
})

test('the relay client never signs a challenge for a room named device-link', () => {
  const identity = generateIdentity()
  assert.throws(() => signChallenge(identity, 'device-link', Buffer.from('x')), /"device-link" is not a session name/)
  assert.throws(() => new Connection({ server: 'ws://127.0.0.1:9', room: 'device-link', secret: 's', name: 'n', identity, doc: new Y.Doc() }), /"device-link" is not a session name/)
})
```

In `test/api.test.js`, change the imports and the `sign` helper (lines 1-22) to:

```js
// test/api.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startApi } from '../src/api/server.js'
import { createMemoryStore } from '../src/api/memory-store.js'
import { generateIdentity, signDeviceLink } from '../src/identity.js'
```

and

```js
// The app proves it holds the computer's key by signing the device code.
const sign = (identity, deviceCode) => signDeviceLink(identity, deviceCode)
const poll = (identity, deviceCode, via = call) => via('POST', '/v1/device/poll', { deviceCode, signature: sign(identity, deviceCode) })
```

(the `let api, store`, `SITE`, `verifyUser` and `call` lines between them stay as they are). Then add this test after the test named `only the computer holding the key can collect the token: a missing or wrong signature is refused`:

```js
test('a signature in the old relay-challenge format no longer collects a token', async () => {
  const id = generateIdentity()
  const s = await call('POST', '/v1/device/start', { publicKey: id.publicKey, deviceName: 'Mac', platform: 'darwin' })
  await call('POST', '/v1/device/approve', { userCode: s.body.userCode, approve: true }, 'user:u1')
  // Exactly what the app used to send: a relay challenge for the room "device-link".
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(id.privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
  const payload = Buffer.concat([Buffer.from('cowove-auth-v1\0device-link\0'), Buffer.from(s.body.deviceCode)])
  const old = crypto.sign(null, payload, privateKey).toString('base64url')
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: s.body.deviceCode, signature: old })).status, 401)
  assert.equal((await poll(id, s.body.deviceCode)).status, 200, 'the new signature still works')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/identity.test.js test/api.test.js`
Expected: FAIL. `identity.test.js` fails with `SyntaxError: The requested module '../src/identity.js' does not provide an export named 'signDeviceLink'`; `api.test.js` fails the same way.

- [ ] **Step 3: Implement the signatures**

Replace everything in `src/identity.js` from `const AUTH_CONTEXT = 'cowove-auth-v1'` to the end of the file with (the header comment and imports stay):

```js
const AUTH_CONTEXT = 'cowove-auth-v1'
// Linking a computer to an account signs the device code in a context of its own,
// so a signature made to link a computer can never be replayed to join a session,
// and a relay can never collect one by posing as a session.
const DEVICE_LINK_CONTEXT = 'quilt-device-link-v1'
// The room name device links used to be signed for. The relay client refuses it.
export const RESERVED_ROOM = 'device-link'

export const identityFile = () => path.join(quiltHome(), 'identity.json')

export function generateIdentity () {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
  }
}

/** Loads this machine's identity, creating it on first use. */
export function loadIdentity (file = identityFile()) {
  try {
    const id = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (id.publicKey && id.privateKey) return id
  } catch {}
  const id = generateIdentity()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(id), { mode: 0o600 })
  return id
}

const privateKeyOf = (identity) => crypto.createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
const payload = (room, nonce) => Buffer.concat([Buffer.from(`${AUTH_CONTEXT}\0${room}\0`), Buffer.from(nonce)])

export function signChallenge (identity, room, nonce) {
  if (room === RESERVED_ROOM) throw new Error(`"${RESERVED_ROOM}" is not a session name`)
  return new Uint8Array(crypto.sign(null, payload(room, nonce), privateKeyOf(identity)))
}

/** Parses a public key sent by a client; null unless it's a valid Ed25519 key. */
export function parsePublicKey (b64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(b64), 'base64url'), format: 'der', type: 'spki' })
    return key.asymmetricKeyType === 'ed25519' ? key : null
  } catch { return null }
}

export function verifyChallenge (key, room, nonce, signature) {
  try { return crypto.verify(null, payload(room, nonce), key, Buffer.from(signature)) } catch { return false }
}

const linkPayload = (deviceCode) => Buffer.from(`${DEVICE_LINK_CONTEXT}\0${deviceCode}`)

/** Proves this computer holds its key when it collects its account token. Returns base64url. */
export function signDeviceLink (identity, deviceCode) {
  return crypto.sign(null, linkPayload(String(deviceCode)), privateKeyOf(identity)).toString('base64url')
}

export function verifyDeviceLink (key, deviceCode, signature) {
  if (!key || typeof signature !== 'string') return false
  try { return crypto.verify(null, linkPayload(String(deviceCode)), key, Buffer.from(signature, 'base64url')) } catch { return false }
}
```

In `src/api/server.js`, change line 6 to:

```js
import { parsePublicKey, verifyDeviceLink } from '../identity.js'
```

and replace the two signature lines in the `/v1/device/poll` route:

```js
      const sig = typeof body.signature === 'string' ? Buffer.from(body.signature, 'base64url') : null
      if (!sig || !verifyChallenge(parsePublicKey(link.publicKey), 'device-link', Buffer.from(String(body.deviceCode)), sig)) throw new HttpError(401, "this computer's signature doesn't match")
```

with:

```js
      if (!verifyDeviceLink(parsePublicKey(link.publicKey), String(body.deviceCode), body.signature)) throw new HttpError(401, "this computer's signature doesn't match")
```

In `src/connection.js`, change line 14 to:

```js
import { signChallenge, RESERVED_ROOM } from './identity.js'
```

and make the first two lines of the constructor body:

```js
    super()
    if (room === RESERVED_ROOM) throw new Error(`"${RESERVED_ROOM}" is not a session name`)
```

In `scripts/api-smoke.mjs`, change the import to `import { generateIdentity, signDeviceLink } from '../src/identity.js'` and the `poll` helper to:

```js
const poll = (dc) => call('POST', '/v1/device/poll', { deviceCode: dc, signature: signDeviceLink(id, dc) })
```

In `scripts/link-smoke.mjs`, change the import to `import { generateIdentity, signDeviceLink } from '../src/identity.js'` and the signature line to:

```js
const signature = signDeviceLink(id, start.b.deviceCode)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/identity.test.js test/api.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS (nothing else signs device links).

- [ ] **Step 5: Commit**

```bash
git add src/identity.js src/api/server.js src/connection.js test/identity.test.js test/api.test.js scripts/api-smoke.mjs scripts/link-smoke.mjs
git commit -m "Sign device links in their own context, and never sign a relay challenge for device-link"
```

---

### Task 2: Pass signing and `POST /v1/passes`

**Files:**
- Create: `src/passes.js`
- Create: `scripts/pass-keys.mjs`
- Modify: `src/api/server.js` (imports, `startApi` options, a limiter, two routes)
- Modify: `bin/quilt.js` (`apiCmd`)
- Modify: `test/api-helpers.js` (`linkDevice`, `publicKey` on `makeAgent`)
- Modify: `scripts/api-smoke.mjs` (pass checks)
- Create: `test/passes.test.js`, `test/api-passes.test.js`

**Interfaces:**
- Consumes: `generateIdentity`, `parsePublicKey` from `src/identity.js`.
- Produces (in `src/passes.js`):
  - `PASS_VERSION = 1`, `PASS_TTL_MS = 600000`
  - `newPassKeys(): { publicKey: string, privateKey: string }` (SPKI / PKCS8, base64url DER)
  - `passPublicKey(signingKey: string | KeyObject): string`
  - `signPass(payload: object, signingKey: string | KeyObject): string`
  - `readPass(pass: string): object | null` (decodes without checking)
  - `verifyPass(pass: string, key: string | KeyObject, { now?: number }): { v, sub, kind, name, key, exp } | null`
- Produces (API): `startApi({ …, passKey = '', passLimit = 60 })`; `POST /v1/passes` → `{ pass, expiresAt }`; `GET /v1/passes/key` → `{ publicKey }`.
- Produces (tests): `linkDevice(t, userId, identity?): Promise<{ device, token, identity }>` in `test/api-helpers.js`; `makeAgent(t, { publicKey })`.

- [ ] **Step 1: Write the failing tests**

Create `test/passes.test.js`:

```js
// The pass format: signed by the accounts API, checked by the relay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newPassKeys, passPublicKey, signPass, readPass, verifyPass, PASS_TTL_MS } from '../src/passes.js'
import { generateIdentity } from '../src/identity.js'

const keys = newPassKeys()
const id = generateIdentity()
const fields = (over = {}) => ({ v: 1, sub: 'user-1', kind: 'person', name: 'Dana', key: id.publicKey, exp: Date.now() + PASS_TTL_MS, ...over })

test('a signed pass verifies with the public key and gives back its payload', () => {
  const payload = fields()
  const pass = signPass(payload, keys.privateKey)
  assert.match(pass, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.deepEqual(verifyPass(pass, keys.publicKey), payload)
  assert.deepEqual(readPass(pass), payload)
  assert.equal(passPublicKey(keys.privateKey), keys.publicKey)
})

test('forged, altered, expired, wrong-version and malformed passes are refused', () => {
  assert.equal(verifyPass(signPass(fields(), newPassKeys().privateKey), keys.publicKey), null, 'another signing key')
  const [body, sig] = signPass(fields(), keys.privateKey).split('.')
  const altered = Buffer.from(JSON.stringify({ ...fields(), name: 'Mallory' })).toString('base64url')
  assert.equal(verifyPass(`${altered}.${sig}`, keys.publicKey), null, 'altered payload')
  assert.equal(verifyPass(`${body}.${sig}x`, keys.publicKey), null, 'altered signature')
  assert.equal(verifyPass(signPass(fields({ exp: Date.now() - 1 }), keys.privateKey), keys.publicKey), null, 'expired')
  assert.equal(verifyPass(signPass(fields({ v: 2 }), keys.privateKey), keys.publicKey), null, 'wrong version')
  assert.equal(verifyPass(signPass(fields({ kind: 'robot' }), keys.privateKey), keys.publicKey), null, 'unknown kind')
  assert.equal(verifyPass(signPass(fields({ name: 'x'.repeat(65) }), keys.privateKey), keys.publicKey), null, 'name too long')
  assert.equal(verifyPass(signPass(fields({ key: 'nope' }), keys.privateKey), keys.publicKey), null, 'not a key')
  for (const junk of ['', 'abc', 'a.b.c', '.', null, undefined]) assert.equal(verifyPass(junk, keys.publicKey), null, String(junk))
  assert.equal(readPass('not a pass'), null)
})

test('a pass is checked against the time it is given', () => {
  const pass = signPass(fields({ exp: 2000 }), keys.privateKey)
  assert.ok(verifyPass(pass, keys.publicKey, { now: 1999 }))
  assert.equal(verifyPass(pass, keys.publicKey, { now: 2000 }), null)
})
```

Create `test/api-passes.test.js`:

```js
// POST /v1/passes: a linked computer or a signed-in agent swaps its token for a
// short-lived pass the relay checks.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, makeAgent, linkDevice } from './api-helpers.js'
import { newPassKeys, verifyPass, PASS_TTL_MS } from '../src/passes.js'
import { generateIdentity } from '../src/identity.js'

const KEYS = newPassKeys()
let t
before(async () => { t = await startTestApi({ passKey: KEYS.privateKey }) })
after(() => t.close())
const passFor = (bearer, via = t) => via.call('POST', '/v1/passes', null, null, bearer ? { authorization: `Bearer ${bearer}` } : {})

test("a linked computer gets a pass for its account, name and key", async () => {
  const { token, identity } = await linkDevice(t, 'mem')
  const r = await passFor(token)
  assert.equal(r.status, 200)
  const p = verifyPass(r.body.pass, KEYS.publicKey)
  assert.deepEqual(p, { v: 1, sub: 'mem', kind: 'person', name: 'Mo', key: identity.publicKey, exp: r.body.expiresAt })
  assert.deepEqual(Object.keys(p).sort(), ['exp', 'key', 'kind', 'name', 'sub', 'v'], 'no team fields yet')
  const left = r.body.expiresAt - Date.now()
  assert.ok(left > PASS_TTL_MS - 5000 && left <= PASS_TTL_MS, `expires in ${left} ms`)
})

test('an agent gets a pass with the key it registered when it joined', async () => {
  const identity = generateIdentity()
  const { agent, accessKey } = await makeAgent(t, { name: 'Larry', publicKey: identity.publicKey, ownerUserId: 'mem' })
  const r = await passFor(accessKey)
  assert.equal(r.status, 200)
  assert.deepEqual(verifyPass(r.body.pass, KEYS.publicKey), { v: 1, sub: agent.id, kind: 'agent', name: 'Larry', key: identity.publicKey, exp: r.body.expiresAt })
})

test('an agent with no registered key is told to be invited again', async () => {
  const { accessKey } = await makeAgent(t, { name: 'Keyless', ownerUserId: 'mem' })
  const r = await passFor(accessKey)
  assert.equal(r.status, 409)
  assert.equal(r.body.error, 'This agent has no key. Invite it again.')
})

test('unknown, revoked and expired tokens get 401', async () => {
  for (const bad of [null, 'qd_nope', 'qa_nope', 'something']) assert.equal((await passFor(bad)).status, 401, String(bad))
  const { token } = await linkDevice(t, 'mem')
  await t.call('POST', '/v1/me/signout', {}, null, { authorization: `Bearer ${token}` })
  assert.equal((await passFor(token)).status, 401, 'signed-out computer')
  const revoked = await makeAgent(t, { name: 'Gone', publicKey: generateIdentity().publicKey, ownerUserId: 'mem' })
  await t.store.revokeAgent(revoked.agent.id)
  assert.equal((await passFor(revoked.accessKey)).status, 401, 'revoked agent')
  const stale = await makeAgent(t, { name: 'Stale', publicKey: generateIdentity().publicKey, ownerUserId: 'mem', accessTtl: -1000 })
  assert.equal((await passFor(stale.accessKey)).status, 401, 'expired access key')
})

test('each token gets 60 passes a minute', async () => {
  const { token } = await linkDevice(t, 'admin')
  for (let i = 0; i < 60; i++) assert.equal((await passFor(token)).status, 200, `pass ${i + 1}`)
  const over = await passFor(token)
  assert.equal(over.status, 429)
  assert.equal(over.body.error, 'too many passes; try again in a minute')
  const other = await linkDevice(t, 'admin')
  assert.equal((await passFor(other.token)).status, 200, 'another token has its own limit')
})

test('the public key is published, and an API without a pass key says passes are not set up', async () => {
  assert.deepEqual((await t.call('GET', '/v1/passes/key')).body, { publicKey: KEYS.publicKey })
  const bare = await startTestApi()
  try {
    const { token } = await linkDevice(bare, 'mem')
    const r = await passFor(token, bare)
    assert.equal(r.status, 503)
    assert.equal(r.body.error, 'passes are not set up on this server')
    assert.equal((await bare.call('GET', '/v1/passes/key')).status, 503)
  } finally { await bare.close() }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/passes.test.js test/api-passes.test.js`
Expected: FAIL with `Cannot find module '…/src/passes.js'`.

- [ ] **Step 3: Write `src/passes.js`**

```js
// Session passes: short-lived tickets the accounts API signs and the relay checks.
// A pass says who you are (an account or an agent), your name, and the identity
// key you'll prove when you connect. Its format is
// base64url(JSON payload) + "." + base64url(Ed25519 signature of the first part).
import crypto from 'node:crypto'
import { generateIdentity, parsePublicKey } from './identity.js'

export const PASS_VERSION = 1
export const PASS_TTL_MS = 10 * 60 * 1000
const MAX_NAME = 64
const KINDS = ['person', 'agent']

/** A new signing pair, encoded like identity keys: SPKI and PKCS8 DER, in base64url. */
export function newPassKeys () {
  return generateIdentity()
}

const privateKeyOf = (k) => typeof k === 'string' ? crypto.createPrivateKey({ key: Buffer.from(k, 'base64url'), format: 'der', type: 'pkcs8' }) : k
const publicKeyOf = (k) => typeof k === 'string' ? parsePublicKey(k) : k

/** The public half of a PASS_SIGNING_KEY, as QUILT_PASS_PUBLIC_KEY takes it. */
export function passPublicKey (signingKey) {
  return crypto.createPublicKey(privateKeyOf(signingKey)).export({ type: 'spki', format: 'der' }).toString('base64url')
}

export function signPass (payload, signingKey) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.sign(null, Buffer.from(body), privateKeyOf(signingKey)).toString('base64url')
  return `${body}.${sig}`
}

/** A pass's payload without checking it (clients read their name from it). Null if malformed. */
export function readPass (pass) {
  const [body, sig, extra] = String(pass ?? '').split('.')
  if (!body || !sig || extra !== undefined) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return p && typeof p === 'object' && !Array.isArray(p) ? p : null
  } catch { return null }
}

/**
 * The payload when the signature verifies, it's version 1, it hasn't expired and
 * its fields make sense; otherwise null.
 */
export function verifyPass (pass, key, { now = Date.now() } = {}) {
  const k = publicKeyOf(key)
  const p = readPass(pass)
  if (!k || !p) return null
  const [body, sig] = String(pass).split('.')
  let signed = false
  try { signed = crypto.verify(null, Buffer.from(body), k, Buffer.from(sig, 'base64url')) } catch {}
  if (!signed || p.v !== PASS_VERSION) return null
  if (typeof p.exp !== 'number' || p.exp <= now) return null
  if (typeof p.sub !== 'string' || !p.sub || !KINDS.includes(p.kind)) return null
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > MAX_NAME) return null
  if (typeof p.key !== 'string' || !parsePublicKey(p.key)) return null
  return p
}
```

- [ ] **Step 4: Add the routes to the API**

In `src/api/server.js`, add to the imports:

```js
import { signPass, passPublicKey, PASS_VERSION, PASS_TTL_MS } from '../passes.js'
```

Add `passKey = '', passLimit = 60` to the `startApi({ … })` options (after `maxStartKeys = 10_000`). As the first lines inside `startApi`, before `const site = …`:

```js
  // PASS_SIGNING_KEY. A bad one should stop the API at start, not fail every pass later.
  if (passKey) passPublicKey(passKey)
```

After `const limitJoin = makeLimiter(…)` add:

```js
  // Passes, per token (keyed on its hash, counted once the token checks out).
  const limitPasses = makeLimiter(passLimit, 'too many passes; try again in a minute', { keyOf: (tokenHash) => tokenHash })
```

After `const agentAuth = makeAgentAuth({ store, now, bearer })` add:

```js
  /** Who a pass is for: a linked computer's account, or an agent and the key it registered. */
  async function passHolder (req) {
    if (bearer(req).startsWith('qa_')) {
      const { agent } = await agentAuth.agentFromRequest(req)
      if (!agent.publicKey) throw new HttpError(409, 'This agent has no key. Invite it again.')
      return { sub: agent.id, kind: 'agent', name: agent.name.slice(0, 64), key: agent.publicKey }
    }
    const d = await device(req)
    const p = await store.profile(d.userId)
    return { sub: d.userId, kind: 'person', name: ((p && p.name) || 'Quilt user').slice(0, 64), key: d.publicKey }
  }
  const needPassKey = () => { if (!passKey) throw new HttpError(503, 'passes are not set up on this server') }
```

Add these two routes to the `routes` array, right after the `POST /v1/me/signout` route:

```js
    // A pass lets its holder into sessions on the relay for 10 minutes (see src/passes.js).
    ['POST', /^\/v1\/passes$/, async (req) => {
      needPassKey()
      const holder = await passHolder(req)
      limitPasses(hashToken(bearer(req)))
      const exp = now() + PASS_TTL_MS
      return { pass: signPass({ v: PASS_VERSION, ...holder, exp }, passKey), expiresAt: exp }
    }],

    // The relay's QUILT_PASS_PUBLIC_KEY. Public: it only checks passes.
    ['GET', /^\/v1\/passes\/key$/, async () => {
      needPassKey()
      return { publicKey: passPublicKey(passKey) }
    }],
```

- [ ] **Step 5: Test helpers, the CLI and the key script**

In `test/api-helpers.js`, add `generateIdentity` to the imports:

```js
import { generateIdentity } from '../src/identity.js'
```

change the first line of `makeAgent`'s body and its options to take a key:

```js
export async function makeAgent (t, { name = 'Larry', provider = 'Anthropic', type = 'coding agent', description = '', publicKey = null, ownerUserId = null, orgId = null, invitedBy = 'owner', accessTtl = 60 * 60 * 1000, refreshTtl = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const agent = await t.store.createAgent({ name, provider, type, description, publicKey, ownerUserId, orgId, invitedBy })
```

and add at the end of the file:

```js
/** A computer linked to `userId`, made straight through the store: its identity and its qd_ token. */
export async function linkDevice (t, userId, identity = generateIdentity()) {
  const device = await t.store.upsertDevice({ userId, name: 'Mac', platform: 'darwin', publicKey: identity.publicKey })
  const token = newToken('qd_')
  await t.store.setDeviceToken(device.id, hashToken(token))
  return { device, token, identity }
}
```

In `bin/quilt.js` `apiCmd`, add `'PASS_SIGNING_KEY'` to the list of required variables:

```js
    for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'QUILT_SITE_URL', 'SMTP_URL', 'SMTP_FROM', 'PASS_SIGNING_KEY']) if (!env[k]) fail(`${k} is not set`)
```

Before `// In memory anyone may use "Bearer local"…` add:

```js
  let passKey = env.PASS_SIGNING_KEY || ''
  if (values.memory && !passKey) {
    const { newPassKeys } = await import('../src/passes.js')
    const keys = newPassKeys()
    passKey = keys.privateKey
    console.log(`pass signing key made for this run; start a local relay with QUILT_PASS_PUBLIC_KEY=${keys.publicKey}`)
  }
```

and pass it to `startApi`: add `passKey,` to the `startApi({ … })` call after `port, host, store, verifyUser, mailer,`.

Create `scripts/pass-keys.mjs`:

```js
// Makes the accounts API's pass signing key. It prints only the line
// `fly secrets import` reads, so the private key goes straight into Fly and
// never onto a screen:
//   node scripts/pass-keys.mjs | fly secrets import --app quilt-api --stage
// The public half is printed to stderr, and once deployed the API serves it at
// /v1/passes/key for the relay's QUILT_PASS_PUBLIC_KEY.
import { newPassKeys } from '../src/passes.js'

const { privateKey, publicKey } = newPassKeys()
process.stdout.write(`PASS_SIGNING_KEY=${privateKey}\n`)
process.stderr.write(`public key (QUILT_PASS_PUBLIC_KEY): ${publicKey}\n`)
```

In `scripts/api-smoke.mjs`, after the `ok((await call('GET', '/v1/me', null, tok)).b?.profile?.id, 'me')` line add:

```js
ok((await call('POST', '/v1/passes', null, tok)).b?.pass, 'pass for this computer')
ok((await call('GET', '/v1/passes/key')).b?.publicKey, 'pass public key published')
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/passes.test.js test/api-passes.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/passes.js src/api/server.js bin/quilt.js scripts/pass-keys.mjs scripts/api-smoke.mjs test/api-helpers.js test/passes.test.js test/api-passes.test.js
git commit -m "Accounts API signs 10-minute session passes for computers and agents"
```

---
### Task 3: The relay checks passes (only when `QUILT_PASS_PUBLIC_KEY` is set)

**Files:**
- Modify: `src/protocol.js` (two constants)
- Modify: `src/server.js` (imports, `relayConfig`, `Room.accessFor`, `Room.memberList`, `Room.admit`, `startServer`: pass key, limiter key, HTTP routes, upgrade handler, two helpers and two messages)
- Modify: `bin/quilt.js` (`serve` output)
- Create: `test/pass-helpers.js`, `test/relay-passes.test.js`

**Interfaces:**
- Consumes: `verifyPass(pass, key)` and `signPass`, `newPassKeys`, `PASS_TTL_MS` from Task 2; `parsePublicKey` from `src/identity.js`.
- Produces:
  - `MSG_PASS = 16` (client → relay, JSON `{ pass }`), `CLOSE_PASS_EXPIRED = 4419` in `src/protocol.js`
  - `relayConfig({ passPublicKey })` → `{ …, passPublicKey: string, relayKey: '' when passPublicKey is set }`; `startServer({ passPublicKey })` throws `QUILT_PASS_PUBLIC_KEY is not an Ed25519 public key (spki, base64url)` for a bad key.
  - Relay messages: `Update Quilt and sign in to continue` (401 on upgrade and HTTP), close 4419 `Your sign-in expired. Reconnecting.`
  - Test helpers in `test/pass-helpers.js`: `PASS_KEYS` (`newPassKeys()` for the test run), `makePass({ identity, name = 'Dana', kind = 'person', sub = 'user-dana', exp, v = 1, keys = PASS_KEYS }): string`.

- [ ] **Step 1: Write the test helper and the failing tests**

Create `test/pass-helpers.js`:

```js
// Test passes, signed with a key made for this test run, so relay and session
// tests never need the accounts API.
import { newPassKeys, signPass, PASS_TTL_MS } from '../src/passes.js'

export const PASS_KEYS = newPassKeys()

/** A pass for `identity`, like the API would sign it (any field can be overridden). */
export function makePass ({ identity, name = 'Dana', kind = 'person', sub = 'user-dana', exp = Date.now() + PASS_TTL_MS, v = 1, keys = PASS_KEYS }) {
  return signPass({ v, sub, kind, name, key: identity.publicKey, exp }, keys.privateKey)
}
```

Create `test/relay-passes.test.js`:

```js
// The relay with sign-in on: every connection and session request needs a pass
// signed by the accounts API, and the relay takes who you are from it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { startServer, relayConfig } from '../src/server.js'
import { generateIdentity, signChallenge } from '../src/identity.js'
import { MSG_AUTH, MSG_ACCESS, MSG_MEMBERS, MSG_PASS, CLOSE_PASS_EXPIRED, decoding, bytesMessage, jsonMessage } from '../src/protocol.js'
import { newPassKeys } from '../src/passes.js'
import { PASS_KEYS, makePass } from './pass-helpers.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-rp-home-'))
const SIGN_IN = 'Update Quilt and sign in to continue'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
let rooms = 0
const room = () => `rp-${++rooms}`

async function relay (t, opts = {}) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: PASS_KEYS.publicKey, ...opts })
  t.after(() => srv.close())
  return srv
}

/**
 * Connects the way the app does: signs the relay's challenge, then records what
 * the relay says. Resolves once let in (or told to wait for the owner), or with
 * { status, reason } when the upgrade is refused.
 */
function connect (srv, r, { identity = generateIdentity(), pass, secret = 's', name = 'url-name', kind = 'human', viewSecret } = {}) {
  const q = new URLSearchParams({ secret, name, key: identity.publicKey, kind, features: 'large-files' })
  if (pass) q.set('pass', pass)
  if (viewSecret) q.set('viewSecret', viewSecret)
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/${r}?${q}`)
  ws.binaryType = 'arraybuffer'
  const c = { ws, access: [], members: [] }
  c.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })))
  return new Promise((resolve) => {
    ws.on('unexpected-response', (req, res) => resolve({ status: res.statusCode, reason: res.statusMessage }))
    ws.on('error', () => {})
    ws.on('message', (data) => {
      const dec = decoding.createDecoder(new Uint8Array(data))
      const type = decoding.readVarUint(dec)
      if (type === MSG_AUTH) ws.send(bytesMessage(MSG_AUTH, signChallenge(identity, r, decoding.readVarUint8Array(dec))))
      else if (type === MSG_ACCESS) { c.access.push(JSON.parse(decoding.readVarString(dec))); resolve(c) } else if (type === MSG_MEMBERS) c.members.push(JSON.parse(decoding.readVarString(dec)))
    })
  })
}
const refresh = (c, pass) => c.ws.send(jsonMessage(MSG_PASS, { pass }))
const http = (srv, p, init) => fetch(`http://127.0.0.1:${srv.port}${p}`, init)

test('a valid pass lets you in, under the name and kind it carries', async (t) => {
  const srv = await relay(t)
  const r = room()
  const identity = generateIdentity()
  const c = await connect(srv, r, { identity, pass: makePass({ identity, name: 'Dana' }), name: 'mallory' })
  assert.equal(c.access[0].state, 'approved')
  const bot = generateIdentity()
  await connect(srv, r, { identity: bot, pass: makePass({ identity: bot, name: 'helper', kind: 'agent', sub: 'agent-1' }), kind: 'human' })
  const rm = srv.rooms.get(r)
  assert.deepEqual([...rm.names.values()].sort(), ['Dana', 'helper'])
  assert.deepEqual([...rm.access.values()].map((a) => [a.name, a.kind]).sort(), [['Dana', 'human'], ['helper', 'agent']])
})

test("missing, expired, forged, wrong-version and someone else's passes are refused", async (t) => {
  const srv = await relay(t)
  const identity = generateIdentity()
  const bad = {
    missing: undefined,
    expired: makePass({ identity, exp: Date.now() - 1 }),
    forged: makePass({ identity, keys: newPassKeys() }),
    'wrong version': makePass({ identity, v: 2 }),
    'for another key': makePass({ identity: generateIdentity() }),
    garbage: 'not.a-pass'
  }
  for (const [why, pass] of Object.entries(bad)) {
    const res = await connect(srv, room(), { identity, pass })
    assert.equal(res.status, 401, why)
    assert.equal(res.reason, SIGN_IN, why)
  }
  assert.equal(srv.rooms.size, 0, 'refused before any room is loaded')
})

test('session HTTP routes need a pass in x-quilt-pass', async (t) => {
  const srv = await relay(t)
  const identity = generateIdentity()
  const r = room()
  const pass = makePass({ identity })
  const upload = (headers) => http(srv, `/files/${r}`, { method: 'POST', headers: { 'x-quilt-secret': 's', ...headers }, body: 'hi' })
  const none = await upload({})
  assert.equal(none.status, 401)
  assert.equal(await none.text(), SIGN_IN)
  assert.equal((await upload({ 'x-quilt-pass': makePass({ identity, exp: Date.now() - 1 }) })).status, 401)
  const ok = await upload({ 'x-quilt-pass': pass })
  assert.equal(ok.status, 201)
  const id = await ok.text()
  assert.equal((await http(srv, `/files/${r}/${id}`, { headers: { 'x-quilt-secret': 's' } })).status, 401)
  assert.equal(await (await http(srv, `/files/${r}/${id}`, { headers: { 'x-quilt-secret': 's', 'x-quilt-pass': pass } })).text(), 'hi')

  const blob = (headers) => http(srv, `/blobs/${r}/${'a'.repeat(32)}/upload`, { method: 'POST', headers: { 'x-quilt-secret': 's', 'content-type': 'application/json', ...headers }, body: JSON.stringify({ size: 4 }) })
  assert.equal((await blob({})).status, 401)
  assert.equal((await blob({ 'x-quilt-pass': pass })).status, 200)

  const link = (headers) => http(srv, '/agent/link', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ token: 'tok_' + 'a'.repeat(30), room: r, secret: 's', name: 'x' }) })
  assert.equal((await link({})).status, 401)
  assert.equal((await link({ 'x-quilt-pass': pass })).status, 200)
})

test('a pass that runs out closes the connection with 4419', async (t) => {
  const srv = await relay(t)
  const identity = generateIdentity()
  const c = await connect(srv, room(), { identity, pass: makePass({ identity, exp: Date.now() + 400 }) })
  assert.deepEqual(await c.closed, { code: CLOSE_PASS_EXPIRED, reason: 'Your sign-in expired. Reconnecting.' })
})

test("a fresh pass in MSG_PASS keeps a connection open; someone else's pass does not", async (t) => {
  const srv = await relay(t)
  const r = room()
  const dana = generateIdentity()
  const kept = await connect(srv, r, { identity: dana, pass: makePass({ identity: dana, exp: Date.now() + 500 }) })
  refresh(kept, makePass({ identity: dana, exp: Date.now() + 60_000 }))
  const eli = generateIdentity()
  const swapped = await connect(srv, r, { identity: eli, pass: makePass({ identity: eli, sub: 'user-eli', name: 'Eli', exp: Date.now() + 500 }) })
  refresh(swapped, makePass({ identity: dana, exp: Date.now() + 60_000 })) // Dana's pass on Eli's connection
  assert.equal((await swapped.closed).code, CLOSE_PASS_EXPIRED)
  assert.equal(kept.ws.readyState, WebSocket.OPEN, 'the refreshed connection is still open')
})

test('someone waiting for the owner can refresh their pass too', async (t) => {
  const srv = await relay(t)
  const r = room()
  const owner = generateIdentity()
  await connect(srv, r, { identity: owner, pass: makePass({ identity: owner, name: 'Olive', sub: 'user-olive' }), viewSecret: 'v' })
  const guest = generateIdentity()
  const g = await connect(srv, r, { identity: guest, pass: makePass({ identity: guest, name: 'Gus', sub: 'user-gus', exp: Date.now() + 500 }) })
  assert.equal(g.access[0].state, 'pending')
  refresh(g, makePass({ identity: guest, name: 'Gus', sub: 'user-gus', exp: Date.now() + 60_000 }))
  await wait(800)
  assert.equal(g.ws.readyState, WebSocket.OPEN)
})

test('the owner sees account names and agent badges', async (t) => {
  const srv = await relay(t)
  const r = room()
  const owner = generateIdentity()
  const o = await connect(srv, r, { identity: owner, pass: makePass({ identity: owner, name: 'Olive', sub: 'user-olive' }), viewSecret: 'v', name: 'olive-laptop' })
  const bot = generateIdentity()
  await connect(srv, r, { identity: bot, pass: makePass({ identity: bot, name: 'helper', kind: 'agent', sub: 'agent-1' }), name: 'pretend-human' })
  const msg = await waitFor(() => o.members.find((m) => m.pending && m.pending.length))
  assert.deepEqual(msg.pending.map((p) => [p.name, p.kind]), [['helper', 'agent']])
  assert.deepEqual(msg.members.map((m) => [m.name, m.role]), [['Olive', 'owner']])
})

test('new sessions are limited per account, not per address', async (t) => {
  const srv = await relay(t, { maxNewRoomsPerHour: 2 })
  const dana = generateIdentity()
  const asDana = () => makePass({ identity: dana })
  assert.equal((await connect(srv, room(), { identity: dana, pass: asDana() })).access[0].state, 'approved')
  assert.equal((await connect(srv, room(), { identity: dana, pass: asDana() })).access[0].state, 'approved')
  assert.equal((await connect(srv, room(), { identity: dana, pass: asDana() })).status, 429)
  const files = await http(srv, `/files/${room()}`, { method: 'POST', headers: { 'x-quilt-secret': 's', 'x-quilt-pass': asDana() }, body: 'x' })
  assert.equal(files.status, 429)
  const eli = generateIdentity()
  const other = await connect(srv, room(), { identity: eli, pass: makePass({ identity: eli, sub: 'user-eli', name: 'Eli' }) })
  assert.equal(other.access[0].state, 'approved', 'another account on the same address can still start one')
})

test('with passes on the relay key is not used, and a bad public key stops the relay', async (t) => {
  assert.equal(relayConfig({ relayKey: 'k', passPublicKey: PASS_KEYS.publicKey }).relayKey, '')
  assert.equal(relayConfig({ relayKey: 'k' }).relayKey, 'k')
  assert.throws(() => startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: 'nope' }), /QUILT_PASS_PUBLIC_KEY/)
  const srv = await relay(t, { relayKey: 'k' })
  const identity = generateIdentity()
  assert.equal((await connect(srv, room(), { identity, pass: makePass({ identity }) })).access[0].state, 'approved', 'no relay key needed')
})

test('without QUILT_PASS_PUBLIC_KEY the relay works as before', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  t.after(() => srv.close())
  const r = room()
  const c = await connect(srv, r, { name: 'plain' })
  assert.equal(c.access[0].state, 'approved')
  assert.deepEqual([...srv.rooms.get(r).names.values()], ['plain'])
  assert.equal((await http(srv, `/files/${r}`, { method: 'POST', headers: { 'x-quilt-secret': 's' }, body: 'x' })).status, 201)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/relay-passes.test.js`
Expected: FAIL. The import of `MSG_PASS` / `CLOSE_PASS_EXPIRED` fails with `does not provide an export named 'CLOSE_PASS_EXPIRED'`.

- [ ] **Step 3: Add the protocol constants**

In `src/protocol.js`, after `export const MSG_MEMBERS = 15 …` add:

```js
export const MSG_PASS = 16 // client -> relay: JSON { pass }: a fresh session pass, sent at least every 5 minutes
```

and after `export const CLOSE_ENDED = 4410 …` add:

```js
// The connection's session pass ran out without a new one. Clients reconnect with a fresh pass.
export const CLOSE_PASS_EXPIRED = 4419
```

- [ ] **Step 4: Check passes in the relay**

In `src/server.js`:

1. Add `MSG_PASS` to the message import line and `CLOSE_PASS_EXPIRED` to the close-code import line:

```js
import {
  MSG_SYNC, MSG_AWARENESS, MSG_QUERY_AWARENESS, MSG_AUTH, MSG_CLAIM, MSG_CLAIMS, MAX_SHARED_FILE_BYTES,
  MSG_ACCESS, MSG_ADMIN, MSG_MEMBERS, MSG_PASS,
  CLOSE_AUTH_FAILED, CLOSE_NAME_TAKEN, CLOSE_ROOM_FULL, CLOSE_DENIED, CLOSE_ENDED, CLOSE_NEEDS_UPDATE, CLOSE_PASS_EXPIRED,
  encoding, decoding, syncProtocol, awarenessProtocol,
  syncStep1Message, updateMessage, awarenessMessage, bytesMessage, jsonMessage
} from './protocol.js'
import { parsePublicKey, verifyChallenge } from './identity.js'
import { verifyPass } from './passes.js'
```

2. In `relayConfig`, compute the pass key first and use it for `relayKey`. Replace `return {` and the `relayKey` line with:

```js
  // The accounts API's public key. With it, every connection needs a pass (see passes.js).
  const passPublicKey = opts.passPublicKey ?? env.QUILT_PASS_PUBLIC_KEY ?? ''
  return {
    passPublicKey,
    // With passes on, the accounts API decides who may start sessions: the relay key isn't used.
    relayKey: passPublicKey ? '' : (opts.relayKey ?? env.QUILT_RELAY_KEY ?? ''),
```

3. In `Room.accessFor`, keep the owner's current name. Replace its owner lines:

```js
    if (!this.meta.owner) { this.meta.owner = key; this.saveMeta() } // the room's creator signs in first
    if (this.meta.owner === key) return { state: 'approved', role: 'editor', scopes: [], owner: true }
```

with:

```js
    if (!this.meta.owner) { this.meta.owner = key; this.saveMeta() } // the room's creator signs in first
    if (this.meta.owner === key) {
      // Names come from accounts and can change: show the owner by the name they use now.
      if (this.meta.ownerName !== name) { this.meta.ownerName = name; this.saveMeta() }
      return { state: 'approved', role: 'editor', scopes: [], owner: true }
    }
```

4. In `Room.memberList`, replace the `const ownerName = …` line with:

```js
      const ownerName = this.meta.ownerName || Object.entries(this.meta.identities).find(([, k]) => k === this.meta.owner)?.[0] || 'owner'
```

5. In `Room.admit`, make the start of the message handler accept a pass refresh before anything else:

```js
    ws.on('message', (data) => {
      const buf = new Uint8Array(data)
      // A fresh pass may come at any time, even while waiting for the owner.
      // (MSG_PASS is under 128, so it is the whole first byte.)
      if (ws.pass && buf[0] === MSG_PASS) {
        if (!renewPass(ws, buf)) this.log(`[${this.name}] ignored a pass refresh from ${name} that wasn't theirs`)
        return
      }
      if (joined || this.access.has(ws)) {
```

(the rest of the handler is unchanged).

6. Add these module-level helpers and messages next to `nameTaken` (after `const nameTaken = …`):

```js
/** Closes the connection when its pass runs out, unless a newer one arrives first. */
function trackPass (ws, pass) {
  ws.pass = pass
  clearTimeout(ws.passTimer)
  const left = Math.min(Math.max(pass.exp - Date.now(), 0), 2 ** 31 - 1)
  ws.passTimer = setTimeout(() => ws.close(CLOSE_PASS_EXPIRED, PASS_EXPIRED), left)
}

/** A MSG_PASS: a valid pass for the same account (or agent) and key extends the connection. */
function renewPass (ws, buf) {
  let next = null
  try {
    const dec = decoding.createDecoder(buf)
    decoding.readVarUint(dec)
    next = verifyPass(String(JSON.parse(decoding.readVarString(dec)).pass || ''), ws.passKey)
  } catch {}
  if (!next || next.sub !== ws.pass.sub || next.kind !== ws.pass.kind || next.key !== ws.pass.key) return false
  trackPass(ws, next)
  return true
}
```

and next to `const NEEDS_UPDATE = …` at the bottom:

```js
const SIGN_IN = 'Update Quilt and sign in to continue'
const PASS_EXPIRED = 'Your sign-in expired. Reconnecting.'
```

7. In `startServer`, right after `const cfg = relayConfig(opts)`:

```js
  const passKey = cfg.passPublicKey ? parsePublicKey(cfg.passPublicKey) : null
  if (cfg.passPublicKey && !passKey) throw new Error('QUILT_PASS_PUBLIC_KEY is not an Ed25519 public key (spki, base64url)')
  /** With sign-in on: the request's valid pass, or null. With it off: an empty pass. */
  const httpPass = (req) => passKey ? verifyPass(String(req.headers['x-quilt-pass'] || ''), passKey) : {}
```

and replace the new-room limiter's comment and parameter names (the logic is unchanged; its key is now an address or an account):

```js
  // New sessions are rate-limited per account when sign-in is on, otherwise per address.
  const newRooms = new Map() // starter -> creation timestamps in the last hour
  const canCreate = (starter) => {
    if (!cfg.maxNewRoomsPerHour) return true
    const cutoff = Date.now() - 60 * 60 * 1000
    const recent = (newRooms.get(starter) || []).filter((t) => t > cutoff)
    if (recent.length) newRooms.set(starter, recent); else newRooms.delete(starter)
    return recent.length < cfg.maxNewRoomsPerHour
  }
  const noteCreated = (starter) => newRooms.set(starter, [...(newRooms.get(starter) || []), Date.now()])
```

8. `/agent/link`: check the pass before reading the body, and name the link after it. Replace the start of the route and the `links.set` line:

```js
    if (url.pathname === '/agent/link' && req.method === 'POST') {
      const pass = httpPass(req)
      if (!pass) return text(401, SIGN_IN)
      return readJson(req, 4096, (err, body) => {
```

```js
        links.set(k, { room: roomName, name: (pass.name || name).trim().slice(0, 60), tool: String(tool || '').slice(0, 40), tabSeenAt: Date.now(), aiSeenAt: prev.aiSeenAt || 0 })
```

9. `/blobs` (upload and download only; the `data` branch stays signature-only). Replace from `if (req.method !== 'POST') return text(405, 'method not allowed')` down to `if (creating) noteCreated(clientIp(req))` with:

```js
      if (req.method !== 'POST') return text(405, 'method not allowed')
      const pass = httpPass(req)
      if (!pass) return text(401, SIGN_IN)
      const starter = pass.sub ? `sub:${pass.sub}` : clientIp(req)
      const room = getRoom(name)
      if (!room) return text(413, TOO_BIG)
      const creating = !room.exists
      if (creating && !canCreate(starter)) { dropIfUnused(room); return text(429, 'too many new sessions; try again later') }
      const auth = room.authorize(req.headers['x-quilt-secret'] || '', req.headers['x-quilt-key'] || '')
      if (auth === 'need-key' || auth === 'bad-secret') {
        dropIfUnused(room)
        return text(auth === 'need-key' ? 403 : 401, auth === 'need-key' ? 'this relay needs a key to create rooms' : 'wrong room secret')
      }
      if (creating) noteCreated(starter)
```

10. `/files`: replace from `const [, name, id] = m` down to `if (creating && auth !== 'need-key' && auth !== 'bad-secret') noteCreated(clientIp(req))` with:

```js
    const [, name, id] = m
    if (roomEnded(name)) return text(410, ENDED_MESSAGE)
    const pass = httpPass(req)
    if (!pass) return text(401, SIGN_IN)
    const starter = pass.sub ? `sub:${pass.sub}` : clientIp(req)
    const room = getRoom(name)
    if (!room) return text(413, TOO_BIG)
    const creating = !room.exists
    if (creating && !canCreate(starter)) { dropIfUnused(room); return text(429, 'too many new sessions; try again later') }
    const auth = room.authorize(req.headers['x-quilt-secret'] || req.headers['x-cowove-secret'] || '', req.headers['x-quilt-key'] || req.headers['x-cowove-key'] || '')
    if (creating && auth !== 'need-key' && auth !== 'bad-secret') noteCreated(starter)
```

11. Replace the whole `httpServer.on('upgrade', …)` handler with:

```js
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    const name = decodeURIComponent(url.pathname.slice(1))
    const secret = url.searchParams.get('secret') || ''
    const publicKey = url.searchParams.get('key') || ''
    const relayKey = url.searchParams.get('relayKey') || req.headers['x-quilt-key'] || req.headers['x-cowove-key'] || ''
    const viewSecret = url.searchParams.get('viewSecret') || ''
    if (!ROOM_RE.test(name)) return reject(socket, 400, 'Bad room name')
    // With sign-in on, nobody gets further without a pass, and who they are comes from it.
    const pass = passKey ? verifyPass(url.searchParams.get('pass') || '', passKey) : null
    if (passKey && (!pass || pass.key !== publicKey)) return reject(socket, 401, SIGN_IN)
    const person = pass ? pass.name : (url.searchParams.get('name') || '').trim()
    const kind = pass ? (pass.kind === 'agent' ? 'agent' : 'human') : (url.searchParams.get('kind') === 'agent' ? 'agent' : 'human')
    if (roomEnded(name)) return reject(socket, 410, ENDED_MESSAGE)
    const ip = clientIp(req)
    const starter = pass ? `sub:${pass.sub}` : ip
    if ((ipConns.get(ip) || 0) >= cfg.maxConnsPerIp) return reject(socket, 429, 'Too many connections')
    const room = getRoom(name)
    if (!room) return reject(socket, 413, TOO_BIG)
    const features = String(url.searchParams.get('features') || '').split(',')
    const creating = !room.exists
    if (creating && !canCreate(starter)) { dropIfUnused(room); return reject(socket, 429, 'Too many new sessions') }
    const auth = room.authorize(secret, relayKey, viewSecret)
    if (creating && auth !== 'need-key' && auth !== 'bad-secret') noteCreated(starter)
    if (auth === 'need-key' || auth === 'bad-secret') {
      dropIfUnused(room)
      return reject(socket, auth === 'need-key' ? 403 : 401, auth === 'need-key' ? 'Relay key required to create rooms' : 'Wrong room secret')
    }
    // Checked after the secret, so only members learn what the session needs.
    if (room.meta.largeFiles && !features.includes('large-files')) {
      if (!room.conns.size && room.onEmpty) room.onEmpty() // don't keep it in memory for nobody
      return reject(socket, 400, NEEDS_UPDATE)
    }
    if (!publicKey) return reject(socket, 400, 'This relay needs a newer quilt; please update')
    const key = parsePublicKey(publicKey)
    if (!person || person.length > MAX_NAME || !key) return reject(socket, 400, 'Bad name or identity key')
    if (!room.keyMatches(person, publicKey)) return reject(socket, 403, nameTaken(person))
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.features = features
      if (pass) { ws.passKey = passKey; trackPass(ws, pass) }
      ipConns.set(ip, (ipConns.get(ip) || 0) + 1)
      ws.isAlive = true
      ws.on('pong', () => { ws.isAlive = true })
      ws.on('close', () => {
        clearTimeout(ws.passTimer)
        const n = (ipConns.get(ip) || 1) - 1
        if (n) ipConns.set(ip, n)
        else ipConns.delete(ip)
      })
      room.admit(ws, person, publicKey, key, { kind, invitedAs: auth }, () => {
        log(`[${name}] ${person} connected (${room.conns.size} online)`)
        ws.on('close', () => log(`[${name}] ${person} left (${room.conns.size} online)`))
        if (room.full) log(`[${name}] ${person} joined while over quota (read-only)`)
      })
    })
  })
```

(The 429 messages change from "…from this address…" to "…; try again later", because the limit may now be per account.)

- [ ] **Step 5: Say how the relay runs**

In `bin/quilt.js` `serve`, replace the `new sessions:` line with:

```js
  console.log(`  sign-in: ${c.passPublicKey ? 'a pass from the accounts API is required; new sessions are limited per account' : 'off (set QUILT_PASS_PUBLIC_KEY to require it)'}`)
  if (!c.passPublicKey) console.log(`  new sessions: ${c.relayKey ? 'need the relay key' : 'open to anyone who can reach this relay (set QUILT_RELAY_KEY to restrict)'}`)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/relay-passes.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS. (`test/relay.test.js` and the other relay tests run without a pass key and are unchanged.)

- [ ] **Step 7: Commit**

```bash
git add src/protocol.js src/server.js bin/quilt.js test/pass-helpers.js test/relay-passes.test.js
git commit -m "Relay requires a session pass when QUILT_PASS_PUBLIC_KEY is set"
```

---
### Task 4: The account store, the device flow, and `quilt login` / `logout` / `whoami`

**Files:**
- Create: `src/private-file.js`
- Create: `src/account.js`
- Modify: `src/agent-join.js` (its `save` uses `writePrivateJson`)
- Modify: `src/api/server.js` (email in the profile from `/v1/device/poll` and `/v1/me`)
- Modify: `bin/quilt.js` (three commands, help)
- Create: `test/account.test.js`, `test/cli-account.test.js`

**Interfaces:**
- Consumes: `signDeviceLink` (Task 1), `quiltHome` from `src/legacy.js`.
- Produces (in `src/private-file.js`): `isSymlink(file): boolean`, `writePrivateJson(file, data): void` (throws `Refusing to write <file>: it's a symlink`).
- Produces (in `src/account.js`):
  - `API_URL = 'https://api.heyquilt.com'`, `apiUrl(): string` (`QUILT_API_URL` overrides), `accountFile(): string`
  - `NOT_SIGNED_IN = 'Run quilt login first.'`, `SIGNED_OUT = 'This computer was signed out. Sign in again.'`
  - `readAccount(file?): { token, account: { id, name, email }, signedInAt } | null`
  - `saveAccount(data, file?): data`, `clearAccount(file?): void`
  - `accountFromProfile(profile): { id, name, email }`
  - `startLink({ identity, api?, fetch? }): Promise<{ deviceCode, userCode, verificationUrl, interval, expiresIn }>`
  - `pollLink({ identity, deviceCode, api?, fetch? }): Promise<{ status: 'pending' } | { status: 'approved', token, profile }>` (throws with `.status`)
  - `waitForLink({ identity, link, api?, fetch?, stopped?, sleep?, now? }): Promise<{ status: 'approved', token, profile }>` (rejects with `.expired`, `.denied` or `.cancelled`)
  - `fetchMe({ token, api?, fetch? }): Promise<profile>` (throws with `.status`, 401 when revoked)
  - `signOut({ token, api?, fetch?, file? }): Promise<void>` (best-effort revoke, then deletes the file)
- Produces (API): the `profile` in `POST /v1/device/poll` (approved) and `GET /v1/me` has `email`.

- [ ] **Step 1: Write the failing tests**

Create `test/account.test.js`:

```js
// This computer's sign-in: account.json, and linking through the website.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestApi } from './api-helpers.js'
import { readAccount, saveAccount, clearAccount, startLink, pollLink, waitForLink, fetchMe, signOut, accountFromProfile } from '../src/account.js'
import { generateIdentity } from '../src/identity.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-account-'))
const sample = { token: 'qd_test', account: { id: 'mem', name: 'Mo', email: 'mo@acme.com' }, signedInAt: 1 }

test('account.json is written privately and atomically, and never through a symlink', () => {
  const dir = tmp()
  const file = path.join(dir, 'account.json')
  saveAccount(sample, file)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(readAccount(file), sample)
  assert.deepEqual(fs.readdirSync(dir), ['account.json'], 'no temp files left behind')

  const target = path.join(dir, 'elsewhere.json')
  fs.writeFileSync(target, '{}')
  const link = path.join(dir, 'linked.json')
  fs.symlinkSync(target, link)
  assert.throws(() => saveAccount(sample, link), /symlink/)
  assert.equal(fs.readFileSync(target, 'utf8'), '{}', 'the target was not written')
  fs.writeFileSync(target, JSON.stringify(sample))
  assert.equal(readAccount(link), null, 'a symlinked account.json is not trusted')

  clearAccount(file)
  assert.equal(readAccount(file), null)
  fs.writeFileSync(file, 'not json')
  assert.equal(readAccount(file), null)
})

test('linking this computer: start, approve on the website, collect the token and profile, sign out', async () => {
  const identity = generateIdentity()
  const link = await startLink({ identity, api: t.api.url })
  assert.match(link.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  assert.equal((await pollLink({ identity, deviceCode: link.deviceCode, api: t.api.url })).status, 'pending')
  await t.call('POST', '/v1/device/approve', { userCode: link.userCode, approve: true }, 'mem')
  const r = await waitForLink({ identity, link: { ...link, interval: 0 }, api: t.api.url })
  assert.match(r.token, /^qd_/)
  assert.deepEqual(accountFromProfile(r.profile), { id: 'mem', name: 'Mo', email: 'mo@acme.com' })
  assert.equal((await fetchMe({ token: r.token, api: t.api.url })).email, 'mo@acme.com')

  const file = path.join(tmp(), 'account.json')
  saveAccount({ token: r.token, account: accountFromProfile(r.profile), signedInAt: Date.now() }, file)
  await signOut({ token: r.token, api: t.api.url, file })
  assert.equal(fs.existsSync(file), false)
  await assert.rejects(fetchMe({ token: r.token, api: t.api.url }), (err) => err.status === 401)
})

test('a declined or expired link ends the wait clearly', async () => {
  const identity = generateIdentity()
  const declined = await startLink({ identity, api: t.api.url })
  await t.call('POST', '/v1/device/approve', { userCode: declined.userCode, approve: false }, 'mem')
  await assert.rejects(waitForLink({ identity, link: { ...declined, interval: 0 }, api: t.api.url }), (err) => err.denied === true)
  const expired = await startLink({ identity, api: t.api.url })
  let clock = Date.now()
  await assert.rejects(waitForLink({ identity, link: { ...expired, interval: 0 }, api: t.api.url, now: () => (clock += 60_000) }), (err) => err.expired === true)
  let stop = false
  const cancelled = waitForLink({ identity, link: { ...expired, interval: 0 }, api: t.api.url, stopped: () => stop })
  stop = true
  await assert.rejects(cancelled, (err) => err.cancelled === true)
})

test('signing out forgets the token even when Quilt cannot be reached', async () => {
  const file = path.join(tmp(), 'account.json')
  saveAccount(sample, file)
  await signOut({ token: sample.token, api: 'http://127.0.0.1:9', file })
  assert.equal(fs.existsSync(file), false)
})
```

Create `test/cli-account.test.js`:

```js
// quilt login / whoami / logout, against a local accounts API.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startTestApi, SITE } from './api-helpers.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'quilt.js')
let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-cli-account-'))
async function waitFor (fn, ms = 10000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((resolve) => setTimeout(resolve, 50)) }
  throw new Error('timed out')
}
/** Runs the CLI in the background: what it printed so far, and its exit code when done. */
function run (args, env) {
  const child = spawn(process.execPath, [BIN, ...args], { env })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  return { out: () => out, done: new Promise((resolve) => child.on('exit', resolve)) }
}
const quilt = (args, env) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })

test('quilt login links this computer, whoami shows the account, logout signs it out', async () => {
  const home = tmp()
  const env = { ...process.env, HOME: home, QUILT_API_URL: t.api.url }
  const login = run(['login', '--no-browser'], env)
  const code = await waitFor(() => (login.out().match(/code ([A-Z0-9]{4}-[A-Z0-9]{4})/) || [])[1])
  assert.ok(login.out().includes(`${SITE}/link?code=${code}`), login.out())
  await t.call('POST', '/v1/device/approve', { userCode: code, approve: true }, 'mem')
  assert.equal(await login.done, 0, login.out())
  assert.match(login.out(), /Signed in as Mo \(mo@acme\.com\)\./)

  const file = path.join(home, '.quilt', 'account.json')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(saved.account, { id: 'mem', name: 'Mo', email: 'mo@acme.com' })
  assert.match(saved.token, /^qd_/)
  assert.equal(typeof saved.signedInAt, 'number')

  assert.equal(quilt(['whoami'], env).stdout.trim(), 'Mo (mo@acme.com)')
  assert.match(quilt(['login', '--no-browser'], env).stdout, /Already signed in as Mo/)
  assert.match(quilt(['logout'], env).stdout, /Signed out of mo@acme\.com\./)
  assert.equal(fs.existsSync(file), false)
  assert.equal((await t.call('GET', '/v1/me', null, null, { authorization: `Bearer ${saved.token}` })).status, 401, 'the token was revoked')
  const who = quilt(['whoami'], env)
  assert.equal(who.status, 1)
  assert.equal(who.stdout.trim(), 'Not signed in')
})

test('a sign-in declined in the browser says so', async () => {
  const env = { ...process.env, HOME: tmp(), QUILT_API_URL: t.api.url }
  const login = run(['login', '--no-browser'], env)
  const code = await waitFor(() => (login.out().match(/code ([A-Z0-9]{4}-[A-Z0-9]{4})/) || [])[1])
  await t.call('POST', '/v1/device/approve', { userCode: code, approve: false }, 'mem')
  assert.equal(await login.done, 1)
  assert.match(login.out(), /Sign-in was declined in the browser\./)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/account.test.js test/cli-account.test.js`
Expected: FAIL. `account.test.js` with `Cannot find module '…/src/account.js'`; `cli-account.test.js` with `unknown command: login`.

- [ ] **Step 3: Move the private-file writer out of agent-join**

Create `src/private-file.js`:

```js
// Files only you should read (this computer's sign-in, agents' keys): written
// atomically with mode 0600, and never through a symlink.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** True if `file` is a symlink (a missing file isn't). */
export function isSymlink (file) {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

/**
 * Writes JSON to `file`: a private temp file in the same folder, fsynced, then
 * renamed over the target. The rename replaces whatever is there without
 * following it, and a half-written file is never seen at the real path.
 */
export function writePrivateJson (file, data) {
  if (isSymlink(file)) throw new Error(`Refusing to write ${file}: it's a symlink`)
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`)
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2))
    fs.fsyncSync(fd)
  } catch (err) {
    fs.closeSync(fd)
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
  fs.closeSync(fd)
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
}
```

In `src/agent-join.js`, add `import { writePrivateJson } from './private-file.js'`, drop the now-unused `crypto` import, and replace the whole `save` function (with its comment) with:

```js
/** Saves the agent's file privately (see private-file.js), in a private agents folder. */
function save (file, data) {
  ensureAgentsDir(path.dirname(file))
  writePrivateJson(file, data)
}
```

- [ ] **Step 4: Write `src/account.js`**

```js
// This computer's sign-in: the token the accounts API gave it when you approved
// it on heyquilt.com, kept in ~/.quilt/account.json (readable only by you).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { quiltHome } from './legacy.js'
import { signDeviceLink } from './identity.js'
import { isSymlink, writePrivateJson } from './private-file.js'

export const API_URL = 'https://api.heyquilt.com'
export const NOT_SIGNED_IN = 'Run quilt login first.'
export const SIGNED_OUT = 'This computer was signed out. Sign in again.'

/** The accounts API. QUILT_API_URL overrides it, for development and tests. */
export const apiUrl = () => String(process.env.QUILT_API_URL || API_URL).replace(/\/+$/, '')
export const accountFile = () => path.join(quiltHome(), 'account.json')

/** { token, account: { id, name, email }, signedInAt }, or null when signed out (or the file is a symlink or unreadable). */
export function readAccount (file = accountFile()) {
  try {
    if (isSymlink(file)) return null
    const a = JSON.parse(fs.readFileSync(file, 'utf8'))
    return a && typeof a.token === 'string' && a.token.startsWith('qd_') && a.account ? a : null
  } catch {
    return null
  }
}

export function saveAccount (data, file = accountFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writePrivateJson(file, data)
  return data
}

export function clearAccount (file = accountFile()) {
  fs.rmSync(file, { force: true })
}

export const accountFromProfile = (p) => ({ id: p.id, name: p.name, email: p.email || '' })

async function call (fetchImpl, api, method, route, body, token) {
  let res
  try {
    res = await fetchImpl(api + route, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    })
  } catch (err) {
    throw new Error(`Couldn't reach Quilt (${err.cause?.code || err.message}).`)
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw Object.assign(new Error(data?.error || `Quilt answered ${res.status}.`), { status: res.status })
  return data
}

/** Starts linking this computer to an account: { deviceCode, userCode, verificationUrl, interval, expiresIn }. */
export async function startLink ({ identity, api = apiUrl(), fetch: fetchImpl = globalThis.fetch } = {}) {
  return call(fetchImpl, api, 'POST', '/v1/device/start', {
    publicKey: identity.publicKey,
    deviceName: os.hostname().replace(/\.local$/, ''),
    platform: process.platform
  })
}

/** One poll: { status: 'pending' } or { status: 'approved', token, profile }. Throws with .status 410 (expired) or 403 (declined). */
export async function pollLink ({ identity, deviceCode, api = apiUrl(), fetch: fetchImpl = globalThis.fetch } = {}) {
  return call(fetchImpl, api, 'POST', '/v1/device/poll', { deviceCode, signature: signDeviceLink(identity, deviceCode) })
}

/**
 * Polls at the link's interval until someone approves it on the website.
 * Rejects with .expired, .denied, or .cancelled (once `stopped()` says so).
 */
export async function waitForLink ({ identity, link, api, fetch, stopped = () => false, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now }) {
  const until = now() + link.expiresIn * 1000
  while (now() < until) {
    await sleep(link.interval * 1000)
    if (stopped()) throw Object.assign(new Error('Signing in was cancelled.'), { cancelled: true })
    let r
    try {
      r = await pollLink({ identity, deviceCode: link.deviceCode, api, fetch })
    } catch (err) {
      if (err.status === 410) break
      if (err.status === 403) throw Object.assign(new Error('Sign-in was declined in the browser.'), { denied: true })
      if (err.status) throw err
      continue // couldn't reach Quilt: try again at the next interval
    }
    if (r.status === 'approved') return r
  }
  throw Object.assign(new Error('The code expired.'), { expired: true })
}

/** Your profile ({ id, name, email, … }) from this computer's token. Throws with .status 401 once it's revoked. */
export async function fetchMe ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
  return (await call(fetchImpl, api, 'GET', '/v1/me', null, token)).profile
}

/** Revokes this computer's token (best effort: it may be revoked already, or Quilt unreachable), then forgets it. */
export async function signOut ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch, file = accountFile() } = {}) {
  if (token) await call(fetchImpl, api, 'POST', '/v1/me/signout', {}, token).catch(() => {})
  clearAccount(file)
}
```

- [ ] **Step 5: Email in the API's profiles**

In `src/api/server.js`, after `passHolder` (added in Task 2) add:

```js
  /** A person's profile and sign-in email, which the app keeps in account.json. */
  async function profileWithEmail (userId) {
    const p = await store.profile(userId)
    return p && { ...p, email: (await store.userEmail(userId))?.email || '' }
  }
```

In the `/v1/device/poll` route, change the last line to:

```js
      return { status: 'approved', token, profile: await profileWithEmail(link.userId) }
```

and in `GET /v1/me`:

```js
      return { profile: await profileWithEmail(d.userId), device: { id: d.id, name: d.name } }
```

- [ ] **Step 6: `quilt login`, `quilt logout`, `quilt whoami`**

In `bin/quilt.js`, add to `HELP` after the `quilt ui` line:

```
  quilt login [--no-browser]                          Sign in to your heyquilt.com account
  quilt logout                                        Sign this computer out
  quilt whoami                                        Show which account this computer is signed in to
```

Add to the `switch` in `main` (after `case 'ui': return ui()`):

```js
    case 'login': return login()
    case 'logout': return logout()
    case 'whoami': return whoami()
```

Add these functions after `ui()`:

```js
async function login () {
  const { values } = parseArgs({ args: argv, options: { 'no-browser': { type: 'boolean' } } })
  const { readAccount, saveAccount, startLink, waitForLink, accountFromProfile } = await import('../src/account.js')
  const { loadIdentity } = await import('../src/identity.js')
  const current = readAccount()
  if (current) return console.log(`Already signed in as ${current.account.name} (${current.account.email}). Run quilt logout first to switch accounts.`)
  const identity = loadIdentity()
  let link
  try { link = await startLink({ identity }) } catch (err) { fail(err.message) }
  console.log(`To sign in, open this page and approve this computer:\n\n  ${link.verificationUrl}\n\nCheck it shows the code ${link.userCode}. Waiting…`)
  if (!values['no-browser']) openBrowser(link.verificationUrl)
  let r
  try { r = await waitForLink({ identity, link }) } catch (err) { fail(err.expired ? 'The code expired. Run quilt login again.' : err.message) }
  const account = accountFromProfile(r.profile)
  saveAccount({ token: r.token, account, signedInAt: Date.now() })
  console.log(`Signed in as ${account.name} (${account.email}).`)
}

async function logout () {
  const { readAccount, signOut } = await import('../src/account.js')
  const current = readAccount()
  if (!current) return console.log('Not signed in')
  await signOut({ token: current.token })
  console.log(`Signed out of ${current.account.email}.`)
}

async function whoami () {
  const { readAccount } = await import('../src/account.js')
  const current = readAccount()
  if (!current) {
    console.log('Not signed in')
    process.exitCode = 1
    return
  }
  console.log(`${current.account.name} (${current.account.email})`)
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/account.test.js test/cli-account.test.js test/agent-join.test.js`
Expected: PASS (the CLI test takes a few seconds: the login polls every 3 seconds).

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/private-file.js src/account.js src/agent-join.js src/api/server.js bin/quilt.js test/account.test.js test/cli-account.test.js
git commit -m "Sign in from the command line: quilt login, logout and whoami, saved privately in account.json"
```

---
### Task 5: Clients fetch, cache and refresh passes (Connection, Session, `quilt join`, agents, MCP)

**Files:**
- Create: `src/pass-source.js`
- Modify: `src/agent-join.js` (`readAgent`, `agentAccess`, `savedAgents`, `pickAgent`; `refresh` errors carry `.status`)
- Modify: `src/connection.js` (passes in the URL, refresh timer, 4419)
- Modify: `src/session.js` (`passes` option, `relayHeaders`)
- Modify: `src/runner.js` (`runSession` takes `passes`, `identity`)
- Modify: `bin/quilt.js` (`join`)
- Modify: `src/mcp.js` (join and start as a saved agent)
- Modify: `test/pass-helpers.js` (`testPasses`), `test/mcp.test.js`, `test/settings.test.js`, `test/agent-join.test.js`
- Create: `test/pass-source.test.js`, `test/session-passes.test.js`, `test/cli-join.test.js`

**Interfaces:**
- Consumes: `readPass`, `verifyPass`, `PASS_TTL_MS` (Task 2); `MSG_PASS`, `CLOSE_PASS_EXPIRED`, `makePass`, `PASS_KEYS` (Task 3); `apiUrl`, `readAccount`, `clearAccount`, `NOT_SIGNED_IN`, `SIGNED_OUT` (Task 4); `linkDevice` (Task 2).
- Produces (in `src/pass-source.js`):
  - `PASS_EARLY_MS = 120000`, `PASS_REFRESH_MS = 300000`
  - `class SignedOutError extends Error` with `.signedOut = true`
  - `class PassSource { constructor({ fetchPass: () => Promise<{ pass, expiresAt }>, now?, earlyMs? }); get(): Promise<string>; fresh(): Promise<string>; get payload(): object | null }`
  - `personPasses({ token, api?, fetch?, now? }): PassSource`
  - `agentPasses({ name, dir?, fetch?, now? }): PassSource`
  - `sessionPasses({ agent?, dir? }): { passes: PassSource, identity: object | null, kind: 'human' | 'agent' }` (throws `Run quilt login first.`)
- Produces (in `src/agent-join.js`): `readAgent({ name, dir }): saved`, `agentAccess({ name, dir?, fetch?, now? }): Promise<saved>`, `savedAgents(dir?): string[]`, `pickAgent({ agent?, dir? }): string`.
- Produces: `new Connection({ …, passes = null, passRefreshMs = PASS_REFRESH_MS })`; `new Session({ …, passes = null })` and `Session#relayHeaders(extra): Promise<object>`; `runSession({ …, passes = null, identity = null })` (name and agent kind come from the pass).
- Produces (CLI): `quilt join [--agent <name>]` needs `account.json` (or the agent); `--name` is gone.
- Produces (MCP): `quilt_join_session` and `quilt_start_session` take `agent` instead of `name`.
- Produces (tests): `testPasses(identity, fields?): PassSource` in `test/pass-helpers.js`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pass-helpers.js`:

```js
import { PassSource } from '../src/pass-source.js'

/** Passes made locally for `identity`, the way the API would hand them out. */
export function testPasses (identity, fields = {}) {
  return new PassSource({
    fetchPass: async () => {
      const exp = Date.now() + PASS_TTL_MS
      return { pass: makePass({ identity, exp, ...fields }), expiresAt: exp }
    }
  })
}
```

(move the new `import` line up next to the existing import at the top of the file).

Create `test/pass-source.test.js`:

```js
// Getting passes: cached until 2 minutes before they run out, shared between
// callers, and clear about a computer (or agent) that's signed out.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestApi, linkDevice, API_URL } from './api-helpers.js'
import { PassSource, SignedOutError, personPasses, agentPasses, sessionPasses } from '../src/pass-source.js'
import { newPassKeys, verifyPass } from '../src/passes.js'
import { agentJoin, agentFile } from '../src/agent-join.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ps-home-'))
const KEYS = newPassKeys()
let t
before(async () => { t = await startTestApi({ passKey: KEYS.privateKey }) })
after(() => t.close())
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ps-'))

test('a pass is reused until 2 minutes before it runs out, and callers share one request', async () => {
  let clock = 1_000_000
  let n = 0
  const ps = new PassSource({ now: () => clock, fetchPass: async () => { n++; return { pass: `p${n}`, expiresAt: clock + 10 * 60_000 } } })
  assert.deepEqual(await Promise.all([ps.get(), ps.get()]), ['p1', 'p1'])
  assert.equal(n, 1)
  clock += 8 * 60_000 - 1
  assert.equal(await ps.get(), 'p1', 'still more than 2 minutes left')
  clock += 1
  assert.equal(await ps.get(), 'p2', '2 minutes left: fetch a new one')
  assert.equal(await ps.fresh(), 'p3', 'fresh() always fetches')
})

test('a failed fetch is not cached', async () => {
  let fail = true
  const ps = new PassSource({ fetchPass: async () => { if (fail) throw new Error('offline'); return { pass: 'p', expiresAt: Date.now() + 600_000 } } })
  await assert.rejects(ps.get(), /offline/)
  fail = false
  assert.equal(await ps.get(), 'p')
})

test("a linked computer's passes, and a clear error once it's signed out", async () => {
  const { token, identity } = await linkDevice(t, 'mem')
  const ps = personPasses({ token, api: t.api.url })
  const p = verifyPass(await ps.get(), KEYS.publicKey)
  assert.deepEqual([p.kind, p.name, p.key], ['person', 'Mo', identity.publicKey])
  assert.equal(ps.payload.name, 'Mo')
  await t.call('POST', '/v1/me/signout', {}, null, { authorization: `Bearer ${token}` })
  await assert.rejects(ps.fresh(), (err) => err instanceof SignedOutError && err.signedOut === true && err.message === 'This computer was signed out. Sign in again.')
})

test("an agent's passes use its saved key, refreshing its access key first when it has run out", async () => {
  const dir = tmp()
  const link = (await t.call('POST', '/v1/agent-invites', {}, 'mem')).body.link.replace(API_URL, t.api.url)
  const saved = await agentJoin({ link, name: 'helper', dir, log: () => {} })
  const file = agentFile('helper', dir)
  fs.writeFileSync(file, JSON.stringify({ ...saved, accessExpiresAt: Date.now() - 1 }))
  const p = verifyPass(await agentPasses({ name: 'helper', dir }).get(), KEYS.publicKey)
  assert.deepEqual([p.kind, p.name, p.sub, p.key], ['agent', 'helper', saved.agentId, saved.identity.publicKey])
  assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).refreshKey, saved.refreshKey, 'the keys were refreshed and saved')
  await t.store.revokeAgent(saved.agentId)
  await assert.rejects(agentPasses({ name: 'helper', dir }).get(), (err) => err.signedOut === true)
})

test('a session needs a signed-in account or a saved agent', () => {
  assert.throws(() => sessionPasses(), /^Error: Run quilt login first\.$/)
  assert.throws(() => sessionPasses({ agent: 'nobody', dir: tmp() }), /No agent called nobody/)
})
```

Create `test/session-passes.test.js`:

```js
// Sessions on a relay that needs passes: they connect, sync, share files, keep
// their pass fresh, come back after a lapse, and stop when signed out.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { Connection } from '../src/connection.js'
import { runSession } from '../src/runner.js'
import { generateIdentity } from '../src/identity.js'
import { PassSource, SignedOutError } from '../src/pass-source.js'
import { PASS_KEYS, makePass, testPasses } from './pass-helpers.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-sp-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-sp-${n}-`))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 8000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
/** Passes that run out after `ms`, counting how many were fetched. */
function shortPasses (identity, ms) {
  const ps = new PassSource({ earlyMs: 0, fetchPass: async () => { ps.count++; const exp = Date.now() + ms; return { pass: makePass({ identity, exp }), expiresAt: exp } } })
  ps.count = 0
  return ps
}

let srv, server
before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  server = `ws://127.0.0.1:${srv.port}`
})
after(() => srv.close())

test('two signed-in sessions sync files and share chat files through a relay that needs passes', async (t) => {
  const dana = generateIdentity()
  const eli = generateIdentity()
  const dirA = tmp('a')
  fs.writeFileSync(path.join(dirA, 'hello.txt'), 'hi')
  const a = new Session({ dir: dirA, server, room: 'sp-1', secret: 's', name: 'Dana', identity: dana, passes: testPasses(dana) })
  t.after(() => a.stop())
  await a.start({ waitTimeoutMs: 5000 })
  const dirB = tmp('b')
  const b = new Session({ dir: dirB, server, room: 'sp-1', secret: 's', name: 'Eli', identity: eli, passes: testPasses(eli, { name: 'Eli', sub: 'user-eli' }) })
  t.after(() => b.stop())
  await b.start({ waitTimeoutMs: 5000 })
  await waitFor(() => read(dirB, 'hello.txt') === 'hi')

  const notes = path.join(tmp('notes'), 'notes.txt')
  fs.writeFileSync(notes, 'shared notes')
  const sent = await a.sendFile(notes)
  await waitFor(() => b.chat.toArray().some((m) => m.id === sent.id))
  const got = await b.fetchFile(sent.id, path.join(tmp('dl'), 'notes.txt'))
  assert.equal(fs.readFileSync(got, 'utf8'), 'shared notes')
})

test('a session without a pass is told to update and sign in', async (t) => {
  const s = new Session({ dir: tmp('none'), server, room: 'sp-2', secret: 's', name: 'Old', identity: generateIdentity() })
  t.after(() => s.stop())
  await assert.rejects(s.start({ waitTimeoutMs: 5000 }), /Update Quilt and sign in to continue/)
})

test('a connection refreshes its pass while connected, so it never runs out', async (t) => {
  const id = generateIdentity()
  const passes = shortPasses(id, 700)
  const conn = new Connection({ server, room: 'sp-3', secret: 's', name: 'Dana', identity: id, doc: new Y.Doc(), passes, passRefreshMs: 250 })
  t.after(() => conn.close())
  const statuses = []
  conn.on('status', (s) => statuses.push(s))
  await conn.waitForSync()
  await wait(1500)
  assert.deepEqual(statuses, ['connected'], 'never dropped')
  assert.ok(passes.count >= 4, `fetched ${passes.count} passes`)
})

test('a lapsed pass closes with 4419, and the connection comes back with a fresh one', async (t) => {
  const id = generateIdentity()
  const passes = shortPasses(id, 400)
  const conn = new Connection({ server, room: 'sp-4', secret: 's', name: 'Dana', identity: id, doc: new Y.Doc(), passes, passRefreshMs: 60_000 })
  t.after(() => conn.close())
  const statuses = []
  conn.on('status', (s) => statuses.push(s))
  await waitFor(() => statuses.filter((s) => s === 'connected').length >= 2)
  assert.deepEqual(statuses.slice(0, 3), ['connected', 'disconnected', 'connected'])
  assert.ok(passes.count >= 2)
})

test('once the API says this computer is signed out, the connection stops for good', async () => {
  const passes = new PassSource({ fetchPass: async () => { throw new SignedOutError('This computer was signed out. Sign in again.') } })
  const conn = new Connection({ server, room: 'sp-5', secret: 's', name: 'Dana', identity: generateIdentity(), doc: new Y.Doc(), passes })
  const err = await new Promise((resolve) => conn.on('fatal', resolve))
  assert.equal(err.signedOut, true)
  assert.equal(err.message, 'This computer was signed out. Sign in again.')
  assert.equal(conn.closed, true)
})

test('runSession takes your name, and an agent badge, from the pass', async (t) => {
  const id = generateIdentity()
  const run = await runSession({ dir: tmp('run'), conn: { server, room: 'sp-6', secret: 's', viewSecret: 'v' }, name: 'ignored', identity: id, passes: testPasses(id, { name: 'helper', kind: 'agent', sub: 'agent-1' }), agentFeed: false })
  t.after(() => run.stop())
  assert.equal(run.session.name, 'helper')
  assert.equal(run.session.kind, 'agent')
  await waitFor(() => srv.rooms.get('sp-6')?.access.size)
  assert.deepEqual([...srv.rooms.get('sp-6').access.values()].map((a) => [a.name, a.kind]), [['helper', 'agent']])
})
```

Create `test/cli-join.test.js`:

```js
// `quilt join` signs in to the relay with this computer's account (or a saved
// agent's keys), and won't start without one.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startTestApi, linkDevice, API_URL } from './api-helpers.js'
import { startServer } from '../src/server.js'
import { newPassKeys } from '../src/passes.js'
import { loadIdentity } from '../src/identity.js'
import { saveAccount } from '../src/account.js'
import { agentJoin } from '../src/agent-join.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'quilt.js')
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-cli-join-${n}-`))
async function waitFor (fn, ms = 8000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((resolve) => setTimeout(resolve, 50)) }
  throw new Error('timed out')
}
const KEYS = newPassKeys()
let t, relay
before(async () => {
  t = await startTestApi({ passKey: KEYS.privateKey })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: KEYS.publicKey })
})
after(async () => { await relay.close(); await t.close() })

const envFor = (home) => ({ ...process.env, HOME: home, QUILT_API_URL: t.api.url, QUILT_SERVER: `ws://127.0.0.1:${relay.port}` })

/** Runs `quilt join` until it prints an invite link (or exits). */
function join (args, home) {
  const child = spawn(process.execPath, [BIN, 'join', ...args], { cwd: tmp('proj'), env: envFor(home) })
  let out = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('join did not start:\n' + out)) }, 15000)
    const onData = (d) => {
      out += d
      if (/\/join\/\S+#/.test(out)) { clearTimeout(timer); resolve({ child, out }) }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ child, out, code }) })
  })
}
const stop = (child) => new Promise((resolve) => {
  if (child.exitCode !== null) return resolve()
  child.on('exit', resolve)
  child.kill('SIGTERM')
})
const inRelay = () => [...relay.rooms.values()].flatMap((r) => [...r.access.values()].map((a) => [a.name, a.kind]))

test('without signing in, quilt join says to run quilt login first', async () => {
  const r = await join([], tmp('home'))
  assert.equal(r.code, 1)
  assert.match(r.out, /Run quilt login first\./)
})

test('a signed-in computer joins under its account name', async () => {
  const home = tmp('home')
  const identity = loadIdentity(path.join(home, '.quilt', 'identity.json'))
  const { token } = await linkDevice(t, 'mem', identity)
  saveAccount({ token, account: { id: 'mem', name: 'Mo', email: 'mo@acme.com' }, signedInAt: Date.now() }, path.join(home, '.quilt', 'account.json'))
  const { child, out } = await join([], home)
  try {
    assert.match(out, /as "Mo"/)
    await waitFor(() => inRelay().some(([n, k]) => n === 'Mo' && k === 'human'))
  } finally { await stop(child) }
})

test('quilt join --agent joins as a saved agent', async () => {
  const home = tmp('home')
  const link = (await t.call('POST', '/v1/agent-invites', {}, 'mem')).body.link.replace(API_URL, t.api.url)
  await agentJoin({ link, name: 'helper', dir: path.join(home, '.quilt'), log: () => {} })
  const { child, out } = await join(['--agent', 'helper'], home)
  try {
    assert.match(out, /as "helper"/)
    await waitFor(() => inRelay().some(([n, k]) => n === 'helper' && k === 'agent'))
  } finally { await stop(child) }
})
```

Add to `test/agent-join.test.js` (and add `savedAgents, pickAgent` to its import from `../src/agent-join.js`):

```js
test('the saved agents on a computer, and which one a session uses', async () => {
  const dir = tmp()
  assert.deepEqual(savedAgents(dir), [])
  assert.throws(() => pickAgent({ dir }), /no Quilt agent yet/)
  await agentJoin({ link: await newLink(), name: 'solo', dir, log: () => {} })
  assert.deepEqual(savedAgents(dir), ['solo'])
  assert.equal(pickAgent({ dir }), 'solo', 'the only one')
  await agentJoin({ link: await newLink(), name: 'other', dir, log: () => {} })
  assert.throws(() => pickAgent({ dir }), /several Quilt agents \(other, solo\)/)
  assert.equal(pickAgent({ agent: 'other', dir }), 'other')
})
```

In `test/mcp.test.js`, sessions the MCP server joins are now a saved agent's. Add to the imports:

```js
import { startTestApi, API_URL } from './api-helpers.js'
import { newPassKeys } from '../src/passes.js'
import { agentJoin } from '../src/agent-join.js'
```

change `let relay, human, client, humanDir, agentCwd` to `let relay, human, client, humanDir, agentCwd, accounts`, and in `before`, replace `const home = tmp('home')` with:

```js
  const home = tmp('home')
  // The agent joined Quilt first (as `quilt agent join` does); sessions then use its keys.
  accounts = await startTestApi({ passKey: newPassKeys().privateKey })
  const link = (await accounts.call('POST', '/v1/agent-invites', {}, 'mem')).body.link.replace(API_URL, accounts.api.url)
  await agentJoin({ link, name: 'helper', dir: path.join(home, '.quilt'), log: () => {} })
```

add `await accounts?.close()` as the last line of `after`, and in the test `an agent joins by invite and shows up as an agent` replace `assert.match(peer.name, /^Claude Code agent \(.+\)$/)` with:

```js
  assert.equal(peer.name, 'helper', 'named after the saved agent')
```

In `test/settings.test.js`, the relay test no longer runs `quilt join` (it needs an account now, and Task 6 removes `quilt relay`). Replace the whole test `quilt relay set/check, then quilt join starts on the default relay with its key` with:

```js
test('quilt relay set/check/clear save and forget the default relay', async () => {
  const home = tmp('home')
  const env = { ...process.env, HOME: home, QUILT_SERVER: '', QUILT_RELAY_KEY: '' }
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, relayKey: 'team-key' })
  const url = `ws://127.0.0.1:${srv.port}`
  const set = await run(process.execPath, [BIN, 'relay', 'set', `http://127.0.0.1:${srv.port}`, '--key', 'team-key'], { env })
  assert.match(set.stdout, /needs a relay key/)
  assert.match(set.stdout, /default relay set/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.quilt', 'settings.json'), 'utf8')), { relay: url, relayKey: 'team-key' })
  assert.match((await run(process.execPath, [BIN, 'relay'], { env })).stdout, /\(default\).*key saved/)
  await run(process.execPath, [BIN, 'relay', 'clear'], { env })
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.quilt', 'settings.json'), 'utf8')).relay, undefined)
  await srv.close()
})
```

and remove the now-unused `spawn` and `decodeInvite` imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/pass-source.test.js test/session-passes.test.js test/cli-join.test.js test/agent-join.test.js test/mcp.test.js`
Expected: FAIL. `pass-source.test.js` with `Cannot find module '…/src/pass-source.js'`; the others for the same reason (via `pass-helpers.js`) or because `quilt join` doesn't check sign-in yet.

- [ ] **Step 3: Agent helpers in `src/agent-join.js`**

Make `refresh` errors carry the HTTP status. Replace its first line after `send(…)`:

```js
  if (!r.ok) throw Object.assign(new Error(r.body?.error || `Couldn't refresh the agent's keys (${r.status}).`), { status: r.status })
```

Replace `agentWhoami` with the following, which also adds the new helpers:

```js
/** A saved agent's file: { name, api, agentId, accessKey, refreshKey, …, identity }. */
export function readAgent ({ name, dir }) {
  return load(agentFile(name, dir), name)
}

/** The saved agent with a working access key, refreshed first when it has (nearly) run out. */
export async function agentAccess ({ name, dir, fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
  const file = agentFile(name, dir)
  const saved = load(file, name)
  return saved.accessExpiresAt - EARLY_MS <= now() ? refresh(saved, file, fetchImpl) : saved
}

/** Who the agent is, refreshing its keys first when the access key has (nearly) run out. */
export async function agentWhoami ({ name, dir, fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
  const saved = await agentAccess({ name, dir, fetch: fetchImpl, now })
  const r = await send(fetchImpl, saved.api, 'GET', '/v1/agents/me', null, saved.accessKey)
  if (!r.ok) throw new Error(r.body?.error || `Couldn't reach Quilt (${r.status}).`)
  return r.body
}

/** The names of the agents saved on this computer. */
export function savedAgents (dir = quiltHome()) {
  try {
    return fs.readdirSync(path.join(dir, 'agents')).filter((f) => f.endsWith('.json') && !f.startsWith('.')).map((f) => f.slice(0, -5)).sort()
  } catch {
    return []
  }
}

/** Which saved agent a session joins as: the one named, or the only one there is. */
export function pickAgent ({ agent, dir } = {}) {
  if (agent) return agent
  const all = savedAgents(dir)
  if (all.length === 1) return all[0]
  if (!all.length) throw new Error('This computer has no Quilt agent yet. The person you work with can invite one on heyquilt.com, then run: quilt agent join <link> --name <name>')
  throw new Error(`This computer has several Quilt agents (${all.join(', ')}). Say which one to join as.`)
}
```

- [ ] **Step 4: Write `src/pass-source.js`**

```js
// Session passes from the accounts API. A pass proves who you are to the relay
// for 10 minutes. Clients keep one until 2 minutes before it runs out, and while
// connected they fetch a fresh one every 5 minutes (see connection.js).
import { readPass } from './passes.js'
import { apiUrl, readAccount, NOT_SIGNED_IN, SIGNED_OUT } from './account.js'
import { agentAccess, readAgent } from './agent-join.js'

export const PASS_EARLY_MS = 2 * 60 * 1000
export const PASS_REFRESH_MS = 5 * 60 * 1000
const AGENT_SIGNED_OUT = "This agent's keys stopped working. Invite it again."

/** The API turned the token away: this computer (or agent) is signed out for good. */
export class SignedOutError extends Error {
  constructor (message) {
    super(message)
    this.signedOut = true
  }
}

export class PassSource {
  /** `fetchPass` resolves to { pass, expiresAt }. */
  constructor ({ fetchPass, now = Date.now, earlyMs = PASS_EARLY_MS }) {
    this.fetchPass = fetchPass
    this.now = now
    this.earlyMs = earlyMs
    this.current = null // { pass, expiresAt, payload }
    this.pending = null
  }

  /** A pass with at least `earlyMs` left, fetching one when needed. */
  get () {
    if (this.current && this.now() < this.current.expiresAt - this.earlyMs) return Promise.resolve(this.current.pass)
    return this.fresh()
  }

  /** Always asks for a new pass. Calls made while one is on its way share it. */
  fresh () {
    if (!this.pending) {
      this.pending = Promise.resolve()
        .then(() => this.fetchPass())
        .then(({ pass, expiresAt }) => {
          this.current = { pass, expiresAt, payload: readPass(pass) }
          return pass
        })
        .finally(() => { this.pending = null })
    }
    return this.pending
  }

  /** Who the passes are for ({ sub, kind, name, key, … }), once one has been fetched. */
  get payload () {
    return this.current ? this.current.payload : null
  }
}

async function requestPass (fetchImpl, api, bearer, signedOutMessage) {
  let res
  try {
    res = await fetchImpl(`${String(api).replace(/\/+$/, '')}/v1/passes`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` } })
  } catch (err) {
    throw new Error(`Couldn't reach Quilt (${err.cause?.code || err.message}).`)
  }
  const body = await res.json().catch(() => null)
  if (res.status === 401) throw new SignedOutError(signedOutMessage)
  if (!res.ok || !body || typeof body.pass !== 'string') throw Object.assign(new Error(body?.error || `Quilt answered ${res.status}.`), { status: res.status })
  return body
}

/** Passes for this computer's account, from its qd_ token. */
export function personPasses ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch, now } = {}) {
  return new PassSource({ now, fetchPass: () => requestPass(fetchImpl, api, token, SIGNED_OUT) })
}

/** Passes for a saved agent, from its access key (refreshed with its refresh key when it runs out). */
export function agentPasses ({ name, dir, fetch: fetchImpl = globalThis.fetch, now } = {}) {
  return new PassSource({
    now,
    fetchPass: async () => {
      let saved
      try {
        saved = await agentAccess({ name, dir, fetch: fetchImpl, now })
      } catch (err) {
        if (err.status === 401) throw new SignedOutError(err.message)
        throw err
      }
      return requestPass(fetchImpl, saved.api, saved.accessKey, AGENT_SIGNED_OUT)
    }
  })
}

/** What a session started here signs in with: a saved agent's passes and key, or this computer's account. */
export function sessionPasses ({ agent = null, dir } = {}) {
  if (agent) return { passes: agentPasses({ name: agent, dir }), identity: readAgent({ name: agent, dir }).identity, kind: 'agent' }
  const account = readAccount()
  if (!account) throw new Error(NOT_SIGNED_IN)
  return { passes: personPasses({ token: account.token }), identity: null, kind: 'human' }
}
```

- [ ] **Step 5: Passes in `Connection`**

In `src/connection.js`:

1. Imports: add `MSG_PASS` to the message names, `CLOSE_PASS_EXPIRED` to the close codes, and the refresh interval:

```js
import {
  MSG_SYNC, MSG_AWARENESS, MSG_QUERY_AWARENESS, MSG_AUTH, MSG_CLAIM, MSG_CLAIMS,
  MSG_ACCESS, MSG_ADMIN, MSG_MEMBERS, MSG_PASS,
  CLOSE_AUTH_FAILED, CLOSE_NAME_TAKEN, CLOSE_ROOM_FULL, CLOSE_DENIED, CLOSE_ENDED, CLOSE_PASS_EXPIRED,
  encoding, decoding, syncProtocol, awarenessProtocol,
  syncStep1Message, updateMessage, awarenessMessage, bytesMessage, jsonMessage
} from './protocol.js'
import { signChallenge, RESERVED_ROOM } from './identity.js'
import { PASS_REFRESH_MS } from './pass-source.js'
```

2. Document the new options in the constructor's JSDoc:

```js
   * @param {import('./pass-source.js').PassSource} [opts.passes]  signs in to a relay that requires passes
   * @param {number} [opts.passRefreshMs]  how often to send the relay a fresh pass while connected
```

and change the constructor signature and URL lines to:

```js
  constructor ({ server, room, secret, key, viewSecret, kind = 'human', name, identity, doc, beforeRemote, features = 'large-files', passes = null, passRefreshMs = PASS_REFRESH_MS }) {
    super()
    if (room === RESERVED_ROOM) throw new Error(`"${RESERVED_ROOM}" is not a session name`)
    // `key` (the relay key) is only needed to create a room on a relay that requires one.
    const q = new URLSearchParams({ secret: secret || '', name, key: identity.publicKey, kind })
    if (key) q.set('relayKey', key)
    if (viewSecret) q.set('viewSecret', viewSecret)
    if (features) q.set('features', features)
    this.access = null // what the relay says we may do: { state, role, scopes, owner, controlled }
    this.base = `${server.replace(/\/+$/, '')}/${encodeURIComponent(room)}`
    this.query = q
    this.url = `${this.base}?${q}`
    this.passes = passes
    this.passRefreshMs = passRefreshMs
    this.passTimer = null
    this.passStale = false // after a 4419 close: get a new pass, not the cached one
```

(the remaining constructor lines, from `this.room = room` on, stay.)

3. Replace `connect ()` down to its first line `const ws = new WebSocket(this.url)` so that a pass is fetched first and the old body becomes `open(url)`:

```js
  connect () {
    if (this.closed) return
    if (!this.passes) return this.open(this.url)
    const getting = this.passStale ? this.passes.fresh() : this.passes.get()
    this.passStale = false
    getting.then((pass) => {
      if (this.closed) return
      const q = new URLSearchParams(this.query)
      q.set('pass', pass)
      this.open(`${this.base}?${q}`)
    }, (err) => {
      if (this.closed) return
      if (err.signedOut) {
        this.emit('fatal', err)
        return this.close()
      }
      this.emit('warn', `couldn't get a session pass: ${err.message}; retrying`)
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 10000)
    })
  }

  open (url) {
    const ws = new WebSocket(url)
```

(everything after `const ws = new WebSocket(…)` in the old `connect` stays as the body of `open`.)

4. In the `ws.on('close', …)` handler, at its top, add the 4419 case before `if (code === CLOSE_ENDED)`:

```js
      clearInterval(this.passTimer)
      if (code === CLOSE_PASS_EXPIRED) {
        // Not fatal: reconnect (below) with a fresh pass.
        this.passStale = true
        this.emit('warn', String(reason) || 'session pass expired; reconnecting')
      } else if (code === CLOSE_ENDED) {
```

(the old `if (code === CLOSE_ENDED) {` becomes this `else if`; the rest of the chain is unchanged.)

5. At the end of `authenticate`, after `this.startSync()`, add `this.startPassRefresh()`, and add these methods after `authenticate`:

```js
  /** While connected, send the relay a fresh pass every few minutes so the connection's never runs out. */
  startPassRefresh () {
    clearInterval(this.passTimer)
    if (!this.passes) return
    this.passTimer = setInterval(() => this.refreshPass(), this.passRefreshMs)
    this.passTimer.unref?.()
  }

  async refreshPass () {
    try {
      const pass = await this.passes.fresh()
      this.send(jsonMessage(MSG_PASS, { pass }))
    } catch (err) {
      if (err.signedOut) {
        this.emit('fatal', err)
        return this.close()
      }
      this.emit('warn', `couldn't refresh the session pass: ${err.message}`)
    }
  }
```

6. In `close ()`, add `clearInterval(this.passTimer)` as its second line (after `this.closed = true`).

- [ ] **Step 6: Passes in `Session` and `runSession`**

In `src/session.js`, add `passes = null` to the constructor's options (after `identity = null`) and after `this.identity = identity`:

```js
    this.passes = passes // signs in to a relay that requires it (see pass-source.js)
```

Add `passes: this.passes,` to the `new Connection({ … })` call in `start` (after `identity: this.identity || loadIdentity(),`). Add this method before `blobRequest`:

```js
  /** Headers for the relay's session routes: the room secret, and a pass when signed in. */
  async relayHeaders (extra = {}) {
    return {
      'x-quilt-secret': this.secret,
      ...(this.key ? { 'x-quilt-key': this.key } : {}),
      ...(this.passes ? { 'x-quilt-pass': await this.passes.get() } : {}),
      ...extra
    }
  }
```

and use it in the three HTTP calls:

```js
    const res = await fetch(`${this.httpBase()}/blobs/${encodeURIComponent(this.room)}/${id}/${action}`, {
      method: 'POST',
      headers: await this.relayHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body)
    })
```

```js
    const res = await fetch(`${this.httpBase()}/files/${encodeURIComponent(this.room)}`, {
      method: 'POST',
      headers: await this.relayHeaders({ 'content-type': 'application/octet-stream' }),
      body: fs.readFileSync(abs)
    })
```

```js
    const res = await fetch(`${this.httpBase()}/files/${encodeURIComponent(this.room)}/${msg.file.id}`, {
      headers: await this.relayHeaders()
    })
```

In `src/runner.js`, add `import { readPass } from './passes.js'`, add `passes = null, identity = null` to `runSession`'s options (after `readerOptions = {}`), and replace `name = (name || os.userInfo().username).trim()` with:

```js
  if (passes) {
    // Who you are in a session comes from your account (or the agent's): the relay uses the pass's name.
    const pass = readPass(await passes.get())
    name = pass.name
    if (pass.kind === 'agent') kind = 'agent'
  }
  name = (name || os.userInfo().username).trim()
```

and pass them to the session: `const session = new Session({ dir, ...conn, name, tool, color, prefer, kind, shareAgent, identity, passes })`.

- [ ] **Step 7: `quilt join` needs a sign-in**

In `bin/quilt.js`, in `HELP` replace the `Join options` block's first line `--name <you>…` with:

```
  --agent <name>      Join as a Quilt agent saved with \`quilt agent join\` (default: your account)
```

and remove the old `--agent` line (`Join as an AI agent…`).

In `join ()`, replace the `parseArgs` options with:

```js
    options: {
      server: { type: 'string' }, room: { type: 'string' }, secret: { type: 'string' },
      tool: { type: 'string' }, dir: { type: 'string' }, prefer: { type: 'string' }, agent: { type: 'string' }
    }
```

After `const { runSession, decodeInvite, newConn, readConfig } = await import('../src/runner.js')` add:

```js
  const { sessionPasses } = await import('../src/pass-source.js')
  const { clearAccount } = await import('../src/account.js')
  // Every session signs in: as this computer's account, or as a saved agent.
  let auth
  try { auth = sessionPasses({ agent: values.agent || null }) } catch (err) { fail(err.message) }
  const whyStopped = (err) => {
    if (!err.signedOut || values.agent) return err.message
    clearAccount()
    return 'This computer was signed out. Run quilt login again.'
  }
```

Replace everything from `const stamp = () => new Date().toLocaleTimeString()` to the end of the `try { run = await runSession(…) } catch …` block with:

```js
  const stamp = () => new Date().toLocaleTimeString()
  console.log(`quilt: syncing ${dir}`)
  let run
  try {
    run = await runSession({
      dir,
      conn,
      tool: values.tool || saved.tool,
      prefer: values.prefer === 'local' ? 'local' : 'remote',
      kind: auth.kind,
      passes: auth.passes,
      identity: auth.identity,
      inviteServer: saved.room === conn.room ? saved.inviteServer : undefined,
      onLog: (m) => console.log(`[${stamp()}] ${m}`),
      onDebug: process.env.QUILT_DEBUG ? (m) => console.log(`[${stamp()}] debug: ${m}`) : undefined,
      onFatal: (err) => fail(whyStopped(err))
    })
  } catch (err) {
    fail(whyStopped(err))
  }
  console.log(`  room ${conn.room} on ${conn.server} as "${run.session.name}"`)
```

`os` is no longer used in `bin/quilt.js`: remove `import os from 'node:os'`.

- [ ] **Step 8: MCP sessions join as a saved agent**

In `src/mcp.js`, add:

```js
import { sessionPasses } from './pass-source.js'
import { pickAgent } from './agent-join.js'
```

Change `startAs` to take `agent` instead of `name`, and sign in with that agent's passes. Its signature and the `runSession` call become:

```js
  const startAs = async ({ conn, folder, agent, inviteServer }) => {
```

```js
    const tool = clientTool()
    // Each agent joins as itself: its name, key and passes come from its saved keys.
    const auth = sessionPasses({ agent: pickAgent({ agent }) })
    logs = []
    const run = await runSession({
      dir,
      conn,
      tool,
      kind: 'agent',
      passes: auth.passes,
      identity: auth.identity,
      joined: !inviteServer && !conn.viewSecret,
      inviteServer,
      // This agent's own chat lives where it was started, which may be above the synced folder.
      readerOptions: { chatDir: process.cwd() },
      onLog: (line) => { logs.push(line); if (logs.length > 50) logs.shift() },
      onFatal: async (err) => { logs.push(`stopped: ${err.message}`); await leave() }
    })
```

In both `quilt_join_session` and `quilt_start_session`, replace the `name` input with:

```js
      agent: z.string().optional().describe('Which Quilt agent to join as (saved with `quilt agent join`). Optional when this computer has only one.')
```

and pass `agent` instead of `name` (and remove the now-unused `import os from 'node:os'`): `startAs({ conn, folder, agent })` and `startAs({ conn: newConn(server_, relay ? keyFor(server_) : d.key), folder: folder || '.', agent })`; change their handler parameters from `({ invite, folder, name })` / `({ relay, folder, name })` to `({ invite, folder, agent })` / `({ relay, folder, agent })`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test test/pass-source.test.js test/session-passes.test.js test/cli-join.test.js test/agent-join.test.js test/mcp.test.js test/settings.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS (sessions without `passes` behave exactly as before).

- [ ] **Step 10: Commit**

```bash
git add src/pass-source.js src/agent-join.js src/connection.js src/session.js src/runner.js src/mcp.js bin/quilt.js test/pass-helpers.js test/pass-source.test.js test/session-passes.test.js test/cli-join.test.js test/agent-join.test.js test/mcp.test.js test/settings.test.js
git commit -m "Sessions sign in to the relay with passes: cached, refreshed every 5 minutes, and for agents from their keys"
```

---
### Task 6: One relay

Quilt always uses `wss://relay.heyquilt.com` (or `QUILT_SERVER`, for development and tests). The app's Relay settings, the in-process relay ("This computer") and `quilt relay` go away; recent sessions that ran on a local relay get a card explaining they can't reopen.

**Files:**
- Modify: `src/settings.js` (rewrite)
- Modify: `src/runner.js` (`newConn`)
- Modify: `bin/quilt.js` (`join`, `serve`, help; remove `relay`)
- Modify: `src/mcp.js` (`quilt_start_session`)
- Modify: `src/ui-server.js` (profile, start, recents, routes; no in-process relay)
- Modify: `src/ui/home.js`, `src/ui/app.js`, `src/ui/session.js`, `src/ui/common.js`, `src/ui/app.css`
- Modify: `test/settings.test.js` (rewrite), `test/ui.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (in `src/settings.js`): `HOSTED_RELAY = 'wss://relay.heyquilt.com'`, `relayUrl(): string`, `isHostedRelay(server): boolean`, `ranOnLocalRelay(server): boolean`, `getSettings()` (without `relay`, `relayKey`, `relayMode`, `publicUrl`), `saveSettings(patch)`. Removed: `normalizeRelay`, `defaultRelay`, `keyFor`, `checkRelay`.
- Produces (in `src/runner.js`): `newConn(server = relayUrl()): { server, room, secret, viewSecret }`.
- Produces (app API): `GET /api/state` → `{ sessions, recent: [{ …, unsupported: boolean }], defaults, profile, maxFileBytes }` (no `relay`); `POST /api/sessions` with `mode: 'rejoin'` on a local-relay session → 400 with the "no longer supports" message. Removed: `POST /api/relay/check`, the `hostRelay`, `server`, `publicUrl`, `relayKey`, `saveDefault` body fields, and `startUi`'s `relayPort` option.

- [ ] **Step 1: Write the failing tests**

Replace `test/settings.test.js` with:

```js
// Settings: your colour, AI tool and session defaults. There is one relay now;
// relay settings from before are ignored and dropped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getSettings, saveSettings, relayUrl, isHostedRelay, ranOnLocalRelay, HOSTED_RELAY } from '../src/settings.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'quilt.js')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-settings-home-'))
process.env.HOME = home
delete process.env.QUILT_SERVER

test('relay settings from before are ignored, and dropped the next time settings are saved', () => {
  const file = path.join(home, '.quilt', 'settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ relay: 'wss://mine.example.com', relayKey: 'k', relayMode: 'local', publicUrl: 'wss://tunnel.example.com', tool: 'Cursor' }))
  assert.deepEqual(getSettings(), { tool: 'Cursor' })
  saveSettings({ color: '#3b6a9a' })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { tool: 'Cursor', color: '#3b6a9a' })
})

test('Quilt uses the hosted relay unless QUILT_SERVER says otherwise', () => {
  assert.equal(HOSTED_RELAY, 'wss://relay.heyquilt.com')
  assert.equal(relayUrl(), HOSTED_RELAY)
  process.env.QUILT_SERVER = 'ws://127.0.0.1:4999'
  try {
    assert.equal(relayUrl(), 'ws://127.0.0.1:4999')
    assert.equal(ranOnLocalRelay('ws://127.0.0.1:4999'), false, 'the development relay in use still reopens')
  } finally {
    delete process.env.QUILT_SERVER
  }
})

test("the hosted relay under either address, and sessions that ran on a computer's own relay", () => {
  assert.equal(isHostedRelay('wss://relay.heyquilt.com'), true)
  assert.equal(isHostedRelay('wss://cowove-relay.fly.dev/'), true)
  assert.equal(isHostedRelay('wss://relay.example.com'), false)
  assert.equal(ranOnLocalRelay('ws://127.0.0.1:4321'), true)
  assert.equal(ranOnLocalRelay('ws://192.168.1.4:4321'), true)
  assert.equal(ranOnLocalRelay('wss://cowove-relay.fly.dev'), false)
  assert.equal(ranOnLocalRelay(undefined), false)
})

test('quilt relay is gone', () => {
  const r = spawnSync(process.execPath, [BIN, 'relay', 'set', 'wss://x.example.com'], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unknown command: relay/)
})
```

In `test/ui.test.js`:

1. Start a relay for the app to use, since it no longer runs its own. Replace the `before`/`after` block with:

```js
let relay
before(async () => {
  const { startServer } = await import('../src/server.js')
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {} })
  // The app always uses one relay; QUILT_SERVER points it at this one.
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  ui = await startUi({ port: 0, onShutdown: () => { shutdowns++ } })
  base = `http://127.0.0.1:${ui.port}`
})
after(async () => { await ui.close(); await relay.close() })
```

2. Remove `, hostRelay: true` from the three `POST /api/sessions` bodies that have it (in `create a hosted session, chat, send a file, stop`, `agent feed workspace: …` and `the owner can end a session for everyone from the app`), and rename the first test to `create a session, chat, send a file, stop`.

3. Replace the whole test `hosted relay: check it, start a session on it, and save it as the default` with:

```js
test("a session that ran on this computer's own relay is marked, and can't be reopened", async () => {
  const dir = path.join(home, 'old-local')
  fs.mkdirSync(path.join(dir, '.quilt'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.quilt', 'config.json'), JSON.stringify({ server: 'ws://127.0.0.1:4321', room: 'room-old', secret: 's', name: 'me' }))
  const recentFile = path.join(home, '.quilt', 'recent.json')
  const list = fs.existsSync(recentFile) ? JSON.parse(fs.readFileSync(recentFile, 'utf8')) : []
  fs.writeFileSync(recentFile, JSON.stringify([{ dir, room: 'room-old', server: 'ws://127.0.0.1:4321', name: 'me', tool: 'Cursor', lastUsed: Date.now() }, ...list]))
  const st = await api('GET', '/api/state')
  assert.equal(st.body.recent.find((r) => r.dir === dir).unsupported, true)
  assert.equal(st.body.relay, undefined, 'no relay settings any more')
  assert.ok(st.body.recent.filter((r) => r.dir !== dir).every((r) => r.unsupported === false))
  const r = await api('POST', '/api/sessions', { mode: 'rejoin', dir })
  assert.equal(r.status, 400)
  assert.equal(r.body.error, "This session ran on your computer's own relay, which Quilt no longer supports. Your files are untouched.")
  assert.ok(fs.existsSync(path.join(dir, '.quilt', 'config.json')), 'the folder is untouched')
  const relayCheck = await api('POST', '/api/relay/check', { url: 'ws://127.0.0.1:9' })
  assert.equal(relayCheck.status, 404)
})
```

4. In `settings: profile is validated, saved, and used by new sessions`, change the save line to drop `relayMode`:

```js
  const saved = await api('POST', '/api/settings', { name: 'Robin', color: '#3b6a9a', tool: 'Cursor', shareAgent: false })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/settings.test.js test/ui.test.js`
Expected: FAIL. `settings.test.js` with `does not provide an export named 'HOSTED_RELAY'`; `ui.test.js` because sessions still go to an in-process relay or a saved relay setting and `/api/state` still has `relay`.

- [ ] **Step 3: One relay in `src/settings.js`**

Replace the whole file with:

```js
// Per-user settings in ~/.quilt/settings.json: your colour, AI tool and session
// defaults. And the one relay Quilt uses.
import fs from 'node:fs'
import path from 'node:path'
import { quiltHome } from './legacy.js'

/** The relay every session uses. QUILT_SERVER overrides it, for development and tests only. */
export const HOSTED_RELAY = 'wss://relay.heyquilt.com'
// The hosted relay's older address points at the same relay, so its sessions reopen as they are.
const HOSTED_ALIASES = [HOSTED_RELAY, 'wss://cowove-relay.fly.dev']
// Settings from when you could pick a relay. Ignored, and dropped the next time settings are saved.
const RETIRED = ['relay', 'relayKey', 'relayMode', 'publicUrl']

const file = () => path.join(quiltHome(), 'settings.json')

export function getSettings () {
  let s = {}
  try { s = JSON.parse(fs.readFileSync(file(), 'utf8')) || {} } catch {}
  for (const k of RETIRED) delete s[k]
  return s
}

export function saveSettings (patch) {
  const next = { ...getSettings(), ...patch }
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null || next[k] === '') delete next[k]
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(next, null, 2), { mode: 0o600 })
  return next
}

export function relayUrl () {
  return process.env.QUILT_SERVER || HOSTED_RELAY
}

export function isHostedRelay (server) {
  return HOSTED_ALIASES.includes(String(server || '').replace(/\/+$/, ''))
}

/** A session that ran on a relay on someone's own computer ("This computer"), which Quilt no longer runs. */
export function ranOnLocalRelay (server) {
  return /^ws:\/\//.test(String(server || '')) && server !== relayUrl()
}
```

In `src/runner.js`, change `import { keyFor } from './settings.js'` to `import { relayUrl } from './settings.js'` and replace `newConn` with:

```js
/** A new room on Quilt's relay: `secret` invites people to edit, `viewSecret` to only watch. */
export function newConn (server = relayUrl()) {
  return {
    server,
    room: `room-${crypto.randomBytes(4).toString('hex')}`,
    secret: crypto.randomBytes(18).toString('base64url'),
    viewSecret: crypto.randomBytes(18).toString('base64url')
  }
}
```

- [ ] **Step 4: The CLI and MCP use the one relay**

In `bin/quilt.js`:

1. In `HELP`, delete the two `quilt relay …` lines and change the `quilt join [--server <ws(s)://relay>]` line to:

```
  quilt join                                          Start a new session in this folder
```

2. Delete `case 'relay': return relayCmd()` from the `switch`, and delete the whole `relayCmd` function.

3. In `serve`, replace the last `console.log` (`start a session with: …`) with:

```js
  console.log(`for development, point Quilt at it with QUILT_SERVER=ws://<this-host>:${srv.port}`)
```

4. In `join`, remove `server: { type: 'string' }, ` from the options, and replace the whole `let conn` / `if … else` block that picks the connection with:

```js
  const { ranOnLocalRelay } = await import('../src/settings.js')
  let conn
  if (positionals[0]) {
    try { conn = decodeInvite(positionals[0]) } catch (err) { fail(err.message) }
  } else if (values.room) {
    conn = newConn()
    conn.room = values.room
    if (values.secret || process.env.QUILT_SECRET) conn.secret = values.secret || process.env.QUILT_SECRET
  } else if (saved.server && !ranOnLocalRelay(saved.server)) {
    conn = { server: saved.server, room: saved.room, secret: saved.secret, ...(saved.viewSecret ? { viewSecret: saved.viewSecret } : {}) }
  } else {
    if (saved.server) console.log("This folder's last session ran on your computer's own relay, which Quilt no longer supports. Starting a new session.")
    conn = newConn()
    console.log('starting a new session')
  }
```

In `src/mcp.js`, delete `import { defaultRelay, normalizeRelay, keyFor } from './settings.js'`, and replace the `quilt_start_session` registration with:

```js
  server.registerTool('quilt_start_session', {
    description: 'Start a new live quilt session for a folder, as an AI agent, and get an invite link for others.',
    inputSchema: {
      folder: z.string().optional().describe('Folder to share, relative to the current folder (default: current folder)'),
      agent: z.string().optional().describe('Which Quilt agent to join as (saved with `quilt agent join`). Optional when this computer has only one.')
    }
  }, async ({ folder, agent }) => {
    try {
      const r = await startAs({ conn: newConn(), folder: folder || '.', agent })
      return { content: [{ type: 'text', text: await describeSession(r.dir, `Started a session for ${r.dir}. Share the invite link below with collaborators.`) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Could not start: ${err.message}` }], isError: true }
    }
  })
```

- [ ] **Step 5: The app's server: no relay settings, no relay of its own**

In `src/ui-server.js`:

1. Replace the imports and everything down to the end of `updateProfile` with:

```js
// Local web UI: start/join sessions, chat, share files, see collaborators.
// Listens on 127.0.0.1 only and requires a per-launch token, so web pages you
// visit can't drive it.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runSession, decodeInvite, newConn, readConfig, recentSessions, forgetRecent } from './runner.js'
import { MAX_SHARED_FILE_BYTES } from './protocol.js'
import { getSettings, saveSettings, ranOnLocalRelay } from './settings.js'
import * as gitops from './git.js'
import { installedEditors, openIn } from './editors.js'
import { migrateDir } from './legacy.js'

const TOOL_NAMES = ['Claude Code', 'Cursor', 'Codex', 'Windsurf', 'GitHub Copilot', 'Zed', 'Aider', 'Other']
const COLOR_RE = /^#[0-9a-f]{6}$/i
const LOCAL_RELAY_GONE = "This session ran on your computer's own relay, which Quilt no longer supports. Your files are untouched."

/** Your profile and preferences, from ~/.quilt/settings.json with sensible defaults. */
function profile () {
  const s = getSettings()
  return {
    name: s.name || os.userInfo().username,
    tool: s.tool || detectTool(),
    color: s.color || null,
    joinDir: s.joinDir || '~/quilt',
    shareAgent: s.shareAgent !== false,
    summarize: !!s.summarize,
    preferLocal: !!s.preferLocal
  }
}

/** Checks and saves profile/preference changes. Returns the new profile. */
function updateProfile (b) {
  const patch = {}
  if ('name' in b) {
    const name = String(b.name || '').trim()
    if (!name) throw httpError(400, 'Your name can\'t be empty.')
    if (name.length > 64) throw httpError(400, 'Keep your name under 64 characters.')
    patch.name = name
  }
  if ('tool' in b) {
    if (!TOOL_NAMES.includes(b.tool)) throw httpError(400, 'Pick an AI tool from the list.')
    patch.tool = b.tool
  }
  if ('color' in b) {
    if (b.color && !COLOR_RE.test(b.color)) throw httpError(400, 'That color isn\'t valid.')
    patch.color = b.color || undefined
  }
  if ('joinDir' in b) patch.joinDir = String(b.joinDir || '').trim() || undefined
  if ('shareAgent' in b) patch.shareAgent = b.shareAgent ? undefined : false
  if ('summarize' in b) patch.summarize = b.summarize ? true : undefined
  if ('preferLocal' in b) patch.preferLocal = b.preferLocal ? true : undefined
  saveSettings(patch) // undefined values clear a setting
  return profile()
}
```

2. Change the `startUi` signature to `export async function startUi ({ port = 7420, onShutdown, preview = false } = {})`, delete `let relay = null`, and after `const idFor = …` add:

```js
  // Recent sessions not open now. Ones that ran on a local relay are marked: they can't reopen.
  const recentList = () => recentSessions().filter((r) => !runs.has(idFor(r.dir))).map((r) => ({ ...r, unsupported: ranOnLocalRelay(r.server) }))
```

3. In `start`, change its parameters to `({ mode, dir, name, tool, invite, prefer, repo, branch, newBranch, base })` and replace the `let conn` … block (up to the line before `const entry = …`) with:

```js
    let conn
    let inviteServer
    if (mode === 'join') {
      conn = decodeInvite(invite || '')
    } else if (mode === 'rejoin') {
      const saved = readConfig(dir)
      if (!saved) throw new Error('No previous session in that folder.')
      if (ranOnLocalRelay(saved.server)) throw httpError(400, LOCAL_RELAY_GONE)
      conn = { server: saved.server, room: saved.room, secret: saved.secret, ...(saved.viewSecret ? { viewSecret: saved.viewSecret } : {}) }
      inviteServer = saved.inviteServer
      name = name || saved.name
      tool = tool || saved.tool
    } else {
      conn = newConn()
    }
```

4. Delete the `ensureRelay` function.

5. In the `api` table: `GET /api/state` becomes

```js
    'GET /api/state': () => ({
      sessions: [...runs.keys()].map(summary),
      recent: recentList(),
      defaults: { home: os.homedir(), cwd: process.cwd(), tools: TOOL_NAMES, editors: installedEditors() },
      profile: profile(),
      maxFileBytes: MAX_SHARED_FILE_BYTES
    }),
```

`POST /api/recent/forget` becomes

```js
    'POST /api/recent/forget': (b) => { forgetRecent(path.resolve(expandHome(String(b.dir || '')))); return { recent: recentList() } },
```

and delete the `'POST /api/relay/check'` entry.

6. In the returned `close`, delete `if (relay && !relay.external) await relay.close()`.

7. Delete the `lanAddress` function (nothing uses it now).

- [ ] **Step 6: The app's pages lose the relay UI**

In `src/ui/common.js`, replace the `profile`, `relayStatus` and `relay` lines of `state` with:

```js
  profile: {}, // name, tool, color, joinDir, shareAgent, summarize, preferLocal
```

In `src/ui/app.js`, delete `state.relay = s.relay` from `boot`. In `openInvite`, delete the line `const local = d && !d.server.startsWith('wss://')` and the line that starts `${local ? '<p class="hint warn">This is a local-network address.`.

In `src/ui/session.js`, remove `decodeInvite, ` from the import from `./common.js`, delete the `inviteIsLocal` function, and change the hint line in the empty-invite view to:

```js
          <p class="hint small">Once they join, you'll see their AI chat here as it happens.</p>
```

In `src/ui/home.js`:

1. Delete the line `const isHosted = () => state.profile.relayMode === 'hosted' && !!state.profile.relay`.
2. In `renderShell`, delete the two lines `paintRelayStatus()` and `refreshRelayStatus()`.
3. In `sidebarHtml`, change the Recent part of the sessions menu to skip sessions that can't reopen, and drop the relay status button from the foot:

```js
        ${reopenable.length ? `<div class="pop-sep"></div><div class="pop-label">Recent</div>${reopenable.slice(0, 5).map((r) => `
        <button class="pop-item" role="menuitem" data-rejoin="${esc(r.dir)}"><span class="dot"></span><span class="grow">${esc(basename(r.dir))}</span><span class="hint">${esc(ago(r.lastUsed))}</span></button>`).join('')}` : ''}
```

with `const reopenable = state.recent.filter((r) => !r.unsupported)` added after `const running = …` at the top of `sidebarHtml`, and the foot:

```js
    <div class="side-foot">
      <button class="btn sm ghost side-off" data-shutdown>${I.power}<span>Shut down</span></button>
    </div>
```

4. Delete the whole `// relay status` section (`refreshRelayStatus` and `paintRelayStatus`) and `relayExplainer`.
5. Replace `sessionRows` and `relayLabel` with:

```js
function sessionRows () {
  const running = [...state.sessions.values()].map((s) => ({
    live: true, id: s.id, dir: s.dir, name: s.status.me.name, tool: s.status.me.tool,
    server: s.status.server, peers: s.status.peers.length
  }))
  const recent = state.recent.map((r) => ({ live: false, dir: r.dir, name: r.name, tool: r.tool, server: r.server, lastUsed: r.lastUsed, unsupported: !!r.unsupported }))
  return [...running, ...recent]
}

const relayLabel = (server) => server ? hostOf(server) : ''

function sessionRowHtml (r) {
  if (r.unsupported) {
    return `
      <div class="session-row gone">
        <div class="folder-ico">${I.folder}</div>
        <div class="meta">
          <div class="name">${esc(basename(r.dir))}</div>
          <div class="sub">This session ran on your computer's own relay, which Quilt no longer supports. Your files are untouched.</div>
        </div>
        <div class="facts"><span>${esc(ago(r.lastUsed))}</span></div>
        <div class="acts"><button class="btn sm" data-forget="${esc(r.dir)}">Remove from list</button></div>
      </div>`
  }
  return `
      <div class="session-row${r.live ? ' live' : ''}">
        <div class="folder-ico${r.live ? ' live' : ''}">${I.folder}</div>
        <div class="meta">
          <div class="name">${esc(basename(r.dir))}${r.live ? '<span class="pill ok"><span class="dot"></span>Open</span>' : ''}</div>
          <div class="sub">${esc(tildify(r.dir))}</div>
        </div>
        <div class="facts">
          <span title="Your name there">${I.user}${esc(r.name || '')}</span>
          ${r.server ? `<span title="Relay">${I.globe}${esc(relayLabel(r.server))}</span>` : ''}
          <span>${r.live ? `${r.peers ? `${r.peers} other${r.peers === 1 ? '' : 's'} here` : 'Just you'}` : esc(ago(r.lastUsed))}</span>
        </div>
        <div class="acts">
          ${r.live
            ? `<button class="btn sm primary" data-go="${r.id}">Open</button>`
            : `<button class="btn sm" data-rejoin="${esc(r.dir)}">Rejoin</button>
               <button class="btn sm ghost icon" data-forget="${esc(r.dir)}" title="Remove from this list" aria-label="Remove ${esc(basename(r.dir))} from this list">${I.x}</button>`}
        </div>
      </div>`
}
```

6. In `homeHtml`, replace `<div class="card session-list">${rows.map((r) => \`…\`).join('')}</div>` (the whole inline row template) with:

```js
    <div class="card session-list">${rows.map(sessionRowHtml).join('')}</div>
```

and delete the closing `<section class="card relay-note">…</section>`.

7. In `newSessionDialog`, delete the line `<div class="note">${I.globe}<span>${relayExplainer()}</span></div>`.
8. In `settingsHtml`, delete `const hosted = isHosted() || (!p.relay && p.relayMode === 'hosted')` and the whole `<form class="card settings-sec" id="relay-sec" …>…</form>`.
9. In `bindSettings`, delete `if (form.id === 'relay-sec') state.relayStatus = null` and everything from `const relay = $('#relay-sec')` to the end of the function (the relay mode switch, `check`, and the relay `saveForm`).

In `src/ui/app.css`, add after the `.session-row .acts` rule:

```css
.session-row.gone .sub { white-space: normal; font-family: var(--sans); }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/settings.test.js test/ui.test.js`
Expected: PASS.

Run: `grep -rn "relayMode\|checkRelay\|defaultRelay\|keyFor\|normalizeRelay\|ensureRelay\|relay-sec\|relayStatus\|hostRelay" src bin`
Expected: no output. (The relay's own `relayKey` setting in `src/server.js`, and the `relayKey` URL parameter in `src/connection.js`, stay for self-hosted relays.)

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/settings.js src/runner.js bin/quilt.js src/mcp.js src/ui-server.js src/ui/home.js src/ui/app.js src/ui/session.js src/ui/common.js src/ui/app.css test/settings.test.js test/ui.test.js
git commit -m "One relay: always relay.heyquilt.com; remove relay settings, the app's own relay and quilt relay"
```

---
### Task 7: The app's sign-in screen, sign-out, and the read-only name

**Files:**
- Create: `src/ui/signin.js`
- Modify: `src/ui-server.js` (account routes, gating, passes, `start`, read-only name, static file)
- Modify: `src/ui/app.js` (`boot`, `signedOutNow`, events)
- Modify: `src/ui/common.js` (`state.account`, `api()` reports sign-outs)
- Modify: `src/ui/home.js` (`settingsHtml`, `bindSettings`, imports)
- Modify: `src/ui/app.css` (sign-in screen)
- Modify: `test/ui.test.js` (rewrite: a signed-in computer)
- Create: `test/ui-account.test.js`

**Interfaces:**
- Consumes: `readAccount`, `saveAccount`, `clearAccount`, `startLink`, `waitForLink`, `fetchMe`, `signOut`, `accountFromProfile` (Task 4); `personPasses` (Task 5); `runSession({ passes })` (Task 5); `relayUrl` via `newConn()` (Task 6); `linkDevice`, `startTestApi`, `SITE` (test helpers).
- Produces (app API, all behind the launch token):
  - `GET /api/account` → `{ signedIn: boolean, account: { id, name, email } | null, reason: 'revoked' | null, link: { state: 'waiting' | 'expired' | 'denied' | 'failed', userCode, verificationUrl, error } | null }`
  - `POST /api/account/start` → the same shape, with `link.state: 'waiting'`
  - `POST /api/account/cancel` → the same shape, `link: null`
  - `POST /api/account/signout` → `{ ok: true }`
  - every other route except `GET /api/events` and `POST /api/shutdown`: 401 `{ error: 'Sign in to Quilt first.', signedOut: true }` until signed in
  - SSE events `signed-in` `{}` and `signed-out` `{ reason }`
  - `POST /api/settings` with `name` → 400 `Change your name on heyquilt.com.`; `profile().name` is the account name
- Produces (page): `renderSignIn(message?: string, onSignedIn?: () => void)` in `src/ui/signin.js`; `signedOutNow(message?: string)` exported from `src/ui/app.js`.

- [ ] **Step 1: Write the failing tests**

Create `test/ui-account.test.js`:

```js
// The app's sign-in: until this computer is linked to an account the app only
// offers to sign in. Signing out, or being signed out from the website, brings
// that back.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-account-'))
process.env.HOME = home

const { startUi } = await import('../src/ui-server.js')
const { startServer } = await import('../src/server.js')
const { startTestApi, SITE } = await import('./api-helpers.js')
const { newPassKeys } = await import('../src/passes.js')

const accountFile = path.join(home, '.quilt', 'account.json')
const SIGNED_OUT = { signedIn: false, account: null, reason: null, link: null }
let ui, accounts, relay
before(async () => {
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  ui = await startUi({ port: 0 })
})
after(async () => { await ui.close(); await relay.close(); await accounts.close() })

const call = (app, method, p, body) => fetch(`http://127.0.0.1:${app.port}${p}`, {
  method,
  headers: { 'x-quilt-token': app.token, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))
const api = (method, p, body) => call(ui, method, p, body)
async function waitFor (fn, ms = 10000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error('timed out')
}
const tokenOnDisk = () => JSON.parse(fs.readFileSync(accountFile, 'utf8')).token
const revoke = (token) => accounts.call('POST', '/v1/me/signout', {}, null, { authorization: `Bearer ${token}` })

/** Signs this computer in through the app, approving it on the "website" as Mo. */
async function signIn () {
  const started = await api('POST', '/api/account/start')
  assert.equal(started.status, 200, JSON.stringify(started.body))
  await accounts.call('POST', '/v1/device/approve', { userCode: started.body.link.userCode, approve: true }, 'mem')
  return waitFor(async () => { const r = await api('GET', '/api/account'); return r.body.signedIn && r.body })
}

test('signed out, the app only offers to sign in', async () => {
  assert.deepEqual((await api('GET', '/api/account')).body, SIGNED_OUT)
  for (const [method, p, body] of [['GET', '/api/state'], ['GET', '/api/settings'], ['POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'x') }]]) {
    const r = await api(method, p, body)
    assert.equal(r.status, 401, p)
    assert.deepEqual(r.body, { error: 'Sign in to Quilt first.', signedOut: true }, p)
  }
  assert.match(await (await fetch(`http://127.0.0.1:${ui.port}/app.js`)).text(), /renderSignIn/)
  const screen = await (await fetch(`http://127.0.0.1:${ui.port}/signin.js`)).text()
  for (const copy of ['Sign in to Quilt', 'New to Quilt? <a', 'Create an account', 'https://heyquilt.com/signup', 'Approve this computer in your browser', 'Cancel', 'Open the page again']) {
    assert.ok(screen.includes(copy), copy)
  }
})

test('starting to sign in shows a code to approve, and cancelling forgets it', async () => {
  const started = await api('POST', '/api/account/start')
  assert.equal(started.body.link.state, 'waiting')
  assert.match(started.body.link.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  assert.equal(started.body.link.verificationUrl, `${SITE}/link?code=${started.body.link.userCode}`)
  assert.equal((await api('POST', '/api/account/cancel')).body.link, null)
  assert.deepEqual((await api('GET', '/api/account')).body, SIGNED_OUT)
})

test('approving on the website signs the app in; your name is your account name', async () => {
  const acc = await signIn()
  assert.deepEqual(acc.account, { id: 'mem', name: 'Mo', email: 'mo@acme.com' })
  assert.equal(fs.statSync(accountFile).mode & 0o777, 0o600)
  assert.equal((await api('GET', '/api/settings')).body.name, 'Mo')
  const renamed = await api('POST', '/api/settings', { name: 'Someone else' })
  assert.equal(renamed.status, 400)
  assert.equal(renamed.body.error, 'Change your name on heyquilt.com.')
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'proj') })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.equal(s.body.status.me.name, 'Mo')
  await api('POST', `/api/sessions/${s.body.id}/stop`)
})

test('signing out revokes this computer, stops its sessions and deletes account.json', async () => {
  const token = tokenOnDisk()
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'proj2') })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.deepEqual((await api('POST', '/api/account/signout')).body, { ok: true })
  assert.equal(fs.existsSync(accountFile), false)
  assert.equal((await accounts.call('GET', '/v1/me', null, null, { authorization: `Bearer ${token}` })).status, 401, 'revoked on the server')
  assert.deepEqual((await api('GET', '/api/account')).body, SIGNED_OUT)
  await waitFor(() => [...relay.rooms.values()].every((r) => r.conns.size === 0))
})

test('a computer signed out from the website goes back to sign-in, saying so', async () => {
  await signIn()
  await revoke(tokenOnDisk())
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'proj3') })
  assert.equal(s.status, 401)
  assert.equal(s.body.signedOut, true)
  assert.equal(fs.existsSync(accountFile), false)
  assert.deepEqual((await api('GET', '/api/account')).body, { ...SIGNED_OUT, reason: 'revoked' })
})

test('opening the app notices a sign-out that happened while it was closed', async () => {
  await signIn()
  await revoke(tokenOnDisk())
  const again = await startUi({ port: 0 })
  try {
    const r = await call(again, 'GET', '/api/account')
    assert.deepEqual(r.body, { ...SIGNED_OUT, reason: 'revoked' })
    assert.equal(fs.existsSync(accountFile), false)
  } finally {
    await again.close()
  }
})
```

Replace `test/ui.test.js` with:

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-home-'))
process.env.HOME = home // keep recent.json, account.json and the identity out of the real home

const { startUi } = await import('../src/ui-server.js')
const { startServer } = await import('../src/server.js')
const { startTestApi, linkDevice } = await import('./api-helpers.js')
const { newPassKeys } = await import('../src/passes.js')
const { loadIdentity } = await import('../src/identity.js')
const { saveAccount } = await import('../src/account.js')
let ui, base, relay, accounts
let shutdowns = 0

before(async () => {
  // A signed-in computer: an accounts API that signs passes, a relay that needs them, and account.json.
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  const { token } = await linkDevice(accounts, 'mem', loadIdentity())
  saveAccount({ token, account: { id: 'mem', name: 'Mo', email: 'mo@acme.com' }, signedInAt: Date.now() })
  ui = await startUi({ port: 0, onShutdown: () => { shutdowns++ } })
  base = `http://127.0.0.1:${ui.port}`
})
after(async () => { await ui.close(); await relay.close(); await accounts.close() })

const api = (method, p, body) => fetch(base + p, {
  method,
  headers: { 'x-quilt-token': ui.token, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))

test('serves the app and logo without a token', async () => {
  const page = await fetch(base + '/')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<script type="module" src="\/app.js">/)
  assert.equal((await fetch(base + '/logo.svg')).headers.get('content-type'), 'image/svg+xml')
})

test('API requires the launch token', async () => {
  const r = await fetch(base + '/api/state')
  assert.equal(r.status, 401)
})

test('rejects requests for other hostnames (DNS rebinding)', async () => {
  const http = await import('node:http')
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: ui.port, path: '/api/state', headers: { host: 'evil.example.com', 'x-quilt-token': ui.token } }, (res) => resolve(res.statusCode))
  })
  assert.equal(status, 403)
})

test('create a session, chat, send a file, stop', async () => {
  const dir = path.join(home, 'proj')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello')
  const created = await api('POST', '/api/sessions', { mode: 'create', dir, tool: 'Claude Code' })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const id = created.body.id
  assert.ok(created.body.invite)
  assert.equal(created.body.status.me.name, 'Mo', 'named after the account')

  const said = await api('POST', `/api/sessions/${id}/say`, { text: 'hi' })
  assert.equal(said.body.text, 'hi')

  const up = await fetch(`${base}/api/sessions/${id}/send`, {
    method: 'POST',
    headers: { 'x-quilt-token': ui.token, 'x-filename': encodeURIComponent('notes.txt'), 'x-text': encodeURIComponent('see notes') },
    body: 'some notes'
  })
  const sent = await up.json()
  assert.equal(sent.file.name, 'notes.txt')
  const dl = await fetch(`${base}/api/sessions/${id}/files/${sent.id}?t=${ui.token}`)
  assert.equal(await dl.text(), 'some notes')

  const { body: { messages } } = await api('GET', `/api/sessions/${id}/messages`)
  assert.deepEqual(messages.map((m) => m.text), ['hi', 'see notes'])

  const state = await api('GET', '/api/state')
  assert.equal(state.body.sessions.length, 1)
  await api('POST', `/api/sessions/${id}/stop`)
  const after = await api('GET', '/api/state')
  assert.equal(after.body.sessions.length, 0)
  assert.equal(after.body.recent[0].dir, dir, 'stopped session shows up under Recent')
})

test('bad invite gives a friendly error', async () => {
  const r = await api('POST', '/api/sessions', { mode: 'join', dir: path.join(home, 'x'), invite: 'nonsense' })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /invite link is not valid/)
})

test('shut down asks the host to stop everything', async () => {
  const r = await api('POST', '/api/shutdown')
  assert.equal(r.status, 200)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(shutdowns, 1)
})

test('agent feed workspace: tree, file, folder claim, sharing, feed', async () => {
  const dir = path.join(home, 'workspace')
  fs.mkdirSync(path.join(dir, 'src', 'auth'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'auth', 'login.ts'), 'export const login = 1\n')
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0, 1, 2, 3]))
  // A Claude Code conversation in this folder, so the reader has something to share.
  const { slugFor } = await import('../src/agents/claude-code.js')
  const tdir = path.join(home, '.claude', 'projects', slugFor(dir))
  fs.mkdirSync(tdir, { recursive: true })
  fs.writeFileSync(path.join(tdir, 't.jsonl'), [
    { type: 'user', uuid: 'u1', sessionId: 't', cwd: dir, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Add a login form' } },
    { type: 'assistant', uuid: 'a1', sessionId: 't', cwd: dir, timestamp: new Date().toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(dir, 'src/auth/login.ts') } }, { type: 'text', text: 'Added it.' }] } }
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')

  const created = await api('POST', '/api/sessions', { mode: 'create', dir, tool: 'Claude Code' })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const id = created.body.id

  const tree = await api('GET', `/api/sessions/${id}/tree`)
  const byPath = Object.fromEntries(tree.body.files.map((f) => [f.path, f]))
  assert.ok(byPath['src/auth/login.ts'])
  assert.equal(byPath['logo.png'].binary, true)
  assert.equal(byPath['src/auth/login.ts'].edited.by, 'Mo')

  const text = await api('GET', `/api/sessions/${id}/file?path=${encodeURIComponent('src/auth/login.ts')}`)
  assert.equal(text.body.text, 'export const login = 1\n')
  const bin = await api('GET', `/api/sessions/${id}/file?path=logo.png`)
  assert.deepEqual(bin.body, { path: 'logo.png', binary: true, size: 6 })
  for (const bad of ['../secret', '/etc/passwd', 'src/../../x', 'nope.txt', '.quilt/config.json']) {
    const r = await api('GET', `/api/sessions/${id}/file?path=${encodeURIComponent(bad)}`)
    assert.equal(r.status, 404, bad)
  }

  const claim = await api('POST', `/api/sessions/${id}/claim`, { pattern: 'src/auth', note: 'rewriting auth' })
  assert.equal(claim.status, 200)
  const tree2 = await api('GET', `/api/sessions/${id}/tree`)
  assert.equal(tree2.body.files.find((f) => f.path === 'src/auth/login.ts').claim.pattern, 'src/auth')

  // The transcript was picked up and shared.
  let feed
  for (let i = 0; i < 40; i++) {
    feed = await api('GET', `/api/sessions/${id}/feed?who=Mo`)
    if (feed.body.entries.length >= 3) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.deepEqual(feed.body.entries.map((e) => [e.kind, e.text]), [
    ['prompt', 'Add a login form'], ['action', 'Edited src/auth/login.ts'], ['reply', 'Added it.']
  ])

  assert.deepEqual((await api('POST', `/api/sessions/${id}/sharing`, { on: false })).body, { on: false })
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.quilt', 'config.json'), 'utf8'))
  assert.equal(cfg.shareAgent, false, 'pause is remembered')
  const st = await api('GET', '/api/state')
  assert.equal(st.body.sessions.find((s) => s.id === id).status.me.agent.sharing, false)
  await api('POST', `/api/sessions/${id}/sharing`, { on: true })
  feed = await api('GET', `/api/sessions/${id}/feed?who=Mo`)
  assert.deepEqual(feed.body.entries.slice(-2).map((e) => e.kind), ['paused', 'resumed'])
  await api('POST', `/api/sessions/${id}/stop`)
})

test("a session that ran on this computer's own relay is marked, and can't be reopened", async () => {
  const dir = path.join(home, 'old-local')
  fs.mkdirSync(path.join(dir, '.quilt'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.quilt', 'config.json'), JSON.stringify({ server: 'ws://127.0.0.1:4321', room: 'room-old', secret: 's', name: 'me' }))
  const recentFile = path.join(home, '.quilt', 'recent.json')
  const list = fs.existsSync(recentFile) ? JSON.parse(fs.readFileSync(recentFile, 'utf8')) : []
  fs.writeFileSync(recentFile, JSON.stringify([{ dir, room: 'room-old', server: 'ws://127.0.0.1:4321', name: 'me', tool: 'Cursor', lastUsed: Date.now() }, ...list]))
  const st = await api('GET', '/api/state')
  assert.equal(st.body.recent.find((r) => r.dir === dir).unsupported, true)
  assert.equal(st.body.relay, undefined, 'no relay settings any more')
  assert.ok(st.body.recent.filter((r) => r.dir !== dir).every((r) => r.unsupported === false))
  const r = await api('POST', '/api/sessions', { mode: 'rejoin', dir })
  assert.equal(r.status, 400)
  assert.equal(r.body.error, "This session ran on your computer's own relay, which Quilt no longer supports. Your files are untouched.")
  assert.ok(fs.existsSync(path.join(dir, '.quilt', 'config.json')), 'the folder is untouched')
  assert.equal((await api('POST', '/api/relay/check', { url: 'ws://127.0.0.1:9' })).status, 404)
})

test('settings: colour and AI tool are saved and used by new sessions; the name comes from the account', async () => {
  assert.equal((await api('POST', '/api/settings', { color: 'red' })).status, 400)
  assert.equal((await api('POST', '/api/settings', { tool: 'Notepad' })).status, 400)
  const renamed = await api('POST', '/api/settings', { name: 'Robin' })
  assert.equal(renamed.status, 400)
  assert.equal(renamed.body.error, 'Change your name on heyquilt.com.')
  const saved = await api('POST', '/api/settings', { color: '#3b6a9a', tool: 'Cursor', shareAgent: false })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.name, 'Mo')
  assert.equal(saved.body.shareAgent, false)
  assert.equal((await api('GET', '/api/state')).body.profile.color, '#3b6a9a')

  const dir = path.join(home, 'profiled')
  const s = await api('POST', '/api/sessions', { mode: 'create', dir })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.equal(s.body.status.me.name, 'Mo')
  assert.equal(s.body.status.me.tool, 'Cursor')
  assert.equal(s.body.status.me.color, '#3b6a9a')
  assert.equal(s.body.status.me.agent.sharing, false, 'sharing follows the setting')
  await api('POST', `/api/sessions/${s.body.id}/stop`)

  const forgot = await api('POST', '/api/recent/forget', { dir })
  assert.ok(!forgot.body.recent.some((r) => r.dir === dir))
  assert.ok(fs.existsSync(path.join(dir, '.quilt', 'config.json')), 'forgetting leaves the folder alone')
})

test('the owner can end a session for everyone from the app', async () => {
  const dir = path.join(home, 'ending')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'bye')
  const created = await api('POST', '/api/sessions', { mode: 'create', dir, tool: 'Claude Code' })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const id = created.body.id
  for (let i = 0; i < 50; i++) {
    const state = await api('GET', '/api/state')
    const s = state.body.sessions.find((s) => s.id === id)
    if (s?.status?.access?.owner) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const r = await api('POST', `/api/sessions/${id}/end`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body, { ok: true })
  const state = await api('GET', '/api/state')
  assert.equal(state.body.sessions.filter((s) => s.id === id).length, 0, 'stopped locally')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/ui-account.test.js test/ui.test.js`
Expected: FAIL. `ui-account.test.js`: `GET /api/account` is a 404. `ui.test.js`: sessions are named after the settings name (and the relay refuses them: no pass).

- [ ] **Step 3: Account routes, gating and passes in `src/ui-server.js`**

Add to the imports:

```js
import { readAccount, saveAccount, clearAccount, startLink, waitForLink, fetchMe, signOut, accountFromProfile } from './account.js'
import { personPasses } from './pass-source.js'
import { loadIdentity } from './identity.js'
```

After `const LOCAL_RELAY_GONE = …` add:

```js
// Until this computer is signed in, only these answer.
const OPEN_ROUTES = new Set(['GET /api/account', 'POST /api/account/start', 'POST /api/account/cancel', 'POST /api/account/signout', 'GET /api/events', 'POST /api/shutdown'])
```

In `profile()`, take the name from the account:

```js
  const account = readAccount()
  return {
    name: account ? account.account.name : os.userInfo().username,
```

(the other fields stay), and in `updateProfile` replace the whole `if ('name' in b) { … }` block with:

```js
  // Your name is your account's: it's changed on the website.
  if ('name' in b) throw httpError(400, 'Change your name on heyquilt.com.')
```

Add `'/signin.js': ['signin.js', 'text/javascript; charset=utf-8'],` to `STATIC`.

Inside `startUi`, after `const clients = new Set() // SSE responses` add:

```js
  let passes = null // this computer's passes, shared by all its sessions
  let link = null // signing in: what startLink returned, plus { state, error }
  let signedOutReason = null // 'revoked' once the API turned this computer's token away
  let checkedToken = false // asked the API about the saved token since the app started

  const accountPasses = () => {
    if (passes) return passes
    const account = readAccount()
    if (!account) throw Object.assign(httpError(401, 'Sign in to Quilt first.'), { signedOut: true })
    passes = personPasses({ token: account.token })
    return passes
  }

  /** Forgets this computer's sign-in and stops its sessions. 'revoked': the API turned the token away. */
  async function signedOut (reason) {
    passes = null
    for (const id of [...runs.keys()]) await stop(id)
    clearAccount()
    signedOutReason = reason
    broadcast('signed-out', { reason })
  }

  async function accountState () {
    let account = readAccount()
    if (account && !checkedToken) {
      checkedToken = true
      try {
        // Picks up a name changed on heyquilt.com, and notices a computer signed out from there.
        const fresh = { ...account, account: accountFromProfile(await fetchMe({ token: account.token })) }
        saveAccount(fresh)
        account = fresh
      } catch (err) {
        if (err.status === 401) { await signedOut('revoked'); account = null }
        // Anything else (offline): keep the saved sign-in.
      }
    }
    return {
      signedIn: !!account,
      account: account ? account.account : null,
      reason: account ? null : signedOutReason,
      link: link ? { state: link.state, userCode: link.userCode, verificationUrl: link.verificationUrl, error: link.error } : null
    }
  }

  /** Starts linking this computer; the website approves it, and we collect the token in the background. */
  async function beginLink () {
    const identity = loadIdentity()
    const mine = { ...await startLink({ identity }), state: 'waiting', error: null }
    link = mine
    waitForLink({ identity, link: mine, stopped: () => link !== mine }).then((r) => {
      if (link !== mine) return
      saveAccount({ token: r.token, account: accountFromProfile(r.profile), signedInAt: Date.now() })
      link = null
      passes = null
      signedOutReason = null
      checkedToken = true
      broadcast('signed-in', {})
    }, (err) => {
      if (link !== mine) return
      mine.state = err.expired ? 'expired' : err.denied ? 'denied' : 'failed'
      mine.error = err.message
    })
    return accountState()
  }
```

Replace the whole `start` function with:

```js
  async function start ({ mode, dir, tool, invite, prefer, repo, branch, newBranch, base }) {
    const me = profile()
    // Every session signs in to the relay as this computer's account.
    const sessionPasses = accountPasses()
    if (mode === 'github') {
      // Clone first, then start a normal session on the clone.
      const repoName = String(repo || '').split('/').pop()
      dir = path.resolve(expandHome(dir || path.join(me.joinDir, repoName || 'repo')))
      if (runs.has(idFor(dir))) throw httpError(400, 'A session is already running in that folder.')
      await gitops.cloneRepo({ repo, dir, branch, newBranch, base })
      mode = 'create'
    }
    tool = tool || me.tool
    prefer = prefer || (me.preferLocal ? 'local' : 'remote')
    if (mode === 'join' && !dir) {
      const inv = decodeInvite(invite || '')
      dir = path.join(expandHome(me.joinDir), inv.room)
    }
    if (!dir) throw new Error('Choose a project folder.')
    dir = path.resolve(expandHome(dir))
    const id = idFor(dir)
    if (runs.has(id)) return summary(id)

    let conn
    let inviteServer
    if (mode === 'join') {
      conn = decodeInvite(invite || '')
    } else if (mode === 'rejoin') {
      const saved = readConfig(dir)
      if (!saved) throw new Error('No previous session in that folder.')
      if (ranOnLocalRelay(saved.server)) throw httpError(400, LOCAL_RELAY_GONE)
      conn = { server: saved.server, room: saved.room, secret: saved.secret, ...(saved.viewSecret ? { viewSecret: saved.viewSecret } : {}) }
      inviteServer = saved.inviteServer
      tool = tool || saved.tool
    } else {
      conn = newConn()
    }

    const entry = { logs: [], joined: mode === 'join' }
    const log = (line) => {
      entry.logs.push({ ts: Date.now(), line })
      if (entry.logs.length > 200) entry.logs.shift()
      broadcast('log', { id, ts: Date.now(), line })
    }
    try {
      entry.run = await runSession({
        dir,
        conn,
        tool,
        color: me.color,
        shareByDefault: me.shareAgent,
        summarizeByDefault: me.summarize,
        joined: mode === 'join',
        prefer: prefer === 'local' ? 'local' : 'remote',
        inviteServer,
        passes: sessionPasses,
        onLog: log,
        onFatal: async (err) => {
          log(`stopped: ${err.message}`)
          await stop(id)
          if (err.signedOut) await signedOut('revoked')
        }
      })
    } catch (err) {
      if (err.signedOut) {
        await signedOut('revoked')
        throw Object.assign(httpError(401, err.message), { signedOut: true })
      }
      throw err
    }
    runs.set(id, entry)
    const s = entry.run.session
    s.on('status-changed', () => pushStatus(id))
    s.on('access', () => pushStatus(id))
    s.on('message', (m) => broadcast('message', { id, message: m }))
    s.on('agent-feed', (entries) => broadcast('feed', { id, entries }))
    s.on('file-changed', (e) => broadcast('file-changed', { id, ...e }))
    // Presence changes (e.g. focus, recently edited files) also refresh the view.
    s.conn.awareness.on('change', () => pushStatus(id))
    return summary(id)
  }
```

Add these entries at the top of the `api` table:

```js
    'GET /api/account': () => accountState(),
    'POST /api/account/start': () => beginLink(),
    'POST /api/account/cancel': () => { link = null; return accountState() },
    'POST /api/account/signout': async () => {
      const account = readAccount()
      passes = null
      link = null
      for (const id of [...runs.keys()]) await stop(id)
      await signOut({ token: account?.token })
      signedOutReason = null
      return { ok: true }
    },
```

In the request handler, make the first lines inside `try {` (before the `/api/events` check):

```js
      if (!OPEN_ROUTES.has(`${req.method} ${url.pathname}`) && !readAccount()) return json(401, { error: 'Sign in to Quilt first.', signedOut: true })
```

and change its `catch` to pass the sign-out flag through:

```js
    } catch (err) {
      return json(err.status || 400, { error: err.message, ...(err.signedOut ? { signedOut: true } : {}) })
    }
```

In the returned `close`, add `link = null` as its first line.

- [ ] **Step 4: The sign-in screen**

Create `src/ui/signin.js`:

```js
// The sign-in screen. Until this computer is linked to a heyquilt.com account the
// app shows only this. Signing in opens the website, where you approve this computer.
import { $, esc, api } from './common.js'
import { quiltMark } from './mark.js'

const SIGNUP = 'https://heyquilt.com/signup'
let poller = null

function screen (inner) {
  clearInterval(poller)
  $('#app').innerHTML = `<div class="signin"><div class="card signin-card">
    <div class="signin-mark">${quiltMark({ word: false })}</div>
    ${inner}
  </div></div>`
}

/** Shows the sign-in screen. `onSignedIn` runs once this computer is approved. */
export function renderSignIn (message = '', onSignedIn = () => location.reload()) {
  screen(`
    <h1>Sign in to Quilt</h1>
    ${message ? `<p class="signin-note">${esc(message)}</p>` : ''}
    <button class="btn primary signin-btn" id="signin-go">Sign in</button>
    <p class="hint">New to Quilt? <a href="${SIGNUP}" target="_blank" rel="noopener">Create an account</a></p>
    <p class="error" id="signin-error"></p>`)
  $('#signin-go').onclick = () => begin(onSignedIn)
}

async function begin (onSignedIn) {
  const btn = $('#signin-go')
  btn.disabled = true
  try {
    const acc = await api('POST', '/api/account/start')
    window.open(acc.link.verificationUrl, '_blank', 'noopener')
    waiting(acc.link, onSignedIn)
  } catch (err) {
    btn.disabled = false
    $('#signin-error').textContent = err.message
  }
}

function waiting (link, onSignedIn) {
  screen(`
    <h1>Sign in to Quilt</h1>
    <p>Approve this computer in your browser</p>
    <div class="signin-code" aria-label="Your code">${esc(link.userCode)}</div>
    <p class="hint">Check the page shows this code.</p>
    <div class="signin-actions"><button class="btn" id="signin-cancel">Cancel</button><button class="btn primary" id="signin-again">Open the page again</button></div>`)
  $('#signin-again').onclick = () => window.open(link.verificationUrl, '_blank', 'noopener')
  $('#signin-cancel').onclick = async () => {
    await api('POST', '/api/account/cancel').catch(() => {})
    renderSignIn('', onSignedIn)
  }
  poller = setInterval(async () => {
    let acc
    try { acc = await api('GET', '/api/account') } catch { return }
    if (acc.signedIn) { clearInterval(poller); onSignedIn(); return }
    const st = acc.link && acc.link.state
    if (st === 'expired') over('That code expired. Start over to get a new one.', onSignedIn)
    else if (st === 'denied') over('This computer was not approved. Start over to try again.', onSignedIn)
    else if (st === 'failed') over(acc.link.error || 'Signing in did not work. Start over to try again.', onSignedIn)
  }, 2000)
}

function over (message, onSignedIn) {
  screen(`
    <h1>Sign in to Quilt</h1>
    <p class="signin-note">${esc(message)}</p>
    <button class="btn primary signin-btn" id="signin-go">Start over</button>`)
  $('#signin-go').onclick = () => begin(onSignedIn)
}
```

- [ ] **Step 5: Boot into sign-in, and back to it on sign-out**

In `src/ui/common.js`, add to `state` after `loaded: false,`:

```js
  account: null, // { id, name, email }: who this computer is signed in as
```

and replace the error line in `api()` (`if (!res.ok) throw new Error(…)`) with:

```js
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`)
    // This computer isn't signed in (any more): the app goes back to the sign-in screen.
    if (res.status === 401 && data.signedOut) {
      err.signedOut = true
      window.dispatchEvent(new Event('quilt-signed-out'))
    }
    throw err
  }
```

In `src/ui/app.js`, add `import { renderSignIn } from './signin.js'`, and replace `boot` with:

```js
const SIGNED_OUT = 'This computer was signed out. Sign in again.'

async function boot () {
  if (!TOKEN) return renderLocked()
  // Shown only if loading takes a moment: the Q pieces itself together while we wait.
  const waiting = setTimeout(() => { if (!state.loaded) $('#app').innerHTML = `<div class="booting">${quiltMark({ word: false, loop: true })}</div>` }, 250)
  try {
    const acc = await api('GET', '/api/account')
    if (!acc.signedIn) {
      clearTimeout(waiting)
      return renderSignIn(acc.reason === 'revoked' ? SIGNED_OUT : '', boot)
    }
    state.account = acc.account
    const s = await api('GET', '/api/state')
    state.recent = s.recent
    state.defaults = s.defaults
    state.profile = s.profile
    state.maxFileBytes = s.maxFileBytes
    for (const sum of s.sessions) state.sessions.set(sum.id, sum)
    state.loaded = true
    clearTimeout(waiting)
    const last = recall('view')
    state.view = state.sessions.has(last) || last === 'settings' ? last : (state.sessions.size ? [...state.sessions.keys()][0] : 'home')
    if (isSession(state.view)) await loadMessages(state.view)
    if (!state.events) connectEvents()
    render()
    // Invite links that opened the desktop app wait until you're signed in.
    if (!boot.invites) { boot.invites = true; window.quiltDesktop?.onInvite(openInviteLink) }
  } catch (err) {
    clearTimeout(waiting)
    if (!err.signedOut) renderLocked(err.message)
  }
}

/** Back to the sign-in screen: after Sign out, or when the API turned this computer away. */
export function signedOutNow (message = '') {
  state.events?.close()
  state.events = null
  state.loaded = false
  state.account = null
  for (const m of [state.sessions, state.messages, state.feeds, state.trees, state.files]) m.clear()
  document.querySelectorAll('.modal-back').forEach((m) => m.remove())
  renderSignIn(message, boot)
}

window.addEventListener('quilt-signed-out', () => signedOutNow(SIGNED_OUT))
```

and in `connectEvents`, after the `stopped` listener, add:

```js
  es.addEventListener('signed-out', (e) => {
    const { reason } = JSON.parse(e.data)
    signedOutNow(reason === 'revoked' ? SIGNED_OUT : '')
  })
```

- [ ] **Step 6: Settings: an Account section, Sign out, and a read-only name**

In `src/ui/home.js`, change the imports to:

```js
import { I, state, $, esc, basename, ago, toast, api, ask, decodeInvite, avatar, PALETTE } from './common.js'
import { go, pickFolder, signedOutNow } from './app.js'
```

Replace `settingsHtml` with:

```js
function settingsHtml () {
  const p = state.profile
  const a = state.account || { name: p.name, email: '' }
  return `
  <header class="page-head">
    <h1>Settings</h1>
    <p>Saved on this computer and used for every new session.</p>
  </header>

  <section class="card settings-sec" id="account-sec">
    <div class="sec-intro"><h2>Account</h2><p>This computer is signed in to your heyquilt.com account.</p></div>
    <div class="sec-body">
      <div class="kv"><span>Signed in as</span><b>${esc(a.name)}</b><span class="hint">${esc(a.email)}</span></div>
      <div class="sec-actions"><span class="hint">Signing out stops your sessions on this computer. Your files stay put.</span><button class="btn" type="button" id="sign-out">Sign out</button></div>
    </div>
  </section>

  <form class="card settings-sec" id="profile-sec" autocomplete="off">
    <div class="sec-intro"><h2>Profile</h2><p>How you show up to the people you code with.</p></div>
    <div class="sec-body">
      <div class="profile-preview" id="pv">${avatar(p.name, p.color)}<div><b id="pv-name">${esc(p.name)}</b><span id="pv-tool">coding with ${esc(p.tool)}</span></div></div>
      <div class="field">
        <label for="s-name">Name</label>
        <input class="input" id="s-name" value="${esc(p.name)}" readonly>
        <span class="hint"><a href="https://heyquilt.com/settings" target="_blank" rel="noopener">Change it on heyquilt.com</a></span>
      </div>
      <div class="field">
        <span class="label">Color</span>
        <div class="swatches" role="radiogroup" aria-label="Color">
          <label class="swatch auto" title="Automatic"><input type="radio" name="color" value="" ${p.color ? '' : 'checked'}><span>Auto</span></label>
          ${PALETTE.map((c) => `<label class="swatch" title="${c}"><input type="radio" name="color" value="${c}" ${p.color === c ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}
        </div>
      </div>
      <div class="field">
        <label for="s-tool">AI tool you use</label>
        <select class="input" id="s-tool" name="tool">${state.defaults.tools.map((t) => `<option ${t === p.tool ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <span class="hint">Shown next to your name, and used to find your AI chat so partners can follow along.</span>
      </div>
      <div class="sec-actions"><span class="hint">New sessions use this. Rejoin a running session to update it there.</span><button class="btn primary" type="submit">Save profile</button></div>
    </div>
  </form>

  <form class="card settings-sec" id="sessions-sec" autocomplete="off">
    <div class="sec-intro"><h2>Sessions</h2><p>Defaults for starting and joining.</p></div>
    <div class="sec-body">
      <div class="field">
        <label for="s-joindir">Put projects you join in</label>
        <div class="row"><input class="input grow" id="s-joindir" name="joinDir" value="${esc(p.joinDir)}">
        <button type="button" class="btn icon" data-browse-settings="s-joindir" title="Browse" aria-label="Browse">${I.folder}</button></div>
        <span class="hint">Each session gets its own folder in here.</span>
      </div>
      ${toggle('shareAgent', p.shareAgent, 'Share my AI chat', 'Partners see your prompts, the replies and which files it touches. You can pause it inside any session.')}
      ${toggle('summarize', p.summarize, 'Summarize my chats', 'Your prompts and your AI’s replies are shortened to a sentence or two on this computer before they’re shared. Uses your claude CLI (a few Haiku tokens each); if it isn’t available, the text is just shortened.')}
      ${toggle('preferLocal', p.preferLocal, 'Keep my files when joining a folder that has some', 'When off, their versions of the same files win.')}
      <div class="sec-actions"><span></span><button class="btn primary" type="submit">Save</button></div>
    </div>
  </form>

  <section class="card settings-sec">
    <div class="sec-intro"><h2>This computer</h2><p>Where Quilt keeps things.</p></div>
    <div class="sec-body">
      <div class="kv"><span>Identity key</span><code>~/.quilt/identity.json</code><span class="hint">Proves your name is yours. Copy it to another computer to keep your name there.</span></div>
      <div class="kv"><span>Sign-in</span><code>~/.quilt/account.json</code><span class="hint">This computer's sign-in. Only you can read it.</span></div>
      <div class="kv"><span>Settings</span><code>~/.quilt/settings.json</code></div>
      <div class="sec-actions"><span class="hint">Stops every session and this app. Your files stay put.</span><button class="btn" type="button" data-shutdown>${I.power}<span>Shut down Quilt</span></button></div>
    </div>
  </section>`
}
```

Replace `bindSettings` with:

```js
function bindSettings () {
  const saveForm = (form, pick, done) => {
    form.onsubmit = async (e) => {
      e.preventDefault()
      const btn = form.querySelector('button[type=submit]')
      btn.disabled = true
      try {
        state.profile = await api('POST', '/api/settings', pick(new FormData(form)))
        toast('Saved')
        renderShell('settings')
        done && done()
      } catch (err) {
        toast(err.message)
        btn.disabled = false
      }
    }
  }

  // Profile: live preview while picking. The name comes from the account.
  const prof = $('#profile-sec')
  const preview = () => {
    const f = new FormData(prof)
    $('#pv').querySelector('.avatar').outerHTML = avatar(state.profile.name, f.get('color') || null)
    $('#pv-tool').textContent = `coding with ${f.get('tool')}`
  }
  prof.addEventListener('input', preview)
  prof.addEventListener('change', preview)
  saveForm(prof, (f) => ({ color: f.get('color'), tool: f.get('tool') }))

  const sess = $('#sessions-sec')
  sess.querySelector('[data-browse-settings]').onclick = () => pickFolder($('#s-joindir'))
  saveForm(sess, (f) => ({ joinDir: f.get('joinDir'), shareAgent: !!f.get('shareAgent'), summarize: !!f.get('summarize'), preferLocal: !!f.get('preferLocal') }))

  $('#sign-out').onclick = async () => {
    if (!await ask({ title: 'Sign out of Quilt?', message: 'This stops your sessions on this computer. Your files stay where they are.', ok: 'Sign out', danger: true })) return
    try {
      await api('POST', '/api/account/signout')
      signedOutNow()
    } catch (err) {
      toast(err.message)
    }
  }
}
```

In `src/ui/app.css`, add at the end:

```css
/* Sign-in screen */
.signin { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; }
.signin-card { width: 100%; max-width: 400px; display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; padding: 36px 28px; }
.signin-card h1 { margin: 0; font-size: 24px; letter-spacing: -0.01em; }
.signin-card p { margin: 0; }
.signin-mark svg { width: 56px; height: 56px; }
.signin-note { color: var(--warn); }
.signin-btn { width: 100%; justify-content: center; }
.signin-code { font-family: var(--mono); font-size: 28px; font-weight: 600; letter-spacing: .12em; padding: 12px 20px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-2); }
.signin-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/ui-account.test.js test/ui.test.js`
Expected: PASS (sign-ins wait for the API's 3-second poll, so the account test takes about 15 seconds).

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Check the screen by eye**

Run the app against a local stack and look at the sign-in screen, the waiting screen and Settings:

```bash
node bin/quilt.js api --memory --port 8787   # prints QUILT_PASS_PUBLIC_KEY=… for the next line
QUILT_PASS_PUBLIC_KEY=<printed key> node bin/quilt.js serve --port 4399 --data "$(mktemp -d)"
HOME="$(mktemp -d)" QUILT_API_URL=http://127.0.0.1:8787 QUILT_SERVER=ws://127.0.0.1:4399 node bin/quilt.js ui --port 7488
```

Click **Sign in**, then approve with `curl -s -X POST http://127.0.0.1:8787/v1/device/approve -H 'authorization: Bearer local' -H 'content-type: application/json' -d '{"userCode":"<code shown>","approve":true}'`. The app should switch to Home within a few seconds; Settings shows the Account section with **Sign out** and a read-only name. Sign out returns to the sign-in screen.

- [ ] **Step 9: Commit**

```bash
git add src/ui-server.js src/ui/signin.js src/ui/app.js src/ui/common.js src/ui/home.js src/ui/app.css test/ui.test.js test/ui-account.test.js
git commit -m "The app signs in to heyquilt.com before anything else, signs out from Settings, and names you after your account"
```

---
### Task 8: Invites on join.heyquilt.com, and the relay's join page redirects

**Files:**
- Modify: `src/runner.js` (`encodeInvite`, `decodeInvite`, imports)
- Modify: `src/ui/common.js` (`decodeInvite`)
- Modify: `src/ui/home.js` (join dialog placeholder)
- Modify: `src/mcp.js` (`quilt_join_session` description)
- Modify: `src/server.js` (`/join/<room>` redirects; the old page, its style and download links are deleted)
- Modify: `test/relay.test.js` (two tests)

**Interfaces:**
- Consumes: `relayUrl`, `isHostedRelay` (Task 6).
- Produces (in `src/runner.js`):
  - `JOIN_HOST = 'join.heyquilt.com'`
  - `encodeInvite({ server, room, secret }): string`: `https://join.heyquilt.com/<room>#<secret>` on the hosted relay (either address); `https://<relay>/join/<room>#<secret>` on any other relay
  - `decodeInvite(code): { server, room, secret }`: reads `https://join.heyquilt.com/<room>#<secret>` (server = `relayUrl()`; throws `This link is missing part of it. Ask for a new invite.` without a secret), `https://<relay>/join/<room>#<secret>` (keeps its relay), `quilt join <link>` and `quilt:<code>` and old base64 codes.
- Produces (relay): `GET /join/<room>` → 302 to `https://join.heyquilt.com/<room>`, with `Referrer-Policy: no-referrer`.

- [ ] **Step 1: Write the failing tests**

In `test/relay.test.js`, add `import { relayUrl } from '../src/settings.js'` to the imports, and replace the two tests `invite links open a join page that never needs the secret` and `invites are links, and older codes still work` with:

```js
test("the relay's old join page sends people to join.heyquilt.com", async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet })
  defer(() => srv.close())
  const res = await fetch(`http://127.0.0.1:${srv.port}/join/room-abc`, { redirect: 'manual' })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), 'https://join.heyquilt.com/room-abc')
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/join/bad%20room`, { redirect: 'manual' })).status, 404)
  assert.equal(srv.rooms.has('room-abc'), false, 'following the link does not create a room')
})

test('invites are join.heyquilt.com links on the hosted relay, and older forms still work', () => {
  const hosted = { server: 'wss://relay.heyquilt.com', room: 'room-1a2b', secret: 'abc_D-9' }
  assert.equal(encodeInvite(hosted), 'https://join.heyquilt.com/room-1a2b#abc_D-9')
  assert.equal(encodeInvite({ ...hosted, server: 'wss://cowove-relay.fly.dev' }), 'https://join.heyquilt.com/room-1a2b#abc_D-9', 'the old address is the same relay')
  const joined = { ...hosted, server: relayUrl() }
  assert.deepEqual(decodeInvite('https://join.heyquilt.com/room-1a2b#abc_D-9'), joined)
  assert.deepEqual(decodeInvite('  quilt join https://join.heyquilt.com/room-1a2b/#abc_D-9\n'), joined)
  assert.deepEqual(decodeInvite('quilt:https://join.heyquilt.com/room-1a2b#abc_D-9'), joined)
  assert.throws(() => decodeInvite('https://join.heyquilt.com/room-1a2b'), /This link is missing part of it\. Ask for a new invite\./)

  // The relay form keeps its relay, so older sessions and development relays still work.
  const conn = { server: 'wss://relay.example.com', room: 'room-1a2b', secret: 'abc_D-9' }
  const link = encodeInvite(conn)
  assert.equal(link, 'https://relay.example.com/join/room-1a2b#abc_D-9')
  assert.deepEqual(decodeInvite(link), conn)
  assert.deepEqual(decodeInvite(`  quilt join ${link}\n`), conn)
  assert.deepEqual(decodeInvite('https://cowove-relay.fly.dev/join/room-1a2b#abc_D-9'), { server: 'wss://cowove-relay.fly.dev', room: 'room-1a2b', secret: 'abc_D-9' })
  assert.deepEqual(decodeInvite(encodeInvite({ server: 'ws://192.168.1.4:4321/', room: 'r', secret: 's' })), { server: 'ws://192.168.1.4:4321', room: 'r', secret: 's' })
  const old = Buffer.from(JSON.stringify({ s: conn.server, r: conn.room, k: conn.secret })).toString('base64url')
  assert.deepEqual(decodeInvite(old), conn)
  assert.throws(() => decodeInvite('nonsense'), /invite link is not valid/)
  assert.throws(() => decodeInvite('https://join.heyquilt.com/'), /invite link is not valid/)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/relay.test.js`
Expected: FAIL. The join page answers 200 instead of 302, and `encodeInvite(hosted)` returns `https://relay.heyquilt.com/join/room-1a2b#abc_D-9`.

- [ ] **Step 3: New invite links in `src/runner.js`**

Change `import { relayUrl } from './settings.js'` to `import { relayUrl, isHostedRelay } from './settings.js'`, and replace `encodeInvite` and `decodeInvite` (with their comments) with:

```js
/** Where invites live on the website. The relay is implied: Quilt's own. */
export const JOIN_HOST = 'join.heyquilt.com'
const MISSING_SECRET = 'This link is missing part of it. Ask for a new invite.'

/**
 * An invite link: https://join.heyquilt.com/<room>#<secret> for sessions on
 * Quilt's relay, or https://<relay>/join/<room>#<secret> for any other relay
 * (development relays). The secret sits after `#`, so browsers never send it anywhere.
 */
export function encodeInvite (c) {
  const room = encodeURIComponent(c.room)
  const secret = encodeURIComponent(c.secret || '')
  if (isHostedRelay(c.server)) return `https://${JOIN_HOST}/${room}#${secret}`
  const base = String(c.server).replace(/\/+$/, '').replace(/^ws(s?):\/\//, 'http$1://')
  return `${base}/join/${room}#${secret}`
}

/** Reads an invite link (or an older base64 code), with or without "quilt join" or "quilt:" in front. */
export function decodeInvite (code) {
  const raw = String(code).trim().replace(/^quilt join\s+/, '').replace(/^quilt:/, '').split(/\s/)[0].replace(/^["']|["']$/g, '')
  const j = raw.match(/^https:\/\/join\.heyquilt\.com\/([A-Za-z0-9_-]{1,64})\/?(?:#(.*))?$/)
  if (j) {
    let secret = ''
    try { secret = decodeURIComponent(j[2] || '') } catch {}
    if (!secret) throw new Error(MISSING_SECRET)
    return { server: relayUrl(), room: j[1], secret }
  }
  const m = raw.match(/^(https?):\/\/(.+)\/join\/([^/#?]+)\/?(?:#(.*))?$/)
  if (m) {
    try {
      return { server: `${m[1] === 'https' ? 'wss' : 'ws'}://${m[2]}`, room: decodeURIComponent(m[3]), secret: decodeURIComponent(m[4] || '') }
    } catch {}
  }
  let j2
  try {
    j2 = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {}
  if (!j2 || !j2.s || !j2.r) throw new Error('That invite link is not valid. Copy the whole link they sent.')
  return { server: j2.s, room: j2.r, secret: j2.k || '' }
}
```

- [ ] **Step 4: The app reads the new links too**

In `src/ui/common.js`, replace `decodeInvite` with:

```js
/** Same as decodeInvite in runner.js (room and relay only): an invite link, or an older base64 code. */
export function decodeInvite (code) {
  const raw = String(code || '').trim().replace(/^quilt join\s+/, '').replace(/^quilt:/, '').split(/\s/)[0].replace(/^["']|["']$/g, '')
  const j = raw.match(/^https:\/\/join\.heyquilt\.com\/([A-Za-z0-9_-]{1,64})\/?#./)
  if (j) return { server: 'wss://relay.heyquilt.com', room: j[1] }
  const m = raw.match(/^(https?):\/\/(.+)\/join\/([^/#?]+)\/?(?:#(.*))?$/)
  if (m) {
    try { return { server: `${m[1] === 'https' ? 'wss' : 'ws'}://${m[2]}`, room: decodeURIComponent(m[3]) } } catch { return null }
  }
  try {
    const j2 = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')))
    return j2 && j2.s && j2.r ? { server: j2.s, room: j2.r } : null
  } catch { return null }
}
```

In `src/ui/home.js` `joinSessionDialog`, change the textarea placeholder to `https://join.heyquilt.com/…`.

In `src/mcp.js`, change the `invite` description of `quilt_join_session` to:

```js
      invite: z.string().describe('The invite link, like https://join.heyquilt.com/<room>#<secret> (or the full "quilt join <link>" command)'),
```

- [ ] **Step 5: The relay's join route redirects**

In `src/server.js`, replace the `/join/<room>` branch of the HTTP handler with:

```js
    const j = url.pathname.match(/^\/join\/([A-Za-z0-9_-]{1,64})\/?$/)
    if (j) {
      // Invites live on the website now. Browsers keep the #secret across the redirect.
      res.writeHead(302, { location: `https://join.heyquilt.com/${j[1]}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      return res.end()
    }
```

and delete `PAGE_STYLE`, `DOWNLOADS` and `joinPage` at the bottom of the file. (`/logo.svg` stays: `assets/logo.svg` is still served for anything that links it.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/relay.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS. (`test/mcp.test.js` encodes an invite for its local relay, which keeps the relay form.)

- [ ] **Step 7: Commit**

```bash
git add src/runner.js src/ui/common.js src/ui/home.js src/mcp.js src/server.js test/relay.test.js
git commit -m "Invites are join.heyquilt.com links; the relay's join page redirects there"
```

---
### Task 9: The join page on join.heyquilt.com

**Files:**
- Create: `web/lib/join.js`
- Create: `web/app/join/[room]/page.js`
- Create: `web/components/JoinInvite.js`
- Modify: `web/proxy.js` (the `join` host)
- Modify: `web/app/globals.css` (two small rules)
- Create: `web/test/join.test.js`
- Modify: `web/test/routes.test.js` (join routes)

**Interfaces:**
- Consumes: `DownloadButtons` (`web/components/DownloadButtons.js`, `initial` prop), `pickDownloads({ ua })` (`web/lib/platform.js`), `Header`, `Footer`.
- Produces (in `web/lib/join.js`):
  - `JOIN_HOST = 'join.heyquilt.com'`
  - `isRoom(room): boolean` (`/^[A-Za-z0-9_-]{1,64}$/`, the relay's room rule)
  - `joinView(room, hash): { missing: true } | { missing: false, link, open }` where `link` is `https://join.heyquilt.com/<room>#<secret>` and `open` is `quilt://join?invite=<encoded link>`
  - `joinPath(pathname): string | null` (`/<room>` on the join host → `/join/<room>`)
- Produces (routes): `join.heyquilt.com/<room>` and `heyquilt.com/join/<room>` render the join page with `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`; `join.heyquilt.com/` (and any path that isn't a room) redirects to `https://heyquilt.com/`.

- [ ] **Step 1: Write the failing tests**

Create `web/test/join.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinView, joinPath, isRoom, JOIN_HOST } from '../lib/join.js'

test('an invite with its secret opens in Quilt', () => {
  const link = 'https://join.heyquilt.com/room-1a2b#abc_D-9'
  assert.equal(JOIN_HOST, 'join.heyquilt.com')
  assert.deepEqual(joinView('room-1a2b', '#abc_D-9'), { missing: false, link, open: `quilt://join?invite=${encodeURIComponent(link)}` })
})

test('without its secret, or for something that is not a room, the link is missing part of it', () => {
  for (const [room, hash] of [['room-1a2b', ''], ['room-1a2b', '#'], ['bad room', '#abc'], ['', '#abc'], ['x'.repeat(65), '#abc']]) {
    assert.deepEqual(joinView(room, hash), { missing: true }, `${room} ${hash}`)
  }
})

test('rooms follow the relay rule', () => {
  assert.equal(isRoom('room-1a2b'), true)
  assert.equal(isRoom('Room_9'), true)
  for (const bad of ['', 'bad room', 'a/b', 'x'.repeat(65), null]) assert.equal(isRoom(bad), false, String(bad))
})

test('paths on join.heyquilt.com map to the join route', () => {
  assert.equal(joinPath('/room-1a2b'), '/join/room-1a2b')
  assert.equal(joinPath('/room-1a2b/'), '/join/room-1a2b')
  for (const other of ['/', '/a/b', '/bad%20room', `/${'x'.repeat(65)}`, '']) assert.equal(joinPath(other), null, other)
})
```

In `web/test/routes.test.js`, add `import http from 'node:http'` to the imports, add `/join/room-abc` to the public pages check:

```js
test('public pages render', async () => {
  for (const path of ['/', '/pricing', '/join/room-abc']) assert.equal((await get(path)).status, 200, path)
})
```

and add at the end:

```js
// Like get(), but with a Host header, the way requests for join.heyquilt.com arrive.
const getAs = (host, path) => new Promise((resolve, reject) => {
  http.get({ hostname: '127.0.0.1', port: new URL(base).port, path, headers: { host } }, (res) => {
    let body = ''
    res.on('data', (c) => { body += c })
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
  }).on('error', reject)
})

test('join.heyquilt.com/<room> shows the invite page, sending no referrer and kept out of search', async () => {
  for (const [host, path] of [['join.heyquilt.com', '/room-abc'], ['join.heyquilt.com', '/room-abc/'], [new URL(base).host, '/join/room-abc']]) {
    const res = await getAs(host, path)
    assert.equal(res.status, 200, `${host}${path}`)
    assert.match(res.body, /invited to a Quilt session/)
    assert.match(res.body, /quilt-mac-arm64\.dmg|quilt-windows-x64\.exe/, 'download buttons')
    assert.equal(res.headers['referrer-policy'], 'no-referrer', `${host}${path}`)
    assert.equal(res.headers['x-robots-tag'], 'noindex', `${host}${path}`)
  }
})

test('anything else on join.heyquilt.com goes to the home page; a bad room is not found', async () => {
  for (const path of ['/', '/a/b']) {
    const res = await getAs('join.heyquilt.com', path)
    assert.ok([307, 308].includes(res.status), path)
    assert.equal(res.headers.location, 'https://heyquilt.com/')
  }
  assert.equal((await get('/join/bad%20room')).status, 404)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && node --conditions=react-server --test test/join.test.js test/routes.test.js`
Expected: FAIL. `join.test.js` with `Cannot find module '…/lib/join.js'`; `routes.test.js` because `/join/room-abc` is a 404.

- [ ] **Step 3: `web/lib/join.js`**

```js
// Invites: https://join.heyquilt.com/<room>#<secret>. The secret stays in the
// fragment, so it never reaches a server; the page reads it in the browser.
export const JOIN_HOST = 'join.heyquilt.com'
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/

export const isRoom = (room) => ROOM_RE.test(String(room ?? ''))

/** What the page shows for a room and the fragment it was opened with (location.hash). */
export function joinView (room, hash = '') {
  const secret = String(hash || '').replace(/^#/, '')
  if (!isRoom(room) || !secret) return { missing: true }
  const link = `https://${JOIN_HOST}/${room}#${secret}`
  return { missing: false, link, open: `quilt://join?invite=${encodeURIComponent(link)}` }
}

/** The app route a join.heyquilt.com path is served from, or null when it isn't an invite. */
export function joinPath (pathname) {
  const m = String(pathname || '').match(/^\/([A-Za-z0-9_-]{1,64})\/?$/)
  return m ? `/join/${m[1]}` : null
}
```

- [ ] **Step 4: The page**

Create `web/components/JoinInvite.js`:

```js
'use client'

import { useEffect, useState } from 'react'
import DownloadButtons from './DownloadButtons.js'
import { joinView } from '@/lib/join.js'

// The part of the join page that needs the browser: the secret is only in location.hash.
export default function JoinInvite ({ room, downloads }) {
  const [view, setView] = useState(null) // null until the fragment has been read

  useEffect(() => { setView(joinView(room, window.location.hash)) }, [room])

  return (
    <>
      <h1>You're invited to a Quilt session</h1>
      {view && view.missing && <p className='notice bad'>This link is missing part of it. Ask for a new invite.</p>}
      {view && !view.missing && <a className='btn primary join-open' href={view.open}>Open in Quilt</a>}
      <p className='muted'>Quilt will ask you to sign in first.</p>
      <div className='join-get'>
        <p className='muted'>Don't have Quilt yet? Download it, then click Open in Quilt again.</p>
        <DownloadButtons initial={downloads} />
      </div>
    </>
  )
}
```

Create `web/app/join/[room]/page.js`:

```js
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import Header from '@/components/Header.js'
import Footer from '@/components/Footer.js'
import JoinInvite from '@/components/JoinInvite.js'
import { pickDownloads } from '@/lib/platform.js'
import { isRoom } from '@/lib/join.js'

// Public (no sign-in): someone opening an invite may not have an account yet.
export const metadata = { title: 'Join a session', robots: { index: false, follow: false }, referrer: 'no-referrer' }

export default async function Join ({ params }) {
  const { room } = await params
  if (!isRoom(room)) notFound()
  const ua = (await headers()).get('user-agent') || ''
  return (
    <>
      <Header />
      <main className='wrap page' style={{ maxWidth: 560 }}>
        <div className='card stack join-card'>
          <JoinInvite room={room} downloads={pickDownloads({ ua })} />
        </div>
      </main>
      <Footer />
    </>
  )
}
```

In `web/app/globals.css`, add after the `.dl-fine a` rule:

```css
.join-card { text-align: center; align-items: center; }
.join-open { align-self: stretch; justify-content: center; }
.join-get { border-top: 1px solid var(--border); padding-top: 16px; width: 100%; }
```

- [ ] **Step 5: Serve it on the `join` host**

Replace `web/proxy.js` with:

```js
// Refreshes the Supabase session on every page request and keeps private pages private.
// join.heyquilt.com/<room> serves the public invite page (/join/<room>).
import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { JOIN_HOST, joinPath } from './lib/join.js'

const PRIVATE = ['/dashboard', '/settings', '/link', '/reset', '/org', '/orgs', '/invite']

// Invite links carry a secret in the fragment: never pass the page on as a referrer, and keep it out of search.
function invitePage (response) {
  response.headers.set('Referrer-Policy', 'no-referrer')
  response.headers.set('X-Robots-Tag', 'noindex')
  return response
}

export async function proxy (request) {
  const host = (request.headers.get('host') || '').split(':')[0].toLowerCase()
  if (host === JOIN_HOST) {
    const to = joinPath(request.nextUrl.pathname)
    if (!to) return NextResponse.redirect('https://heyquilt.com/')
    const url = request.nextUrl.clone()
    url.pathname = to
    return invitePage(NextResponse.rewrite(url))
  }
  if (request.nextUrl.pathname.startsWith('/join/')) return invitePage(NextResponse.next({ request }))

  let response = NextResponse.next({ request })
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll (cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options)
        for (const [k, v] of Object.entries(headers || {})) response.headers.set(k, v)
      }
    }
  })
  const { data } = await supabase.auth.getClaims()
  const path = request.nextUrl.pathname
  if (!data?.claims && PRIVATE.some((p) => path === p || path.startsWith(p + '/'))) {
    const to = request.nextUrl.clone()
    to.pathname = '/signin'
    to.search = ''
    to.searchParams.set('next', path + request.nextUrl.search)
    const redirectResponse = NextResponse.redirect(to)
    for (const cookie of response.cookies.getAll()) redirectResponse.cookies.set(cookie)
    return redirectResponse
  }
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.svg|.*\\.(?:svg|png|jpg|ico|woff2)$).*)']
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd web && npm test`
Expected: PASS, including `no-em-dash.test.js` (the new copy has no em dashes). `routes.test.js` builds the site first, so it takes a minute.

Run: `npm test` (from the repo root)
Expected: PASS.

- [ ] **Step 7: Check the page by eye**

```bash
cd web && NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test npx next dev -p 3210
```

Open `http://localhost:3210/join/room-abc#secret123` (Open in Quilt and the download buttons), then `http://localhost:3210/join/room-abc` (the missing-part message, no Open button). Check both at phone width.

- [ ] **Step 8: Commit**

```bash
git add web/lib/join.js web/app/join web/components/JoinInvite.js web/proxy.js web/app/globals.css web/test/join.test.js web/test/routes.test.js
git commit -m "Website: the invite page on join.heyquilt.com, with Open in Quilt and downloads"
```

---
### Task 10: Docs, deploy configuration and the version

**Files:**
- Modify: `README.md`
- Modify: `docs/hosting.md`
- Modify: `fly.toml`, `fly.api.toml` (comments only: the secrets are set in the Switchover)
- Modify: `package.json` (`"version": "0.3.0"`)

**Interfaces:**
- Consumes: everything above (the docs describe it).
- Produces: nothing code depends on.

- [ ] **Step 1: Check what still describes the old way**

Run: `grep -n "quilt relay\|--server\|Host relay here\|relay key\|cloudflared\|relay.heyquilt.com/join" README.md docs/hosting.md`
Expected: several matches (README "The easy way", "The terminal way", Commands, "Hosting the relay"; hosting.md "2. Point Quilt at it", "Checking on it"). Steps 2 and 3 replace them.

- [ ] **Step 2: README**

In `README.md`:

0. In the diagram at the top, change `+--> quilt relay <-----+` to `+--> Quilt relay <-----+` (it's the service now, not a command).

1. In "How it works", change the **Works apart** bullet's first sentence to:

```markdown
- **Works apart.** Quilt's relay at `relay.heyquilt.com` connects everyone over
  WebSockets, and only lets in people signed in to heyquilt.com. If your
  connection drops, keep working: Quilt keeps a local copy of the shared state
  and merges your offline edits when you reconnect.
```

2. In "Download the app", after the sentence ending `and partners click it to join.` add:

```markdown
The first time you open it, sign in: Quilt opens heyquilt.com, where you
approve this computer. New to Quilt? [Create an account](https://heyquilt.com/signup).
```

3. In "The easy way: the app", replace the **Start a session** bullet with:

```markdown
- **Sign in** with your heyquilt.com account (once per computer).
- **Start a session:** pick your project folder. You get an invite link to send.
```

4. Replace "The terminal way" steps 1 to 3 (from `**1. Run a relay**` to the line `Keep \`quilt join\` running in a terminal while you work…` exclusive) with:

````markdown
**1. Sign in** once on each computer:

```bash
quilt login                      # opens heyquilt.com, where you approve this computer
```

**2. Start a session** in your project folder:

```bash
cd ~/code/my-app
quilt join --tool claude
```

It prints an invite link like `https://join.heyquilt.com/room-1a2b#…`.
Send it to your friend. Opening it in a browser shows them how to join.

**3. Your friend joins** from an empty folder (or their own clone of the same
repo), signed in to their own account:

```bash
mkdir my-app && cd my-app
quilt login
quilt join <invite-link> --tool cursor
```
````

5. In "Commands", replace the rows for `quilt relay set`, `quilt relay` / `quilt relay check` / `quilt relay clear` and `quilt join` / `quilt join --server <url>` with:

```markdown
| `quilt login` / `quilt logout` / `quilt whoami` | Sign this computer in to your heyquilt.com account, sign it out, or see which account it uses |
| `quilt join` | Start a new session for this folder |
| `quilt join --agent <name>` | Join as a Quilt agent saved with `quilt agent join` |
```

and change the `quilt serve` row's description to `Run a relay (how Quilt's relay runs; see docs/hosting.md)`.

6. In "MCP tools for agents", change the `quilt_join_session` and `quilt_start_session` rows to:

```markdown
| `quilt_join_session` | Join a session from an invite link, as a Quilt agent saved with `quilt agent join` |
| `quilt_start_session` | Start a new session for a folder, as that agent, and get an invite link |
```

7. Replace the whole "Hosting the relay" section (up to "What syncs (and what doesn't)") with:

```markdown
## The relay

Everyone connects through Quilt's relay at `relay.heyquilt.com`. It passes
changes between computers, keeps each session's shared state and the files
people share in chat, and only lets in people and agents signed in to
heyquilt.com: the app and the `quilt` command get a pass from the accounts API
that lasts 10 minutes, and the relay checks it on every connection.

The relay is one small Node process (`quilt serve`); [docs/hosting.md](docs/hosting.md)
describes how it's deployed and its settings. The app only connects to Quilt's
relay for now.

- Each session has its own secret, and the owner approves who gets in.
- Sessions have size quotas and shared-file quotas, and each account can start
  30 sessions an hour.
- Idle sessions are unloaded from memory, and sessions nobody opens for 30
  days are deleted.
```

8. In "Security", add as the first bullet:

```markdown
- You sign in to heyquilt.com on each computer. The computer's token is kept in
  `~/.quilt/account.json`, readable only by you. The relay never sees it: it
  sees a pass that lasts 10 minutes and names your account and this computer's
  key. Signing a computer out (in the app, with `quilt logout`, or on the
  website) cuts it off within 10 minutes.
```

and change the bullet `The relay can read project contents. Host your own relay and use \`wss://\`.` to:

```markdown
- Whoever runs the relay can read project contents.
```

- [ ] **Step 3: docs/hosting.md**

0. Change the title to `# Hosting the Quilt relay`.

1. Replace the section `## 2. Point Quilt at it` (up to `## Settings`) with:

````markdown
## 2. Turn on sign-in

Quilt's relay only lets in people and agents signed in to heyquilt.com. The
accounts API signs each of them a pass that lasts 10 minutes, and the relay
checks it with the API's public key, which the API publishes:

```bash
fly secrets set QUILT_PASS_PUBLIC_KEY="$(curl -s https://api.heyquilt.com/v1/passes/key | node -pe 'JSON.parse(require("fs").readFileSync(0)).publicKey')"
```

With it set:

- Every connection needs a pass. Apps too old to get one are refused with
  "Update Quilt and sign in to continue".
- The relay takes each person's name from their pass.
- The relay key isn't used, and new sessions are limited per account
  (`QUILT_MAX_NEW_ROOMS_PER_HOUR`) instead of per address.

Without it the relay works as it always has, with the relay key. The Quilt app
only connects to Quilt's own relay for now; other relays are for development
(`QUILT_SERVER=ws://localhost:4321 quilt ui`).
````

2. In the Settings table, add as the first row:

```markdown
| `QUILT_PASS_PUBLIC_KEY` | *(none)* | The accounts API's public key (`/v1/passes/key`). With it, every connection needs a pass from the API. Set it as a secret. |
```

change the `QUILT_RELAY_KEY` description to `Required to **start** sessions when sign-in is off. Ignored when \`QUILT_PASS_PUBLIC_KEY\` is set.`, and the `QUILT_MAX_NEW_ROOMS_PER_HOUR` description to `New sessions one account (or, with sign-in off, one address) can start per hour (\`0\` = no limit). Joining existing sessions isn't limited.`

3. In "Checking on it", replace the `quilt relay check wss://your-relay` bullet with:

```markdown
- `curl https://your-relay/healthz` tests it from any machine.
```

and change the first bullet's "an invite link" to "an old invite link (which redirects to join.heyquilt.com)".

- [ ] **Step 4: Deploy config comments and the version**

In `fly.toml`, after the line `#   fly secrets set QUILT_RELAY_KEY=$(openssl rand -base64 24)` add:

```toml
#   Sign-in (docs/hosting.md): the accounts API's public key, as a secret so turning it on is deliberate:
#   fly secrets set QUILT_PASS_PUBLIC_KEY="$(curl -s https://api.heyquilt.com/v1/passes/key | node -pe 'JSON.parse(require("fs").readFileSync(0)).publicKey')"
```

In `fly.api.toml`, after the `fly secrets set --app quilt-api SUPABASE_URL=…` comment line add:

```toml
#   node scripts/pass-keys.mjs | fly secrets import --app quilt-api --stage   # PASS_SIGNING_KEY, never printed
```

In `package.json`, set `"version": "0.3.0"`.

- [ ] **Step 5: Verify**

Run: `grep -n "quilt relay\|--server\|Host relay here\|cloudflared\|relay.heyquilt.com/join" README.md docs/hosting.md`
Expected: no output.

Run: `npm test && (cd web && npm test)`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/hosting.md fly.toml fly.api.toml package.json
git commit -m "Docs and deploy notes for sign-in, passes and join.heyquilt.com; version 0.3.0"
```

---

## Switchover

This is for the controller, after every task above is merged to `main`. Run deploys from the main checkout (`/Users/danielcarmichael/elegy`). The order matters: the relay goes last, because once it requires passes every older app is refused. Steps marked **(user)** need Daniel; never ask anyone to paste a secret into chat, and never print one.

1. **Accounts API with `PASS_SIGNING_KEY`.**
   - Make the key and hand it straight to Fly (the private key never appears; the public key on stderr is fine to see):

     ```bash
     node scripts/pass-keys.mjs | fly secrets import --app quilt-api --stage
     fly deploy --config fly.api.toml --remote-only --ha=false
     ```

   - Check: `curl -s https://api.heyquilt.com/v1/passes/key` returns `{"publicKey":"…"}`, and `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.heyquilt.com/v1/passes` prints `401`. `QUILT_API=https://api.heyquilt.com node scripts/api-smoke.mjs` passes its unauthenticated checks (with `QUILT_TEST_JWT` set **(user)**, it also checks a real pass).
   - The device-link fix ships in this deploy. No released app collects device tokens yet, so nothing breaks.

2. **Website, and the `join` domain.**
   - Deploy: `cd web && npm ci && NETLIFY_SITE_ID=b9131760-8605-44f7-b9e1-3b347fc212b0 netlify deploy --build --prod`. Check `curl -sI https://heyquilt.com/join/room-abc` is 200 with `referrer-policy: no-referrer` and `x-robots-tag: noindex`.
   - Add `join.heyquilt.com` as a domain alias on the Netlify site `heyquilt` (Domain management, Add a domain alias). Doing it through the API, first read the site's current `domain_aliases` and send them all back with `join.heyquilt.com` added, so no existing alias is dropped.
   - **(user)** In Cloudflare DNS for `heyquilt.com`, add a CNAME record `join` → `heyquilt.netlify.app` with proxy status **DNS only** (grey cloud).
   - Once DNS resolves, let Netlify issue the certificate (Domain management, HTTPS, Verify DNS configuration). Check `curl -sI https://join.heyquilt.com/room-abc` (200, both headers) and `curl -sI https://join.heyquilt.com/` (307 to `https://heyquilt.com/`).

3. **Desktop release 0.3.0.** **(user: publishing a release is public; confirm before it goes out)**
   - Build: `npm ci && npm run dist:mac && npm run dist:win`.
   - Publish: `gh release create v0.3.0 dist/quilt-mac-arm64.dmg dist/quilt-mac-x64.dmg dist/quilt-windows-x64.exe --title "Quilt 0.3.0" --notes "Sign in with your heyquilt.com account to use Quilt. Invites are now join.heyquilt.com links."`
   - Check the website's download links now serve 0.3.0: `curl -sIL https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/quilt-mac-arm64.dmg` ends in 200.

4. **Live check, before the relay switches over.** Use a test relay on the Mac with the real public key, so nobody else is affected:

   ```bash
   QUILT_PASS_PUBLIC_KEY="$(curl -s https://api.heyquilt.com/v1/passes/key | node -pe 'JSON.parse(require("fs").readFileSync(0)).publicKey')" \
     node bin/quilt.js serve --port 4399 --data "$(mktemp -d)"
   ```

   - **(user)** Sign in on the Mac: start Quilt 0.3.0 pointed at the test relay (`QUILT_SERVER=ws://127.0.0.1:4399 /Applications/Quilt.app/Contents/MacOS/Quilt`), click **Sign in**, approve in the browser.
   - **(user)** Start a session in the app.
   - **(user)** Join it from a second signed-in account: in a terminal, `export HOME="$(mktemp -d)" QUILT_SERVER=ws://127.0.0.1:4399`, then `node bin/quilt.js login` (approve as the second account in a private browser window) and `node bin/quilt.js join <invite link>`. The owner approves them in the app.
   - An unsigned client is refused: `curl -s -o /dev/null -w '%{http_code}\n' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' 'http://127.0.0.1:4399/room-x?secret=s&name=n&key=k'` prints `401`.
   - **(user)** An invite from `join.heyquilt.com` opens the app: take the session's room and secret, open `https://join.heyquilt.com/<room>#<secret>` in the browser, click **Open in Quilt**. The running app (which has `QUILT_SERVER` set) opens its join dialog with the link filled in.
   - Stop the test relay.

5. **Relay with `QUILT_PASS_PUBLIC_KEY`.** (The controller deploys the relay; see the "deploy relay myself" note.)
   - Deploy the new code first; without the key it behaves as before, apart from `/join/<room>` now redirecting: `fly deploy` (uses `fly.toml`, app `cowove-relay`, which serves `relay.heyquilt.com`). Check `curl -sI https://relay.heyquilt.com/join/room-abc` is a 302 to `https://join.heyquilt.com/room-abc`.
   - Turn on sign-in (this restarts the relay with the key):

     ```bash
     fly secrets set --app cowove-relay QUILT_PASS_PUBLIC_KEY="$(curl -s https://api.heyquilt.com/v1/passes/key | node -pe 'JSON.parse(require("fs").readFileSync(0)).publicKey')"
     ```

   - Check: the unsigned `curl` upgrade above, against `https://relay.heyquilt.com/room-x?…`, prints `401`; the Mac app (now without `QUILT_SERVER`) reconnects and its sessions keep syncing; `fly logs --app cowove-relay` shows connections under account names.

---

## Self-review notes

Spec coverage, section by section:

- Signing in, desktop app (sign-in screen, device flow, code expiry and start over, `account.json`, sign out, revoked token message, read-only name, colour and tool stay): Task 7, built on Task 4.
- Command line (`quilt login`, `logout`, `whoami`; session commands need a token): Task 4 and Task 5.
- Device-link signature fix: Task 1.
- Getting a pass (`POST /v1/passes`, both token kinds, format, payload, 10 minutes, 409, 60 a minute, no team fields): Task 2.
- What the relay checks (WS and HTTP, validity, refusals, names, kinds in the member list, `MSG_PASS`, 4419, per-account limit, relay key unused, unchanged without the key): Task 3.
- Clients (fetch before connecting and HTTP calls, cache until 2 minutes before `exp`, refresh every 5 minutes, agents via their access key and refresh key): Task 5.
- One relay (hosted relay only, `QUILT_SERVER`, Settings section removed, `quilt relay` removed, retired settings dropped on save, no in-process relay, recents on old and local relays): Task 6.
- Invites (new links, `decodeInvite` forms, relay `/join` redirect): Task 8. Join page, proxy rewrite, public route, missing-secret message, headers: Task 9. DNS and Netlify alias: Switchover step 2.
- Switchover order and live check: Switchover section.
- Testing list: each bullet has a test in the task that builds it (API: `test/api-passes.test.js`, `test/api.test.js`, `test/identity.test.js`; relay: `test/relay-passes.test.js`; clients: `test/account.test.js`, `test/cli-account.test.js`, `test/pass-source.test.js`, `test/session-passes.test.js`, `test/cli-join.test.js`, `test/ui-account.test.js`, `test/ui.test.js`; invites: `test/relay.test.js`, `web/test/join.test.js`, `web/test/routes.test.js`; copy: `web/test/no-em-dash.test.js`).
