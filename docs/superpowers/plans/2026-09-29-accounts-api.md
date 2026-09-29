# Accounts API Implementation Plan (plan 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed Quilt accounts API (`quilt-api` on Fly, backed by a new Supabase project) that links desktop apps to accounts with a device-code flow and issues and revokes agent keys.

**Architecture:** A plain Node `http` service in this repo (`src/api/`), started with `quilt api`, following the relay's style (no framework). All data goes through a small store interface with two implementations: in memory (tests) and Supabase (production, service role). Signed-in website users are recognised by verifying their Supabase JWT against the project's JWKS.

**Tech Stack:** Node 22 ESM, `node:http`, `node:crypto`, `node:test`; `@supabase/supabase-js` 2.x; `jose` 6.x; Supabase Postgres (SQL migrations); Fly.io.

**Spec:** `docs/superpowers/specs/2026-09-29-website-and-agent-api-design.md`

The other plans follow this one: 2 agent runtime (MCP, agents in sessions), 3 website, 4 desktop app sign-in.

## Global Constraints

- Tokens are `qd_` (device) and `qa_` (agent) + 32 random bytes (base64url); stored only as SHA-256 hex hashes; compared in constant time.
- Link codes: 8 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no 0/O, 1/I/L), shown as `XXXX-XXXX`; expire after 600 s; the app polls every 3 s.
- Agent private keys: Ed25519, encrypted with AES-256-GCM using `AGENT_KEY_SECRET`; never returned to clients.
- JWTs verified against `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, issuer `${SUPABASE_URL}/auth/v1`, audience `authenticated`.
- CORS on JWT endpoints allows only `QUILT_SITE_URL`.
- Rate limit: `device/start` 10 per minute per IP.
- Supabase project "Quilt" in the Firetower organization (`efgydvofwzbxvvcfquhw`), region `us-east-1`; its cost is shown to the user and confirmed before creation.
- Fly app `quilt-api` (fallback `heyquilt-api` if taken), separate from the relay `cowove-relay`. Claude runs the deploys.
- Code style: match the repo (ESM, 2-space indent, no semicolons, `standard` style, short comments that explain why).

---

## File map

| File | Responsibility |
|---|---|
| `src/api/tokens.js` | Random tokens, hashing, link codes, constant-time compare |
| `src/api/agent-keys.js` | An agent's Ed25519 identity and encrypting/decrypting its private key |
| `src/api/memory-store.js` | The store interface, in memory (tests and local runs) |
| `src/api/supabase-store.js` | The same interface on Supabase (service role) |
| `src/api/auth.js` | Verifying a website user's Supabase JWT |
| `src/api/server.js` | HTTP routes: device flow, `/v1/me`, agents, health; CORS; rate limit |
| `supabase/migrations/20260929000000_accounts.sql` | Tables, row-level security, sign-up trigger |
| `bin/quilt.js` | New `quilt api` command |
| `fly.api.toml` | Fly config for `quilt-api` |
| `scripts/api-smoke.mjs` | End-to-end check against the deployed API |
| `test/api-tokens.test.js`, `test/api-agent-keys.test.js`, `test/api-store.test.js`, `test/api.test.js`, `test/api-auth.test.js` | Tests |

## Store interface (used by every task)

All methods are `async`. Rows are plain objects with camelCase fields.

```
createLink({ deviceCodeHash, userCode, publicKey, deviceName, platform, expiresAt }) -> link
linkByDeviceCode(deviceCodeHash) -> link | null
linkByUserCode(userCode) -> link | null
updateLink(id, patch) -> link                  // patch: { status, userId, deviceId }
upsertDevice({ userId, name, platform, publicKey }) -> device   // same publicKey = same computer: reuse the row, un-revoke it
setDeviceToken(id, tokenHash) -> void
deviceByToken(tokenHash) -> device | null      // null if revoked
touchDevice(id) -> void                        // lastSeenAt = now
revokeDevice(id) -> void
profile(userId) -> profile | null              // { id, name, color, tool }
updateProfile(userId, { name, color, tool }) -> profile
createAgent({ ownerId, name, keyPrefix, keyHash, publicKey, privateKeyEnc }) -> agent
agentByKey(keyHash) -> agent | null            // null if revoked
listAgents(ownerId) -> agent[]                 // without keyHash / privateKeyEnc
revokeAgent(ownerId, id) -> boolean            // false if not theirs
```

Link rows: `{ id, deviceCodeHash, userCode, publicKey, deviceName, platform, status, userId, deviceId, expiresAt, createdAt }`, `status` ∈ `pending | approved | denied | consumed`.
Device rows: `{ id, userId, name, platform, publicKey, tokenHash, createdAt, lastSeenAt, revokedAt }`.
Agent rows: `{ id, ownerId, name, keyPrefix, keyHash, publicKey, privateKeyEnc, createdAt, lastUsedAt, revokedAt }`.

---

### Task 1: Tokens and link codes

**Files:**
- Create: `src/api/tokens.js`
- Test: `test/api-tokens.test.js`

**Interfaces:**
- Produces: `newToken(prefix) -> string`, `hashToken(token) -> string` (hex), `newUserCode() -> 'XXXX-XXXX'`, `normalizeUserCode(input) -> 'XXXX-XXXX' | null`, `sameHash(a, b) -> boolean`, `CODE_ALPHABET`.

- [ ] **Step 1: Write the failing test**

```js
// test/api-tokens.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newToken, hashToken, newUserCode, normalizeUserCode, sameHash, CODE_ALPHABET } from '../src/api/tokens.js'

test('tokens carry their prefix, are long and random, and hash stably', () => {
  const a = newToken('qd_'); const b = newToken('qd_')
  assert.match(a, /^qd_[A-Za-z0-9_-]{43}$/)
  assert.notEqual(a, b)
  assert.equal(hashToken(a), hashToken(a))
  assert.match(hashToken(a), /^[0-9a-f]{64}$/)
  assert.ok(sameHash(hashToken(a), hashToken(a)))
  assert.ok(!sameHash(hashToken(a), hashToken(b)))
})

test('link codes use an unambiguous alphabet and normalise what people type', () => {
  for (let i = 0; i < 200; i++) {
    const c = newUserCode()
    assert.match(c, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    for (const ch of c.replace('-', '')) assert.ok(CODE_ALPHABET.includes(ch), ch)
  }
  assert.equal(normalizeUserCode(' 7f3k9qxm '), '7F3K-9QXM')
  assert.equal(normalizeUserCode('7F3K-9QXM'), '7F3K-9QXM')
  assert.equal(normalizeUserCode('7F3K-9QX0'), null, '0 is not in the alphabet')
  assert.equal(normalizeUserCode('short'), null)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/api-tokens.test.js`
Expected: FAIL, `Cannot find module '../src/api/tokens.js'`

- [ ] **Step 3: Implement**

```js
// src/api/tokens.js
// Secrets the accounts API hands out. Only their hashes are stored, so a leaked
// database can't be used to sign in as anyone.
import crypto from 'node:crypto'

export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' // no 0/O, 1/I/L

export function newToken (prefix) {
  return prefix + crypto.randomBytes(32).toString('base64url')
}

export function hashToken (token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

export function sameHash (a, b) {
  const x = Buffer.from(String(a), 'hex'); const y = Buffer.from(String(b), 'hex')
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y)
}

/** The short code a person matches between the app and the website, e.g. 7F3K-9QXM. */
export function newUserCode () {
  let s = ''
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
  return `${s.slice(0, 4)}-${s.slice(4)}`
}

export function normalizeUserCode (input) {
  const s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (s.length !== 8 || [...s].some((ch) => !CODE_ALPHABET.includes(ch))) return null
  return `${s.slice(0, 4)}-${s.slice(4)}`
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/api-tokens.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/api/tokens.js test/api-tokens.test.js
git commit -m "Add tokens and link codes for the accounts API"
```

---

### Task 2: Agent identity keys

**Files:**
- Create: `src/api/agent-keys.js`
- Test: `test/api-agent-keys.test.js`

**Interfaces:**
- Consumes: `generateIdentity()`, `signChallenge(identity, room, nonce)`, `parsePublicKey(b64)`, `verifyChallenge(key, room, nonce, sig)` from `src/identity.js`.
- Produces: `newAgentIdentity(secret) -> { publicKey, privateKeyEnc }`, `openAgentIdentity({ publicKey, privateKeyEnc }, secret) -> { publicKey, privateKey }` (the shape `Connection` expects as `identity`).

- [ ] **Step 1: Write the failing test**

```js
// test/api-agent-keys.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { newAgentIdentity, openAgentIdentity } from '../src/api/agent-keys.js'
import { signChallenge, parsePublicKey, verifyChallenge } from '../src/identity.js'

const SECRET = crypto.randomBytes(32).toString('base64')

test("an agent's private key is stored encrypted and opens into a working identity", () => {
  const stored = newAgentIdentity(SECRET)
  assert.ok(stored.publicKey && stored.privateKeyEnc)
  assert.ok(!stored.privateKeyEnc.includes(stored.publicKey))
  const id = openAgentIdentity(stored, SECRET)
  const nonce = crypto.randomBytes(32)
  const sig = signChallenge(id, 'room1', nonce)
  assert.ok(verifyChallenge(parsePublicKey(id.publicKey), 'room1', nonce, sig))
})

test('the wrong secret cannot open it', () => {
  const stored = newAgentIdentity(SECRET)
  assert.throws(() => openAgentIdentity(stored, crypto.randomBytes(32).toString('base64')))
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/api-agent-keys.test.js`
Expected: FAIL, module not found

- [ ] **Step 3: Implement**

```js
// src/api/agent-keys.js
// Each agent signs in to the relay with its own Ed25519 key, like a person's app does.
// The API keeps the private key, encrypted with AGENT_KEY_SECRET (AES-256-GCM).
import crypto from 'node:crypto'
import { generateIdentity } from '../identity.js'

const keyFrom = (secret) => crypto.createHash('sha256').update(String(secret)).digest()

export function newAgentIdentity (secret) {
  const { publicKey, privateKey } = generateIdentity()
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv)
  const enc = Buffer.concat([c.update(privateKey, 'utf8'), c.final()])
  return { publicKey, privateKeyEnc: [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.') }
}

export function openAgentIdentity ({ publicKey, privateKeyEnc }, secret) {
  const [iv, tag, enc] = String(privateKeyEnc).split('.').map((s) => Buffer.from(s, 'base64url'))
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), iv)
  d.setAuthTag(tag)
  return { publicKey, privateKey: Buffer.concat([d.update(enc), d.final()]).toString('utf8') }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/api-agent-keys.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/api/agent-keys.js test/api-agent-keys.test.js
git commit -m "Give agents their own encrypted identity keys"
```

---

### Task 3: In-memory store

**Files:**
- Create: `src/api/memory-store.js`
- Test: `test/api-store.test.js`

**Interfaces:**
- Produces: `createMemoryStore({ now = Date.now } = {}) -> store` implementing the Store interface above, plus `store.addUser(userId, { name, email })` (tests only: what the sign-up trigger does in Supabase).

- [ ] **Step 1: Write the failing test**

```js
// test/api-store.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../src/api/memory-store.js'

test('devices: the same computer relinking reuses its row and is un-revoked', async () => {
  const s = createMemoryStore()
  s.addUser('u1', { name: 'Dana' })
  const d1 = await s.upsertDevice({ userId: 'u1', name: 'Mac', platform: 'darwin', publicKey: 'pk1' })
  await s.setDeviceToken(d1.id, 'h1')
  assert.equal((await s.deviceByToken('h1')).id, d1.id)
  await s.revokeDevice(d1.id)
  assert.equal(await s.deviceByToken('h1'), null)
  const d2 = await s.upsertDevice({ userId: 'u1', name: 'Mac 2', platform: 'darwin', publicKey: 'pk1' })
  assert.equal(d2.id, d1.id)
  assert.equal(d2.revokedAt, null)
  assert.equal(d2.name, 'Mac 2')
})

test('links are found by device code and by user code', async () => {
  const s = createMemoryStore()
  const l = await s.createLink({ deviceCodeHash: 'dh', userCode: 'AAAA-BBBB', publicKey: 'pk', deviceName: 'Mac', platform: 'darwin', expiresAt: Date.now() + 1000 })
  assert.equal(l.status, 'pending')
  assert.equal((await s.linkByDeviceCode('dh')).id, l.id)
  assert.equal((await s.linkByUserCode('AAAA-BBBB')).id, l.id)
  await s.updateLink(l.id, { status: 'approved', userId: 'u1' })
  assert.equal((await s.linkByUserCode('AAAA-BBBB')).status, 'approved')
})

test('profiles, and agents only their owner can list or revoke', async () => {
  const s = createMemoryStore()
  s.addUser('u1', { name: 'Dana' }); s.addUser('u2', { name: 'Eli' })
  assert.equal((await s.profile('u1')).name, 'Dana')
  assert.equal((await s.updateProfile('u1', { color: '#123456', tool: 'Cursor' })).tool, 'Cursor')
  const a = await s.createAgent({ ownerId: 'u1', name: 'Larry', keyPrefix: 'qa_abcde', keyHash: 'kh', publicKey: 'apk', privateKeyEnc: 'enc' })
  assert.equal((await s.agentByKey('kh')).id, a.id)
  const listed = await s.listAgents('u1')
  assert.equal(listed.length, 1)
  assert.equal(listed[0].keyHash, undefined)
  assert.equal(listed[0].privateKeyEnc, undefined)
  assert.equal(await s.revokeAgent('u2', a.id), false)
  assert.equal(await s.revokeAgent('u1', a.id), true)
  assert.equal(await s.agentByKey('kh'), null)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/api-store.test.js`
Expected: FAIL, module not found

- [ ] **Step 3: Implement**

```js
// src/api/memory-store.js
// The accounts API's data, in memory. Used by tests and `quilt api --memory`;
// production uses supabase-store.js, which has the same methods.
import crypto from 'node:crypto'

const uuid = () => crypto.randomUUID()
const pick = (o, drop) => Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k)))

export function createMemoryStore ({ now = Date.now } = {}) {
  const links = new Map(); const devices = new Map(); const profiles = new Map(); const agents = new Map()
  return {
    addUser (userId, { name = '', email = '' } = {}) {
      profiles.set(userId, { id: userId, name: name || email.split('@')[0] || 'You', color: null, tool: null })
    },
    async createLink (l) {
      const row = { id: uuid(), status: 'pending', userId: null, deviceId: null, createdAt: now(), ...l }
      links.set(row.id, row); return { ...row }
    },
    async linkByDeviceCode (h) { const l = [...links.values()].find((x) => x.deviceCodeHash === h); return l ? { ...l } : null },
    async linkByUserCode (c) { const l = [...links.values()].find((x) => x.userCode === c); return l ? { ...l } : null },
    async updateLink (id, patch) { const l = links.get(id); Object.assign(l, patch); return { ...l } },
    async upsertDevice ({ userId, name, platform, publicKey }) {
      let d = [...devices.values()].find((x) => x.publicKey === publicKey)
      if (d) Object.assign(d, { userId, name, platform, revokedAt: null })
      else devices.set((d = { id: uuid(), userId, name, platform, publicKey, tokenHash: null, createdAt: now(), lastSeenAt: now(), revokedAt: null }).id, d)
      return { ...d }
    },
    async setDeviceToken (id, tokenHash) { devices.get(id).tokenHash = tokenHash },
    async deviceByToken (h) { const d = [...devices.values()].find((x) => x.tokenHash === h && !x.revokedAt); return d ? { ...d } : null },
    async touchDevice (id) { devices.get(id).lastSeenAt = now() },
    async revokeDevice (id) { devices.get(id).revokedAt = now() },
    async profile (userId) { const p = profiles.get(userId); return p ? { ...p } : null },
    async updateProfile (userId, patch) {
      const p = profiles.get(userId)
      for (const k of ['name', 'color', 'tool']) if (patch[k] !== undefined) p[k] = patch[k]
      return { ...p }
    },
    async createAgent (a) {
      const row = { id: uuid(), createdAt: now(), lastUsedAt: null, revokedAt: null, ...a }
      agents.set(row.id, row); return pick(row, ['keyHash', 'privateKeyEnc'])
    },
    async agentByKey (h) { const a = [...agents.values()].find((x) => x.keyHash === h && !x.revokedAt); return a ? { ...a } : null },
    async listAgents (ownerId) { return [...agents.values()].filter((a) => a.ownerId === ownerId).map((a) => pick(a, ['keyHash', 'privateKeyEnc'])) },
    async revokeAgent (ownerId, id) {
      const a = agents.get(id)
      if (!a || a.ownerId !== ownerId) return false
      a.revokedAt = now(); return true
    }
  }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/api-store.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/api/memory-store.js test/api-store.test.js
git commit -m "Add the accounts API's in-memory store"
```

---

### Task 4: API server: device flow

**Files:**
- Create: `src/api/server.js`
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: Tasks 1 and 3.
- Produces: `startApi({ port = 0, host = '127.0.0.1', store, verifyUser, siteUrl, agentKeySecret, now = Date.now, log = () => {} }) -> Promise<{ port, url, close() }>`.
  `verifyUser(bearerToken) -> Promise<{ userId, email } | null>`.
  Routes in this task: `GET /healthz`, `POST /v1/device/start`, `POST /v1/device/poll`, `GET /v1/device/link/:code`, `POST /v1/device/approve`.

- [ ] **Step 1: Write the failing test**

```js
// test/api.test.js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startApi } from '../src/api/server.js'
import { createMemoryStore } from '../src/api/memory-store.js'
import { generateIdentity } from '../src/identity.js'

let api, store
const SITE = 'https://quilt.test'
// Website users are recognised by their JWT; here a bearer "user:<id>" stands in for one.
const verifyUser = async (t) => (t && t.startsWith('user:') ? { userId: t.slice(5), email: `${t.slice(5)}@x.test` } : null)
const call = async (method, path, body, token) => {
  const res = await fetch(api.url + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), origin: SITE },
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers }
}

before(async () => {
  store = createMemoryStore()
  store.addUser('u1', { name: 'Dana' }); store.addUser('u2', { name: 'Eli' })
  api = await startApi({ store, verifyUser, siteUrl: SITE, agentKeySecret: 'test-secret' })
})
after(() => api.close())

test('health', async () => {
  assert.equal((await call('GET', '/healthz')).body.ok, true)
})

test('linking a computer: start, see it on the website, approve, then the app gets its token once', async () => {
  const { publicKey } = generateIdentity()
  const start = await call('POST', '/v1/device/start', { publicKey, deviceName: "Dana's MacBook", platform: 'darwin' })
  assert.equal(start.status, 200)
  assert.match(start.body.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  assert.equal(start.body.verificationUrl, `${SITE}/link?code=${start.body.userCode}`)
  assert.equal(start.body.interval, 3)
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: start.body.deviceCode })).status, 202)

  assert.equal((await call('GET', `/v1/device/link/${start.body.userCode}`)).status, 401, 'needs sign-in')
  const seen = await call('GET', `/v1/device/link/${start.body.userCode.replace('-', '').toLowerCase()}`, null, 'user:u1')
  assert.equal(seen.body.deviceName, "Dana's MacBook")

  assert.equal((await call('POST', '/v1/device/approve', { userCode: start.body.userCode, approve: true }, 'user:u1')).status, 200)
  const done = await call('POST', '/v1/device/poll', { deviceCode: start.body.deviceCode })
  assert.equal(done.status, 200)
  assert.match(done.body.token, /^qd_/)
  assert.equal(done.body.profile.name, 'Dana')
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: start.body.deviceCode })).status, 410, 'the token is handed out once')
})

test('a denied or expired link never yields a token', async () => {
  const { publicKey } = generateIdentity()
  const a = await call('POST', '/v1/device/start', { publicKey, deviceName: 'X', platform: 'linux' })
  await call('POST', '/v1/device/approve', { userCode: a.body.userCode, approve: false }, 'user:u1')
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: a.body.deviceCode })).status, 403)
  const b = await call('POST', '/v1/device/start', { publicKey, deviceName: 'X', platform: 'linux' })
  const l = await store.linkByUserCode(b.body.userCode)
  await store.updateLink(l.id, { expiresAt: Date.now() - 1 })
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: b.body.deviceCode })).status, 410)
  assert.equal((await call('POST', '/v1/device/approve', { userCode: b.body.userCode, approve: true }, 'user:u1')).status, 410)
})

test('bad requests are refused', async () => {
  assert.equal((await call('POST', '/v1/device/start', { publicKey: 'nope', deviceName: 'X' })).status, 400)
  assert.equal((await call('POST', '/v1/device/poll', { deviceCode: 'nope' })).status, 404)
  assert.equal((await call('GET', '/v1/device/link/AAAA-AAAA', null, 'user:u1')).status, 404)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/api.test.js`
Expected: FAIL, module not found

- [ ] **Step 3: Implement**

```js
// src/api/server.js
// The Quilt accounts API: links desktop apps to accounts (a device-code flow, like
// signing in to a TV app) and manages agents. Plain node:http, like the relay.
import http from 'node:http'
import { newToken, hashToken, newUserCode, normalizeUserCode } from './tokens.js'
import { parsePublicKey } from '../identity.js'

const LINK_TTL_MS = 10 * 60 * 1000
const POLL_INTERVAL_S = 3
const MAX_BODY = 16 * 1024

class HttpError extends Error { constructor (status, message) { super(message); this.status = status } }

export function startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, siteUrl, agentKeySecret, now = Date.now, log = () => {} }) {
  const site = String(siteUrl || '').replace(/\/+$/, '')

  const bearer = (req) => (String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i) || [])[1] || ''
  async function user (req) {
    const u = await verifyUser(bearer(req))
    if (!u) throw new HttpError(401, 'sign in first')
    return u
  }

  const routes = [
    ['GET', /^\/healthz$/, async () => ({ ok: true })],

    ['POST', /^\/v1\/device\/start$/, async (req, body) => {
      const { publicKey, deviceName, platform } = body
      if (!parsePublicKey(publicKey)) throw new HttpError(400, 'publicKey must be an Ed25519 key (spki, base64url)')
      const deviceCode = newToken('dc_')
      let userCode
      do userCode = newUserCode(); while (await store.linkByUserCode(userCode))
      await store.createLink({
        deviceCodeHash: hashToken(deviceCode), userCode, publicKey,
        deviceName: String(deviceName || 'A computer').slice(0, 80), platform: String(platform || '').slice(0, 20),
        expiresAt: now() + LINK_TTL_MS
      })
      return { deviceCode, userCode, verificationUrl: `${site}/link?code=${userCode}`, interval: POLL_INTERVAL_S, expiresIn: LINK_TTL_MS / 1000 }
    }],

    ['POST', /^\/v1\/device\/poll$/, async (req, body) => {
      const link = await store.linkByDeviceCode(hashToken(body.deviceCode))
      if (!link) throw new HttpError(404, 'unknown device code')
      if (link.status === 'consumed' || (link.status === 'pending' && link.expiresAt < now())) throw new HttpError(410, 'expired')
      if (link.status === 'denied') throw new HttpError(403, 'denied')
      if (link.status === 'pending') return [202, { status: 'pending' }]
      // Approved: mint the device token now, so it only ever exists in this response.
      const token = newToken('qd_')
      await store.setDeviceToken(link.deviceId, hashToken(token))
      await store.updateLink(link.id, { status: 'consumed' })
      return { status: 'approved', token, profile: await store.profile(link.userId) }
    }],

    ['GET', /^\/v1\/device\/link\/([^/]+)$/, async (req, body, [code]) => {
      await user(req)
      const link = await openLink(code)
      return { userCode: link.userCode, deviceName: link.deviceName, platform: link.platform, expiresAt: link.expiresAt }
    }],

    ['POST', /^\/v1\/device\/approve$/, async (req, body) => {
      const u = await user(req)
      const link = await openLink(body.userCode)
      if (!body.approve) { await store.updateLink(link.id, { status: 'denied', userId: u.userId }); return { status: 'denied' } }
      const device = await store.upsertDevice({ userId: u.userId, name: link.deviceName, platform: link.platform, publicKey: link.publicKey })
      await store.updateLink(link.id, { status: 'approved', userId: u.userId, deviceId: device.id })
      return { status: 'approved', device: { id: device.id, name: device.name } }
    }]
  ]

  async function openLink (code) {
    const userCode = normalizeUserCode(code)
    const link = userCode && await store.linkByUserCode(userCode)
    if (!link) throw new HttpError(404, 'no such code')
    if (link.status !== 'pending' || link.expiresAt < now()) throw new HttpError(410, 'this code has expired or was already used')
    return link
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req) })
      res.end(JSON.stringify(data))
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors(req), 'access-control-allow-methods': 'GET,POST,PUT,DELETE', 'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '600' }); return res.end() }
    try {
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname))
      if (!route) throw new HttpError(404, 'not found')
      const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {}
      const out = await route[2](req, body, url.pathname.match(route[1]).slice(1).map(decodeURIComponent))
      if (Array.isArray(out)) send(out[0], out[1]); else send(200, out)
    } catch (err) {
      if (!(err instanceof HttpError)) log(`api error: ${err.stack || err}`)
      send(err.status || 500, { error: err instanceof HttpError ? err.message : 'internal error' })
    }
  })

  // Only the website may call the API from a browser.
  function cors (req) {
    return site && req.headers.origin === site ? { 'access-control-allow-origin': site, vary: 'origin' } : {}
  }

  return new Promise((resolve) => server.listen(port, host, () => {
    const p = server.address().port
    resolve({ port: p, url: `http://${host}:${p}`, close: () => new Promise((r) => server.close(r)) })
  }))
}

function readJson (req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); reject(new HttpError(413, 'too large')) } else chunks.push(c) })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new HttpError(400, 'bad json')) }
    })
    req.on('error', reject)
  })
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test test/api.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/api/server.js test/api.test.js
git commit -m "Add the accounts API with the device-code flow for linking the app"
```

---

### Task 5: API server: profile, agents, CORS and rate limit

**Files:**
- Modify: `src/api/server.js` (add routes and the rate limiter)
- Modify: `test/api.test.js` (append tests)

**Interfaces:**
- Consumes: Task 2 (`newAgentIdentity`), Task 4 (`startApi`).
- Produces: routes `GET /v1/me`, `PUT /v1/me/profile`, `POST /v1/me/signout` (device token), `POST /v1/agents`, `GET /v1/agents`, `DELETE /v1/agents/:id` (user JWT). A later plan (agent runtime) uses `store.agentByKey(hashToken(key))` and `openAgentIdentity`.

- [ ] **Step 1: Write the failing tests** (append to `test/api.test.js`)

```js
async function linkedDevice (userId) {
  const { publicKey } = generateIdentity()
  const s = await call('POST', '/v1/device/start', { publicKey, deviceName: 'Mac', platform: 'darwin' })
  await call('POST', '/v1/device/approve', { userCode: s.body.userCode, approve: true }, `user:${userId}`)
  return (await call('POST', '/v1/device/poll', { deviceCode: s.body.deviceCode })).body.token
}

test('the app reads and edits its profile with its device token, and signing out revokes it', async () => {
  const token = await linkedDevice('u2')
  assert.equal((await call('GET', '/v1/me', null, token)).body.profile.name, 'Eli')
  const put = await call('PUT', '/v1/me/profile', { name: 'Eli M', color: '#2F5D62', tool: 'Cursor', extra: 'ignored' }, token)
  assert.deepEqual([put.body.profile.name, put.body.profile.color, put.body.profile.tool], ['Eli M', '#2F5D62', 'Cursor'])
  assert.equal((await call('PUT', '/v1/me/profile', { color: 'red' }, token)).status, 400)
  assert.equal((await call('POST', '/v1/me/signout', {}, token)).status, 200)
  assert.equal((await call('GET', '/v1/me', null, token)).status, 401)
})

test('agents: created by their owner with a key shown once, listed without secrets, revoked', async () => {
  const made = await call('POST', '/v1/agents', { name: 'Larry' }, 'user:u1')
  assert.equal(made.status, 200)
  assert.match(made.body.key, /^qa_/)
  assert.equal(made.body.agent.name, 'Larry')
  assert.equal(made.body.agent.keyPrefix, made.body.key.slice(0, 8))
  const list = await call('GET', '/v1/agents', null, 'user:u1')
  assert.equal(list.body.agents.length, 1)
  assert.equal(JSON.stringify(list.body).includes(made.body.key), false)
  assert.equal((await call('DELETE', `/v1/agents/${made.body.agent.id}`, null, 'user:u2')).status, 404)
  assert.equal((await call('DELETE', `/v1/agents/${made.body.agent.id}`, null, 'user:u1')).status, 200)
  assert.equal((await call('POST', '/v1/agents', { name: '' }, 'user:u1')).status, 400)
  assert.equal((await call('POST', '/v1/agents', { name: 'x' })).status, 401)
})

test('browsers: only the website origin gets CORS headers', async () => {
  const ok = await fetch(api.url + '/v1/agents', { method: 'OPTIONS', headers: { origin: SITE } })
  assert.equal(ok.headers.get('access-control-allow-origin'), SITE)
  const other = await fetch(api.url + '/v1/agents', { method: 'OPTIONS', headers: { origin: 'https://evil.test' } })
  assert.equal(other.headers.get('access-control-allow-origin'), null)
})

test('starting links is rate-limited per address', async () => {
  const limited = await startApi({ store: createMemoryStore(), verifyUser, siteUrl: SITE, agentKeySecret: 's', startLimit: 2 })
  try {
    const { publicKey } = generateIdentity()
    const go = () => fetch(limited.url + '/v1/device/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey, deviceName: 'X' }) })
    assert.equal((await go()).status, 200)
    assert.equal((await go()).status, 200)
    assert.equal((await go()).status, 429)
  } finally { await limited.close() }
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/api.test.js`
Expected: the 4 new tests FAIL (404 not found / missing CORS / no 429)

- [ ] **Step 3: Implement** (in `src/api/server.js`)

Add the import and options:

```js
import { newAgentIdentity } from './agent-keys.js'
```

Change the signature to accept `startLimit = 10, trustProxy = false`:

```js
export function startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, siteUrl, agentKeySecret, now = Date.now, log = () => {}, startLimit = 10, trustProxy = false }) {
```

Add, after `async function user (req) { … }`:

```js
  async function device (req) {
    const d = await store.deviceByToken(hashToken(bearer(req)))
    if (!d) throw new HttpError(401, 'this computer is signed out')
    await store.touchDevice(d.id)
    return d
  }

  // A few link requests per minute per address is plenty for a person.
  const starts = new Map()
  function limitStarts (req) {
    const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress
    const recent = (starts.get(ip) || []).filter((t) => now() - t < 60_000)
    if (recent.length >= startLimit) throw new HttpError(429, 'too many sign-in attempts; try again in a minute')
    starts.set(ip, [...recent, now()])
  }

  const COLOR = /^#[0-9a-fA-F]{6}$/
  function cleanProfile (b) {
    const out = {}
    if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 60); if (!n) throw new HttpError(400, 'name is empty'); out.name = n }
    if (b.color !== undefined) { if (b.color !== null && !COLOR.test(b.color)) throw new HttpError(400, 'color must be #RRGGBB'); out.color = b.color }
    if (b.tool !== undefined) out.tool = b.tool === null ? null : String(b.tool).slice(0, 40)
    return out
  }
```

Call `limitStarts(req)` as the first line of the `device/start` handler. Then add these routes to the `routes` array:

```js
    ['GET', /^\/v1\/me$/, async (req) => {
      const d = await device(req)
      return { profile: await store.profile(d.userId), device: { id: d.id, name: d.name } }
    }],

    ['PUT', /^\/v1\/me\/profile$/, async (req, body) => {
      const d = await device(req)
      return { profile: await store.updateProfile(d.userId, cleanProfile(body)) }
    }],

    ['POST', /^\/v1\/me\/signout$/, async (req) => {
      const d = await device(req)
      await store.revokeDevice(d.id)
      return { ok: true }
    }],

    ['POST', /^\/v1\/agents$/, async (req, body) => {
      const u = await user(req)
      const name = String(body.name || '').trim().slice(0, 40)
      if (!name) throw new HttpError(400, 'give the agent a name')
      const key = newToken('qa_')
      const agent = await store.createAgent({ ownerId: u.userId, name, keyPrefix: key.slice(0, 8), keyHash: hashToken(key), ...newAgentIdentity(agentKeySecret) })
      return { agent, key }
    }],

    ['GET', /^\/v1\/agents$/, async (req) => {
      const u = await user(req)
      return { agents: await store.listAgents(u.userId) }
    }],

    ['DELETE', /^\/v1\/agents\/([^/]+)$/, async (req, body, [id]) => {
      const u = await user(req)
      if (!await store.revokeAgent(u.userId, id)) throw new HttpError(404, 'no such agent')
      return { ok: true }
    }]
```

Also make `createAgent`'s result safe: the memory store already drops `keyHash`/`privateKeyEnc`; `supabase-store.js` (Task 7) must do the same.

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test test/api.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/api/server.js test/api.test.js
git commit -m "Add profile sync, sign-out and agent keys to the accounts API"
```

---

### Task 6: Verifying website users (Supabase JWT)

**Files:**
- Create: `src/api/auth.js`
- Test: `test/api-auth.test.js`
- Modify: `package.json` (add `jose`)

**Interfaces:**
- Produces: `createUserVerifier({ supabaseUrl, jwks }) -> (token) => Promise<{ userId, email } | null>`. `jwks` is optional (tests pass a local key set); production fetches `${supabaseUrl}/auth/v1/.well-known/jwks.json`.

- [ ] **Step 1: Add the dependency**

Run: `npm install jose@^6.2.12`
Expected: `package.json` lists `"jose": "^6.2.12"` under dependencies.

- [ ] **Step 2: Write the failing test**

```js
// test/api-auth.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose'
import { createUserVerifier } from '../src/api/auth.js'

const URL_ = 'https://proj.supabase.co'
async function setup () {
  const { publicKey, privateKey } = await generateKeyPair('ES256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' }
  const verify = createUserVerifier({ supabaseUrl: URL_, jwks: createLocalJWKSet({ keys: [jwk] }) })
  const sign = (claims, opts = {}) => new SignJWT({ email: 'dana@x.test', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(opts.iss || `${URL_}/auth/v1`).setAudience(opts.aud || 'authenticated')
    .setSubject('user-123').setIssuedAt().setExpirationTime(opts.exp || '1h').sign(opts.key || privateKey)
  return { verify, sign }
}

test("a signed-in user's token is accepted", async () => {
  const { verify, sign } = await setup()
  assert.deepEqual(await verify(await sign({})), { userId: 'user-123', email: 'dana@x.test' })
})

test('forged, expired, wrong-issuer and missing tokens are rejected', async () => {
  const { verify, sign } = await setup()
  const other = (await generateKeyPair('ES256')).privateKey
  assert.equal(await verify(await sign({}, { key: other })), null)
  assert.equal(await verify(await sign({}, { exp: Math.floor(Date.now() / 1000) - 10 })), null)
  assert.equal(await verify(await sign({}, { iss: 'https://evil/auth/v1' })), null)
  assert.equal(await verify(await sign({}, { aud: 'anon' })), null)
  assert.equal(await verify(''), null)
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --test test/api-auth.test.js`
Expected: FAIL, module not found

- [ ] **Step 4: Implement**

```js
// src/api/auth.js
// Website users sign in with Supabase; the API trusts a request from them when its
// bearer token is a JWT signed by the project's keys (fetched from its JWKS).
import { createRemoteJWKSet, jwtVerify } from 'jose'

export function createUserVerifier ({ supabaseUrl, jwks }) {
  const base = String(supabaseUrl).replace(/\/+$/, '')
  const keys = jwks || createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`))
  return async (token) => {
    if (!token) return null
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: `${base}/auth/v1`, audience: 'authenticated' })
      return payload.sub ? { userId: payload.sub, email: payload.email || '' } : null
    } catch {
      return null
    }
  }
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `node --test test/api-auth.test.js`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/api/auth.js test/api-auth.test.js package.json package-lock.json
git commit -m "Verify website users' Supabase sign-ins in the accounts API"
```

---

### Task 7: Supabase schema and store

**Files:**
- Create: `supabase/migrations/20260929000000_accounts.sql`
- Create: `src/api/supabase-store.js`
- Modify: `package.json` (add `@supabase/supabase-js`)

**Interfaces:**
- Consumes: the Store interface.
- Produces: `createSupabaseStore({ url, serviceKey }) -> store` with the same methods as `createMemoryStore` (except `addUser`).

This task has no unit tests (it needs a live database); Task 8's smoke test exercises every method against the real project.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260929000000_accounts.sql
-- Quilt accounts: profiles, linked computers, link requests, agents.
-- Clients (the website) read their own rows through row-level security; the
-- accounts API writes secrets with the service role.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  color text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  tool text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  platform text not null default '',
  public_key text not null unique,
  token_hash text unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table public.device_links (
  id uuid primary key default gen_random_uuid(),
  device_code_hash text not null unique,
  user_code text not null unique,
  public_key text not null,
  device_name text not null,
  platform text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'consumed')),
  user_id uuid references auth.users (id) on delete cascade,
  device_id uuid references public.devices (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  public_key text not null unique,
  private_key_enc text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table public.agent_rooms (
  agent_id uuid not null references public.agents (id) on delete cascade,
  server text not null,
  room text not null,
  secret_enc text not null,
  joined_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  primary key (agent_id, server, room)
);

create index devices_user_id on public.devices (user_id);
create index agents_owner_id on public.agents (owner_id);

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.device_links enable row level security;
alter table public.agents enable row level security;
alter table public.agent_rooms enable row level security;

-- People see and edit their own profile.
create policy "own profile: read" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "own profile: edit" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- People see their computers and can rename or unlink them; secrets stay hidden (column grants below).
create policy "own devices: read" on public.devices for select to authenticated using ((select auth.uid()) = user_id);
create policy "own devices: rename or unlink" on public.devices for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- People see their agents and can revoke them.
create policy "own agents: read" on public.agents for select to authenticated using ((select auth.uid()) = owner_id);
create policy "own agents: revoke" on public.agents for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

-- device_links and agent_rooms have no client policies: only the API (service role) touches them.

-- Column privileges: clients never read hashes or encrypted keys, and only change safe columns.
revoke all on public.devices, public.agents, public.device_links, public.agent_rooms from anon, authenticated;
grant select (id, user_id, name, platform, public_key, created_at, last_seen_at, revoked_at) on public.devices to authenticated;
grant update (name, revoked_at) on public.devices to authenticated;
grant select (id, owner_id, name, key_prefix, public_key, created_at, last_used_at, revoked_at) on public.agents to authenticated;
grant update (revoked_at) on public.agents to authenticated;
revoke all on public.profiles from anon;
grant select, update (name, color, tool, updated_at) on public.profiles to authenticated;

-- A profile for every new account, named from the sign-in provider or the email.
create function public.handle_new_user () returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1), 'You'));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
```

- [ ] **Step 2: Add the dependency**

Run: `npm install @supabase/supabase-js@^2.117.2`
Expected: listed under dependencies.

- [ ] **Step 3: Implement the store**

```js
// src/api/supabase-store.js
// The accounts API's data in Supabase, using the service role (row-level security is
// for the website; the API is trusted and writes the secrets).
import { createClient } from '@supabase/supabase-js'

const toCamel = (row) => row && Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (m, c) => c.toUpperCase()), v]))
const toSnake = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()), v]))
const ts = (v) => (v == null ? v : typeof v === 'number' ? new Date(v).toISOString() : v)
const ms = (v) => (v == null ? v : Date.parse(v))
const SAFE_AGENT = 'id, owner_id, name, key_prefix, public_key, created_at, last_used_at, revoked_at'

export function createSupabaseStore ({ url, serviceKey }) {
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const one = async (q) => { const { data, error } = await q; if (error) throw error; return data }
  const link = (r) => r && { ...toCamel(r), expiresAt: ms(r.expires_at), createdAt: ms(r.created_at) }

  return {
    async createLink (l) {
      return link(await one(db.from('device_links').insert(toSnake({ ...l, expiresAt: ts(l.expiresAt) })).select().single()))
    },
    async linkByDeviceCode (h) { return link(await one(db.from('device_links').select().eq('device_code_hash', h).maybeSingle())) },
    async linkByUserCode (c) { return link(await one(db.from('device_links').select().eq('user_code', c).maybeSingle())) },
    async updateLink (id, patch) {
      return link(await one(db.from('device_links').update(toSnake({ ...patch, expiresAt: ts(patch.expiresAt) })).eq('id', id).select().single()))
    },
    async upsertDevice ({ userId, name, platform, publicKey }) {
      return toCamel(await one(db.from('devices')
        .upsert({ user_id: userId, name, platform, public_key: publicKey, revoked_at: null }, { onConflict: 'public_key' })
        .select().single()))
    },
    async setDeviceToken (id, tokenHash) { await one(db.from('devices').update({ token_hash: tokenHash }).eq('id', id)) },
    async deviceByToken (h) { return toCamel(await one(db.from('devices').select().eq('token_hash', h).is('revoked_at', null).maybeSingle())) },
    async touchDevice (id) { await one(db.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', id)) },
    async revokeDevice (id) { await one(db.from('devices').update({ revoked_at: new Date().toISOString(), token_hash: null }).eq('id', id)) },
    async profile (userId) { return toCamel(await one(db.from('profiles').select('id, name, color, tool').eq('id', userId).maybeSingle())) },
    async updateProfile (userId, patch) {
      return toCamel(await one(db.from('profiles').update({ ...toSnake(patch), updated_at: new Date().toISOString() }).eq('id', userId).select('id, name, color, tool').single()))
    },
    async createAgent (a) { return toCamel(await one(db.from('agents').insert(toSnake(a)).select(SAFE_AGENT).single())) },
    async agentByKey (h) { return toCamel(await one(db.from('agents').select().eq('key_hash', h).is('revoked_at', null).maybeSingle())) },
    async listAgents (ownerId) { return (await one(db.from('agents').select(SAFE_AGENT).eq('owner_id', ownerId).order('created_at'))).map(toCamel) },
    async revokeAgent (ownerId, id) {
      const rows = await one(db.from('agents').update({ revoked_at: new Date().toISOString() }).eq('id', id).eq('owner_id', ownerId).select('id'))
      return rows.length > 0
    }
  }
}
```

- [ ] **Step 4: Check it loads**

Run: `node -e "import('./src/api/supabase-store.js').then(m => console.log(typeof m.createSupabaseStore))"`
Expected: `function`

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260929000000_accounts.sql src/api/supabase-store.js package.json package-lock.json
git commit -m "Add the accounts schema and the API's Supabase store"
```

---

### Task 8: `quilt api`, Supabase project, Fly deploy, smoke test

**Files:**
- Modify: `bin/quilt.js` (new `api` command and help line)
- Create: `fly.api.toml`
- Create: `scripts/api-smoke.mjs`

**Interfaces:**
- Consumes: Tasks 4–7.
- Produces: a running `https://quilt-api.fly.dev` (or `heyquilt-api`), and a Supabase project "Quilt" with the schema applied.

- [ ] **Step 1: Add the command**

In `bin/quilt.js`, add to the help text after the `quilt serve` line:

```
  quilt api [--port 8787] [--memory]                   Run the accounts API (needs SUPABASE_URL etc.; --memory for local testing)
```

Add to the `switch (cmd)`:

```js
    case 'api': return apiCmd()
```

And the function (next to `serve`):

```js
async function apiCmd () {
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string' }, host: { type: 'string' }, memory: { type: 'boolean' } } })
  const { startApi } = await import('../src/api/server.js')
  const env = process.env
  let store, verifyUser
  if (values.memory) {
    const { createMemoryStore } = await import('../src/api/memory-store.js')
    store = createMemoryStore(); store.addUser('local', { name: 'Local user' })
    verifyUser = async (t) => (t === 'local' ? { userId: 'local', email: '' } : null)
    console.log('in-memory mode: use "Authorization: Bearer local" as the signed-in user')
  } else {
    for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'AGENT_KEY_SECRET', 'QUILT_SITE_URL']) if (!env[k]) fail(`${k} is not set`)
    const { createSupabaseStore } = await import('../src/api/supabase-store.js')
    const { createUserVerifier } = await import('../src/api/auth.js')
    store = createSupabaseStore({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY })
    verifyUser = createUserVerifier({ supabaseUrl: env.SUPABASE_URL })
  }
  const api = await startApi({
    port: Number(values.port || env.PORT || 8787), host: values.host || '0.0.0.0', store, verifyUser,
    siteUrl: env.QUILT_SITE_URL || 'http://localhost:3000', agentKeySecret: env.AGENT_KEY_SECRET || 'dev-only-secret',
    trustProxy: /^(1|true|yes)$/i.test(env.QUILT_TRUST_PROXY || ''), log: console.log
  })
  console.log(`quilt accounts API listening on :${api.port}`)
  const shutdown = async () => { await api.close(); process.exit(0) }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
}
```

(`fail` already exists in `bin/quilt.js`.)

Run: `node bin/quilt.js api --memory --port 8799 & sleep 1; curl -s localhost:8799/healthz; kill %1`
Expected: `{"ok":true}`

- [ ] **Step 2: Fly config**

```toml
# fly.api.toml — the Quilt accounts API (separate from the relay in fly.toml).
#   fly apps create quilt-api
#   fly secrets set --app quilt-api SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… AGENT_KEY_SECRET=… QUILT_SITE_URL=…
#   fly deploy --config fly.api.toml --remote-only --ha=false
app = "quilt-api"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[processes]
  app = "node bin/quilt.js api"

[env]
  PORT = "8080"
  QUILT_TRUST_PROXY = "1"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0
  processes = ["app"]

  [[http_service.checks]]
    grace_period = "10s"
    interval = "30s"
    method = "GET"
    path = "/healthz"
    timeout = "5s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

The API reuses the relay's image. Its `ENTRYPOINT` (`deploy/entrypoint.sh`) ends with `exec su-exec node "$@"`, so Fly's `[processes] app = "node bin/quilt.js api"` runs the API as the unprivileged `node` user; the `/data` folder it creates on the way is unused and harmless.

- [ ] **Step 3: Create the Supabase project (ask first)**

Use the Supabase tools: `get_cost` for a new project in organization `efgydvofwzbxvvcfquhw`, **show the user the price and wait for a yes**, then `confirm_cost` and `create_project` (name "Quilt", region `us-east-1`). Wait until its status is `ACTIVE_HEALTHY`. Then `apply_migration` with name `accounts` and the SQL from Task 7, and `get_advisors` (security) — fix anything it reports as an error.

Get the project URL with `get_project_url`. The service role key and JWT settings come from the Supabase dashboard (the tools expose publishable keys, not the service role): ask the user to paste the **service role key** into a Fly secret themselves:

```bash
fly secrets set --app quilt-api SUPABASE_SERVICE_ROLE_KEY=<paste from Supabase → Project Settings → API keys>
```

- [ ] **Step 4: Create the Fly app and set the other secrets**

```bash
fly apps create quilt-api || fly apps create heyquilt-api
fly secrets set --app quilt-api SUPABASE_URL=https://<ref>.supabase.co QUILT_SITE_URL=https://quilt.netlify.app AGENT_KEY_SECRET=$(openssl rand -base64 32)
```

(If the fallback name was used, replace `quilt-api` everywhere in this step, `fly.api.toml` and the smoke test.)

- [ ] **Step 5: Smoke test script**

```js
// scripts/api-smoke.mjs — checks a deployed accounts API end to end.
// Usage: QUILT_API=https://quilt-api.fly.dev QUILT_TEST_JWT=<a signed-in user's access token> node scripts/api-smoke.mjs
import { generateIdentity } from '../src/identity.js'
const API = process.env.QUILT_API; const JWT = process.env.QUILT_TEST_JWT
const call = async (m, p, b, t) => { const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, b: await r.json().catch(() => null) } }
const ok = (c, msg) => { if (!c) { console.error('FAIL', msg); process.exit(1) } console.log('ok  ', msg) }
ok((await call('GET', '/healthz')).b?.ok, 'health')
const { publicKey } = generateIdentity()
const st = await call('POST', '/v1/device/start', { publicKey, deviceName: 'smoke test', platform: 'test' }); ok(st.s === 200, 'device/start')
ok((await call('POST', '/v1/device/poll', { deviceCode: st.b.deviceCode })).s === 202, 'poll pending')
if (!JWT) { console.log('set QUILT_TEST_JWT to check approve, profile and agents'); process.exit(0) }
ok((await call('POST', '/v1/device/approve', { userCode: st.b.userCode, approve: true }, JWT)).s === 200, 'approve')
const tok = (await call('POST', '/v1/device/poll', { deviceCode: st.b.deviceCode })).b?.token; ok(tok?.startsWith('qd_'), 'token')
ok((await call('GET', '/v1/me', null, tok)).b?.profile?.id, 'me')
const ag = await call('POST', '/v1/agents', { name: 'smoke agent' }, JWT); ok(ag.b?.key?.startsWith('qa_'), 'agent created')
ok((await call('DELETE', `/v1/agents/${ag.b.agent.id}`, null, JWT)).s === 200, 'agent revoked')
ok((await call('POST', '/v1/me/signout', {}, tok)).s === 200, 'signout')
console.log('all good')
```

- [ ] **Step 6: Deploy and check**

```bash
fly deploy --config fly.api.toml --remote-only --ha=false
QUILT_API=https://quilt-api.fly.dev node scripts/api-smoke.mjs
```

Expected: `ok health`, `ok device/start`, `ok poll pending`, then the note about `QUILT_TEST_JWT` (the signed-in part is checked once the website exists, in plan 3).

- [ ] **Step 7: Run the whole suite, commit, merge, push**

```bash
npm test
git add bin/quilt.js fly.api.toml scripts/api-smoke.mjs
git commit -m "Add quilt api and deploy the accounts API to Fly"
```

Expected: all tests pass. Then merge into `main` and push, as usual.

---

## Self-review notes

- Spec coverage for this plan's slice: device flow (Tasks 1, 4), tokens and hashing (1), agent keys and encryption (2, 5), data model and row-level security (7), JWT verification (6), CORS and rate limits (4, 5), deployment (8). The MCP runtime, website and app are plans 2–4.
- `agent_rooms` is created here (Task 7) but first used in plan 2.
- The spec lists `devices` as owner-updatable for `name` and `revoked_at`; the grants in Task 7 match.

## Carried into later plans (from execution)

- **Plan 4 (desktop sign-in) must start with:** give the device-link poll signature its own context string (e.g. `quilt-device-link-v1`, via `signDeviceLink`/`verifyDeviceLink` in `src/identity.js`) instead of reusing the relay's auth payload, and make the relay client refuse room `device-link`. Until then a hostile relay could obtain a poll signature (impact limited to the attacker's own device row). The app must sign its polls: `{ deviceCode, signature }`.
- **Plan 3 (website):** select columns explicitly on `devices`/`agents` (no `select('*')` — secret columns aren't granted); timestamps arrive as ISO strings through row-level security but as epoch ms from the API. Switch Supabase Auth's site URL, redirect URLs and email templates to Quilt.
- **Plan 2 (agent runtime):** the website can revoke agents directly (row-level security), so the runtime re-checks `agentByKey`/`revoked_at` on each call; add `touchAgent` (last_used_at) and `agent_rooms` methods to both stores; never echo `agentByKey` rows in MCP responses; consider a per-user agent cap.
- **Deferred minors:** clean up old `device_links` rows; per-device-code poll rate limit; tokenless "ghost" device rows from cross-account approvals; least-privilege database role for the API instead of a Supabase secret key.
