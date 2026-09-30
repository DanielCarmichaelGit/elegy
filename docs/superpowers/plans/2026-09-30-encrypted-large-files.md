# Encrypted Large Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take big binary files out of the relay's in-memory session document. Each person's app encrypts them, stores them in Supabase Storage (or on the relay's disk when a relay has no Supabase), and the files are deleted when the session ends.

**Architecture:** A session's shared Yjs document keeps a short reference for each big binary file (`{ hash, size, stored: { id, key } }`) instead of the file's bytes. The app encrypts the file with a per-session file key (AES-256-GCM) and uploads it straight to storage using a short-lived upload link the relay hands out after checking the session secret. Other apps download it the same way and decrypt it. The file key lives in the document, wrapped (encrypted) with keys derived from the session's secrets, so only session members can open it. The relay only hands out links and keeps a list of which stored files belong to which session, so it can delete them.

**Tech Stack:** Node 22, `node:crypto` (HKDF, AES-256-GCM, HMAC), Yjs, `ws`, `@supabase/supabase-js` (already a dependency), Supabase Storage, `node:test`.

**Spec:** This document. The design is in "Design" below; there is no separate spec.

## Global Constraints

- Code style: StandardJS (no semicolons, 2-space indent, single quotes, space before function parens), ES modules, matching the files around it.
- A binary file is "large" at `LARGE_FILE_BYTES = 256 * 1024` bytes or more. Smaller binary files and all text files stay in the document exactly as today.
- Stored files may be up to `MAX_STORED_BINARY_BYTES = 100 * 1024 * 1024` bytes (the relay can lower it with `QUILT_MAX_STORED_FILE_MB`). Today's 8 MB cap (`MAX_BINARY_BYTES`) still applies whenever storage isn't available.
- Encryption: AES-256-GCM, 12-byte random nonce, 16-byte tag. Keys come from HKDF-SHA256. Nothing unencrypted is ever uploaded.
- Stored-file ids are 32 lowercase hex characters (`/^[a-f0-9]{32}$/`), the same shape as today's chat-file ids.
- Supabase bucket: `session-files`, private, object path `<room>/<id>`.
- The relay must keep working for self-hosted relays that have no Supabase settings. Those relays store the encrypted files on their own disk.
- User-facing text follows the app's voice: plain, active, no em dashes.
- Run `npm test` from the repo root after every task. All tests must pass before committing.

## Design

### What this does and doesn't promise

- **Promises:** Big files are stored encrypted. Whoever holds the storage (Supabase, or the relay's disk) can't read them, because the file key is only ever stored wrapped with keys derived from the session secrets. Stored files are deleted when the owner ends the session, when the session is deleted after 30 days unused, and when a file is replaced or removed.
- **Doesn't promise:** Code and small files still travel through the relay unencrypted, as today. The relay briefly sees the session secret when people connect (it stores only its hash). Hiding the secret from the relay, and encrypting code, are separate projects.

### Keys

- `deriveWrapKey(secret, room)` = HKDF-SHA256(ikm `secret`, salt `room`, info `quilt-file-key-wrap-v1`), 32 bytes.
- A **file key** is 32 random bytes. It lives in a new document map `fileKeys`: `keyId -> { wraps: [string], ts }`. Each wrap is the file key encrypted with a wrap key.
- Editors derive a wrap key from the edit secret, and people who can only view derive one from the view secret. An app tries every wrap with its own wrap key, and whichever opens gives it the file key.
- The session owner's app knows both secrets. It wraps every file key for both, and adds a viewer wrap to any key another editor created.
- If no key exists yet, the first app that needs one creates it. Keys are never overwritten, only added, so two apps creating keys at once is harmless. New uploads use the smallest `keyId` the app can open.

### Stored file ids

`blobId(fileKey, sha1)` = the first 32 hex characters of HMAC-SHA256(`fileKey`, `id:` + sha1 of the plaintext). The same file in the same session gets the same id, and the id reveals nothing about the file.

### Relay endpoints (new)

All take the session secret in `x-quilt-secret`, like `/files` today.

- `POST /blobs/<room>/<id>/upload` with body `{ "size": n }`. Editors only; viewers get 403. It checks the size cap and the session's storage quota (shared with chat files), and records `meta.blobs[id] = { size, ts }`. It returns `{ method: 'PUT', url }`.
- `POST /blobs/<room>/<id>/download`. Editors and viewers. Returns 404 for an unknown id, otherwise `{ url }`.
- `PUT` and `GET /blobs/<room>/<id>/data?m=&exp=&sig=`. Used only by the disk store. The link is HMAC-signed, method-bound and valid for 10 minutes.

The `url` is either absolute (a Supabase signed link) or relative (the disk store). Apps resolve it against the relay's address.

### Old apps

Old apps expect `data` on every entry in `blobs`. Once a session has stored a file (`meta.largeFiles = true`), the relay refuses connections that don't send `features=large-files` in their connection address, with the message "This session needs a newer version of Quilt. Update Quilt, then join again."

### Cleanup

- **Replaced or removed files:** When a session unloads from the relay's memory (60 seconds after the last person leaves), the relay deletes any stored files that no `blobs` entry references and that are more than an hour old.
- **Session deleted after 30 days unused:** The existing sweep also deletes the session's stored files.
- **Owner ends the session:** A new owner-only admin request, `{ op: 'end' }`. The relay replies, disconnects everyone with close code `4410` ("The owner ended this session"), and deletes the session's document, settings, chat files and stored files. The app's people menu gets an "End session for everyone" button for the owner.

## File Structure

- Create `src/largefiles.js`: all the encryption. `deriveWrapKey`, `newFileKey`, `wrapKey`, `unwrapKey`, `encryptBlob`, `decryptBlob`, `blobId`. Pure functions with no I/O.
- Create `src/blobstore.js`: where the relay keeps encrypted files. `DiskStore` and `SupabaseStore` share one interface (`uploadTarget`, `downloadTarget`, `remove`, `removeRoom`), plus `makeStore(cfg, dir)`.
- Modify `src/pathrules.js`: add `LARGE_FILE_BYTES` and `MAX_STORED_BINARY_BYTES`.
- Modify `src/fsutil.js`: re-export the two new constants.
- Modify `src/protocol.js`: add `CLOSE_ENDED = 4410`.
- Modify `src/server.js`: storage settings, `/blobs` routes, the feature check on connect, clean-up on unload and sweep, and the `end` admin request.
- Modify `src/connection.js`: send `features=large-files`, and handle close code 4410.
- Modify `src/session.js`: file keys, upload and download of large files, `readDisk` limits, and `endForEveryone()`.
- Modify `src/ui-server.js` and `src/ui/session.js`: the "End session for everyone" button.
- Create `supabase/migrations/20261001000000_session_files_bucket.sql`: the private bucket.
- Create `scripts/storage-smoke.mjs`: checks the real Supabase bucket end to end.
- Modify `docs/hosting.md` and `fly.toml`: the new settings.
- Tests: create `test/largefiles.test.js` (encryption), `test/blobstore.test.js` (disk store and relay routes) and `test/large-files-sync.test.js` (two and three apps through a real relay). Extend `test/relay.test.js` for cleanup and ending a session.

---

### Task 1: Encryption helpers

**Files:**
- Create: `src/largefiles.js`
- Test: `test/largefiles.test.js`

**Interfaces:**
- Produces:
  - `deriveWrapKey(secret: string, room: string): Buffer` (32 bytes)
  - `newFileKey(): Buffer` (32 bytes)
  - `wrapKey(fileKey: Buffer, wrap: Buffer): string` (base64url)
  - `unwrapKey(wrapped: string, wrap: Buffer): Buffer | null` (null if it doesn't open)
  - `encryptBlob(plain: Buffer, fileKey: Buffer): Buffer`
  - `decryptBlob(sealed: Buffer, fileKey: Buffer): Buffer` (throws `Error('this file could not be decrypted')`)
  - `blobId(fileKey: Buffer, sha1Hex: string): string` (32 hex characters)

- [ ] **Step 1: Write the failing test**

Create `test/largefiles.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { deriveWrapKey, newFileKey, wrapKey, unwrapKey, encryptBlob, decryptBlob, blobId } from '../src/largefiles.js'

test('wrap keys depend on the secret and the room', () => {
  const a = deriveWrapKey('secret', 'room-1')
  assert.equal(a.length, 32)
  assert.deepEqual(a, deriveWrapKey('secret', 'room-1'))
  assert.notDeepEqual(a, deriveWrapKey('secret', 'room-2'))
  assert.notDeepEqual(a, deriveWrapKey('other', 'room-1'))
})

test('a wrapped file key opens only with the wrap key it was wrapped with', () => {
  const key = newFileKey()
  const edit = deriveWrapKey('edit', 'r')
  const view = deriveWrapKey('view', 'r')
  const wraps = [wrapKey(key, edit), wrapKey(key, view)]
  assert.deepEqual(unwrapKey(wraps[0], edit), key)
  assert.deepEqual(unwrapKey(wraps[1], view), key)
  assert.equal(unwrapKey(wraps[0], view), null)
  assert.equal(unwrapKey('not-a-wrap', edit), null)
})

test('files round-trip, and tampering is caught', () => {
  const key = newFileKey()
  const plain = crypto.randomBytes(300 * 1024)
  const sealed = encryptBlob(plain, key)
  assert.ok(!sealed.includes(plain.subarray(1000, 1064)), 'no plaintext in the sealed file')
  assert.deepEqual(decryptBlob(sealed, key), plain)
  sealed[sealed.length - 1] ^= 1
  assert.throws(() => decryptBlob(sealed, key), /could not be decrypted/)
  assert.throws(() => decryptBlob(encryptBlob(plain, key), newFileKey()), /could not be decrypted/)
})

test('ids are stable per key and content, and reveal nothing', () => {
  const key = newFileKey()
  const id = blobId(key, 'a'.repeat(40))
  assert.match(id, /^[a-f0-9]{32}$/)
  assert.equal(id, blobId(key, 'a'.repeat(40)))
  assert.notEqual(id, blobId(key, 'b'.repeat(40)))
  assert.notEqual(id, blobId(newFileKey(), 'a'.repeat(40)))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/largefiles.test.js`
Expected: FAIL with `Cannot find module '../src/largefiles.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/largefiles.js`:

```js
// Encryption for large files stored outside the session document. Each session
// has file keys; a file key is stored in the document only wrapped (encrypted)
// with keys derived from the session's secrets, so only members can open it.
import crypto from 'node:crypto'

const MAGIC = Buffer.from('QF1')
const NONCE = 12
const TAG = 16

/** The key that wraps file keys for whoever holds `secret` in `room`. */
export function deriveWrapKey (secret, room) {
  return Buffer.from(crypto.hkdfSync('sha256', String(secret), String(room), 'quilt-file-key-wrap-v1', 32))
}

export function newFileKey () {
  return crypto.randomBytes(32)
}

function seal (plain, key) {
  const nonce = crypto.randomBytes(NONCE)
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([nonce, body, c.getAuthTag()])
}

function open (sealed, key) {
  if (sealed.length < NONCE + TAG) throw new Error('too short')
  const d = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(0, NONCE))
  d.setAuthTag(sealed.subarray(sealed.length - TAG))
  return Buffer.concat([d.update(sealed.subarray(NONCE, sealed.length - TAG)), d.final()])
}

export function wrapKey (fileKey, wrap) {
  return seal(fileKey, wrap).toString('base64url')
}

/** The file key, or null if this wrap key doesn't open it. */
export function unwrapKey (wrapped, wrap) {
  try {
    const key = open(Buffer.from(String(wrapped), 'base64url'), wrap)
    return key.length === 32 ? key : null
  } catch {
    return null
  }
}

export function encryptBlob (plain, fileKey) {
  return Buffer.concat([MAGIC, seal(plain, fileKey)])
}

export function decryptBlob (sealed, fileKey) {
  try {
    if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a quilt file')
    return open(sealed.subarray(MAGIC.length), fileKey)
  } catch {
    throw new Error('this file could not be decrypted')
  }
}

/** Where a file is stored: the same for the same key and content, meaningless to anyone else. */
export function blobId (fileKey, sha1Hex) {
  return crypto.createHmac('sha256', fileKey).update(`id:${sha1Hex}`).digest('hex').slice(0, 32)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/largefiles.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/largefiles.js test/largefiles.test.js
git commit -m "Add encryption helpers for large files"
```

---

### Task 2: Where the relay keeps encrypted files

**Files:**
- Create: `src/blobstore.js`
- Modify: `src/server.js:46-61` (`relayConfig`)
- Test: `test/blobstore.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `class DiskStore { constructor(dir: string); uploadTarget(room, id): Promise<{ method: 'PUT', url: string }>; downloadTarget(room, id): Promise<{ url: string }>; verify(room, id, method, exp, sig): boolean; file(room, id): string; remove(room, ids: string[]): Promise<void>; removeRoom(room): Promise<void> }`. URLs are relative: `/blobs/<room>/<id>/data?m=<PUT|GET>&exp=<ms>&sig=<hex>`.
  - `class SupabaseStore { constructor({ url, key, bucket }) }` with the same four async methods. URLs are absolute.
  - `makeStore(cfg, dir): DiskStore | SupabaseStore`, which returns `SupabaseStore` when `cfg.storageUrl && cfg.storageKey`.
  - New `relayConfig` fields: `storageUrl`, `storageKey`, `storageBucket` (default `'session-files'`) and `maxStoredFileBytes` (default 100 MB).

- [ ] **Step 1: Write the failing test**

Create `test/blobstore.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DiskStore, SupabaseStore, makeStore } from '../src/blobstore.js'
import { relayConfig } from '../src/server.js'

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-blob-${n}-`))
const ID = 'a'.repeat(32)

test('disk store links are signed, method-bound and expire', async () => {
  const store = new DiskStore(tmp('disk'))
  const up = await store.uploadTarget('room', ID)
  assert.equal(up.method, 'PUT')
  const q = new URL(up.url, 'http://x').searchParams
  assert.match(up.url, new RegExp(`^/blobs/room/${ID}/data\\?`))
  assert.equal(store.verify('room', ID, 'PUT', q.get('exp'), q.get('sig')), true)
  assert.equal(store.verify('room', ID, 'GET', q.get('exp'), q.get('sig')), false, 'bound to the method')
  assert.equal(store.verify('other', ID, 'PUT', q.get('exp'), q.get('sig')), false, 'bound to the room')
  assert.equal(store.verify('room', ID, 'PUT', String(Date.now() - 1), q.get('sig')), false, 'expired or altered')
})

test('disk store removes files and whole rooms', async () => {
  const dir = tmp('rm')
  const store = new DiskStore(dir)
  fs.mkdirSync(path.dirname(store.file('room', ID)), { recursive: true })
  fs.writeFileSync(store.file('room', ID), 'x')
  fs.writeFileSync(store.file('room', 'b'.repeat(32)), 'y')
  await store.remove('room', [ID])
  assert.equal(fs.existsSync(store.file('room', ID)), false)
  assert.equal(fs.existsSync(store.file('room', 'b'.repeat(32))), true)
  await store.removeRoom('room')
  assert.equal(fs.existsSync(path.join(dir, 'room')), false)
})

test('the relay uses Supabase only when it has both a URL and a key', () => {
  assert.ok(makeStore(relayConfig({}), tmp('a')) instanceof DiskStore)
  const cfg = relayConfig({ storageUrl: 'https://x.supabase.co', storageKey: 'sb_secret_x' })
  assert.ok(makeStore(cfg, tmp('b')) instanceof SupabaseStore)
  assert.equal(cfg.storageBucket, 'session-files')
  assert.equal(relayConfig({}).maxStoredFileBytes, 100 * 1024 * 1024)
  assert.equal(relayConfig({ maxStoredFileBytes: 10 }).maxStoredFileBytes, 10)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/blobstore.test.js`
Expected: FAIL with `Cannot find module '../src/blobstore.js'`.

- [ ] **Step 3: Add the storage settings to `relayConfig`**

In `src/server.js`, inside the object that `relayConfig` returns, add after the `trustProxy` line (add a comma to the end of the `trustProxy` line):

```js
    // Large files: Supabase Storage when both are set, otherwise the relay's own disk.
    storageUrl: opts.storageUrl ?? env.QUILT_STORAGE_URL ?? '',
    storageKey: opts.storageKey ?? env.QUILT_STORAGE_KEY ?? '',
    storageBucket: opts.storageBucket ?? env.QUILT_STORAGE_BUCKET ?? 'session-files',
    maxStoredFileBytes: num(opts.maxStoredFileBytes ?? env.QUILT_MAX_STORED_FILE_MB, 100) * (opts.maxStoredFileBytes !== undefined ? 1 : MB)
```

- [ ] **Step 4: Write the stores**

Create `src/blobstore.js`:

```js
// Where the relay keeps large files. The files are already encrypted by the
// apps; the relay only hands out short-lived links and deletes what's unused.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const LINK_MS = 10 * 60 * 1000

/** Files on the relay's own disk, reached through signed links to the relay. */
export class DiskStore {
  constructor (dir) {
    this.dir = dir
    this.signing = crypto.randomBytes(32)
  }

  file (room, id) { return path.join(this.dir, room, id) }

  sign (room, id, method, exp) {
    return crypto.createHmac('sha256', this.signing).update(`${method} ${room}/${id} ${exp}`).digest('hex')
  }

  link (room, id, method) {
    const exp = Date.now() + LINK_MS
    return `/blobs/${room}/${id}/data?m=${method}&exp=${exp}&sig=${this.sign(room, id, method, exp)}`
  }

  verify (room, id, method, exp, sig) {
    if (!(Number(exp) > Date.now())) return false
    const want = Buffer.from(this.sign(room, id, method, exp), 'hex')
    const got = Buffer.from(String(sig || ''), 'hex')
    return got.length === want.length && crypto.timingSafeEqual(got, want)
  }

  async uploadTarget (room, id) { return { method: 'PUT', url: this.link(room, id, 'PUT') } }
  async downloadTarget (room, id) { return { url: this.link(room, id, 'GET') } }
  async remove (room, ids) { for (const id of ids) fs.rmSync(this.file(room, id), { force: true }) }
  async removeRoom (room) { fs.rmSync(path.join(this.dir, room), { recursive: true, force: true }) }
}

/** Files in a private Supabase Storage bucket; apps upload and download directly. */
export class SupabaseStore {
  constructor ({ url, key, bucket }) {
    this.bucket = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).storage.from(bucket)
  }

  static path (room, id) { return `${room}/${id}` }

  async uploadTarget (room, id) {
    const { data, error } = await this.bucket.createSignedUploadUrl(SupabaseStore.path(room, id), { upsert: true })
    if (error) throw new Error(`storage: ${error.message}`)
    return { method: 'PUT', url: data.signedUrl }
  }

  async downloadTarget (room, id) {
    const { data, error } = await this.bucket.createSignedUrl(SupabaseStore.path(room, id), LINK_MS / 1000)
    if (error) throw new Error(`storage: ${error.message}`)
    return { url: data.signedUrl }
  }

  async remove (room, ids) {
    if (!ids.length) return
    const { error } = await this.bucket.remove(ids.map((id) => SupabaseStore.path(room, id)))
    if (error) throw new Error(`storage: ${error.message}`)
  }

  async removeRoom (room) {
    for (;;) {
      const { data, error } = await this.bucket.list(room, { limit: 1000 })
      if (error) throw new Error(`storage: ${error.message}`)
      if (!data.length) return
      await this.remove(room, data.map((f) => f.name))
    }
  }
}

export function makeStore (cfg, dir) {
  if (cfg.storageUrl && cfg.storageKey) return new SupabaseStore({ url: cfg.storageUrl, key: cfg.storageKey, bucket: cfg.storageBucket })
  return new DiskStore(dir)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/blobstore.test.js && npm test`
Expected: PASS, and the full suite still passes.

- [ ] **Step 6: Commit**

```bash
git add src/blobstore.js src/server.js test/blobstore.test.js
git commit -m "Add the relay's store for encrypted large files"
```

---

### Task 3: Relay endpoints for large files

**Files:**
- Modify: `src/server.js` (inside `startServer`, before the `/files` route; the WebSocket `upgrade` handler)
- Test: `test/blobstore.test.js` (append)

**Interfaces:**
- Consumes: `makeStore`, `DiskStore` (Task 2).
- Produces the HTTP endpoints described in "Relay endpoints" above, plus `meta.blobs: { [id]: { size, ts } }` and `meta.largeFiles: true` on the room. It also adds `srv.store` to the object `startServer` resolves (for tests).

- [ ] **Step 1: Write the failing tests**

Append to `test/blobstore.test.js`:

```js
import { startServer } from '../src/server.js'
import { Connection } from '../src/connection.js'
import { generateIdentity } from '../src/identity.js'
import * as Y from 'yjs'

async function relay (t, opts = {}) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, ...opts })
  t.after(() => srv.close())
  return { srv, base: `http://127.0.0.1:${srv.port}` }
}
const ask = (base, room, id, action, secret, body = {}) => fetch(`${base}/blobs/${room}/${id}/${action}`, {
  method: 'POST', headers: { 'x-quilt-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify(body)
})

test('editors get an upload link, and anyone in the room can download', async (t) => {
  const { srv, base } = await relay(t)
  const up = await ask(base, 'r1', ID, 'upload', 's', { size: 5 })
  assert.equal(up.status, 200)
  const target = await up.json()
  const put = await fetch(new URL(target.url, base), { method: 'PUT', body: 'hello' })
  assert.equal(put.status, 201)
  assert.equal(fs.readFileSync(srv.store.file('r1', ID), 'utf8'), 'hello')
  assert.equal(srv.rooms.get('r1').meta.largeFiles, true)

  const down = await ask(base, 'r1', ID, 'download', 's')
  const { url } = await down.json()
  assert.equal(await (await fetch(new URL(url, base))).text(), 'hello')

  assert.equal((await ask(base, 'r1', ID, 'download', 'wrong')).status, 401)
  assert.equal((await ask(base, 'r1', 'c'.repeat(32), 'download', 's')).status, 404)
  assert.equal((await fetch(`${base}/blobs/r1/${ID}/data?m=GET&exp=1&sig=00`)).status, 403)
})

test('uploads are refused over the size cap or the room quota', async (t) => {
  const { base } = await relay(t, { maxStoredFileBytes: 10, maxRoomFileBytes: 15 })
  assert.equal((await ask(base, 'r2', ID, 'upload', 's', { size: 11 })).status, 413)
  assert.equal((await ask(base, 'r2', ID, 'upload', 's', { size: 10 })).status, 200)
  assert.equal((await ask(base, 'r2', 'b'.repeat(32), 'upload', 's', { size: 10 })).status, 413)
  // A PUT larger than it said is cut off.
  const { base: b2 } = await relay(t, { maxStoredFileBytes: 10 })
  const target = await (await ask(b2, 'r3', ID, 'upload', 's', { size: 4 })).json()
  assert.equal((await fetch(new URL(target.url, b2), { method: 'PUT', body: 'x'.repeat(50) })).status, 413)
})

test('once a room stores files, apps without large-file support are turned away', async (t) => {
  const { base } = await relay(t)
  await ask(base, 'r4', ID, 'upload', 's', { size: 1 })
  const server = base.replace('http', 'ws')
  const refused = await new Promise((resolve) => {
    const c = new Connection({ server, room: 'r4', secret: 's', name: 'old', identity: generateIdentity(), doc: new Y.Doc(), features: '' })
    c.on('fatal', (err) => { c.close(); resolve(err.message) })
  })
  assert.match(refused, /newer version of Quilt/)
  const c = new Connection({ server, room: 'r4', secret: 's', name: 'new', identity: generateIdentity(), doc: new Y.Doc() })
  t.after(() => c.close())
  await c.waitForSync()
})
```

(The `features: ''` option comes from Task 4. Until then this last test fails, and it's expected to pass after Task 4.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/blobstore.test.js`
Expected: the three new tests FAIL (404 from the relay; `srv.store` undefined).

- [ ] **Step 3: Create the store and expose it**

In `src/server.js`, add to the imports:

```js
import { makeStore } from './blobstore.js'
```

Inside `startServer`, right after the line that sets `filesDir`, add:

```js
  // Large files, already encrypted by the apps. See blobstore.js.
  const store = makeStore(cfg, path.join(path.dirname(filesDir), 'blobs'))
  const storedBytes = (room) => Object.values(room.meta.blobs || {}).reduce((n, b) => n + (b.size || 0), 0)
```

In the object passed to `resolve(...)` at the end of `startServer`, add `store,` after `rooms, // exposed for tests`.

- [ ] **Step 4: Add the routes**

In `httpServer`'s request handler, directly before the line `const m = url.pathname.match(/^\/files\/...`, add:

```js
    const bm = url.pathname.match(/^\/blobs\/([A-Za-z0-9_-]{1,64})\/([a-f0-9]{32})\/(upload|download|data)$/)
    if (bm) {
      const [, name, id, action] = bm
      if (action === 'data') {
        // The disk store's signed links: no secret needed, the signature is the permission.
        if (!(store instanceof DiskStore)) return text(404, 'not found')
        const method = req.method === 'PUT' ? 'PUT' : 'GET'
        if (url.searchParams.get('m') !== method || !store.verify(name, id, method, url.searchParams.get('exp'), url.searchParams.get('sig'))) return text(403, 'this link has expired')
        const file = store.file(name, id)
        if (method === 'GET') {
          if (!fs.existsSync(file)) return text(404, 'no such file')
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(file).size })
          return fs.createReadStream(file).pipe(res)
        }
        return receiveBlob(req, file, cfg.maxStoredFileBytes, (err) => err ? text(err.code || 500, err.message) : text(201, 'stored'))
      }
      if (req.method !== 'POST') return text(405, 'method not allowed')
      const room = getRoom(name)
      if (!room) return text(413, TOO_BIG)
      const creating = !room.exists
      if (creating && !canCreate(clientIp(req))) { dropIfUnused(room); return text(429, 'too many new sessions from this address; try again later') }
      const auth = room.authorize(req.headers['x-quilt-secret'] || '', req.headers['x-quilt-key'] || '')
      if (auth === 'need-key' || auth === 'bad-secret') {
        dropIfUnused(room)
        return text(auth === 'need-key' ? 403 : 401, auth === 'need-key' ? 'this relay needs a key to create rooms' : 'wrong room secret')
      }
      if (creating) noteCreated(clientIp(req))
      const done = () => { if (!room.conns.size && room.onEmpty) room.onEmpty() }
      return readJson(req, 1024, async (err, body) => {
        try {
          if (err) return text(400, err.message)
          room.meta.blobs = room.meta.blobs || {}
          if (action === 'download') {
            if (!room.meta.blobs[id]) return text(404, 'no such file')
            return json(200, await store.downloadTarget(name, id))
          }
          if (auth !== 'editor') return text(403, 'you can only view this session')
          const size = Number(body && body.size)
          if (!(size >= 0)) return text(400, 'size required')
          if (size > cfg.maxStoredFileBytes) return text(413, `files over ${Math.round(cfg.maxStoredFileBytes / MB)} MB can't be shared`)
          const others = storedBytes(room) - (room.meta.blobs[id]?.size || 0)
          if (others + size + dirSize(path.join(filesDir, name)) > cfg.maxRoomFileBytes) return text(413, 'this room has used its file storage quota')
          room.meta.blobs[id] = { size, ts: Date.now() }
          room.meta.largeFiles = true
          room.saveMeta()
          json(200, await store.uploadTarget(name, id))
        } catch (e) {
          log(`[${name}] storage error: ${e.message}`)
          if (!res.headersSent) text(502, 'file storage is unavailable right now')
        } finally { done() }
      })
    }
```

Add `DiskStore` to the blobstore import (`import { makeStore, DiskStore } from './blobstore.js'`). Directly under the `text` helper at the top of the handler, add a JSON helper:

```js
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
```

Below the existing `receiveFile` function, add `receiveBlob`, which streams to a temporary file with a hard cap:

```js
/** Streams a request body to `file`, refusing anything over `limit` bytes. */
function receiveBlob (req, file, limit, done) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`
  const out = fs.createWriteStream(tmp)
  let size = 0
  let failed = false
  const fail = (code, message) => {
    if (failed) return
    failed = true
    req.unpipe(out)
    out.destroy()
    fs.rmSync(tmp, { force: true })
    done(Object.assign(new Error(message), { code }))
  }
  req.on('data', (chunk) => { size += chunk.length; if (size > limit) fail(413, 'file too large') })
  req.on('error', () => fail(400, 'upload interrupted'))
  out.on('error', () => fail(500, 'could not save the file'))
  out.on('finish', () => { if (!failed) { fs.renameSync(tmp, file); done(null) } })
  req.pipe(out)
}
```

- [ ] **Step 5: Refuse old apps once a room stores files**

In the `upgrade` handler, after `if (!room) return reject(socket, 413, TOO_BIG)`, add:

```js
    const features = String(url.searchParams.get('features') || '').split(',')
    if (room.meta.largeFiles && !features.includes('large-files')) return reject(socket, 400, 'This session needs a newer version of Quilt. Update Quilt, then join again.')
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/blobstore.test.js`
Expected: the first two new tests PASS. The "turned away" test still FAILS until Task 4, because `Connection` doesn't send `features` yet.

- [ ] **Step 7: Commit**

```bash
git add src/server.js test/blobstore.test.js
git commit -m "Relay: hand out links for encrypted large files"
```

---

### Task 4: Apps announce large-file support, and the relay can end a session

**Files:**
- Modify: `src/protocol.js` (add `CLOSE_ENDED`)
- Modify: `src/connection.js:35-42` (URL), and its `ws.on('close')` handler
- Modify: `src/server.js` (`Room.adminRequest`, `Room.save`, `Room.saveMeta`, `getRoom`, `sweep`)
- Test: `test/relay.test.js` (append)

**Interfaces:**
- Consumes: `store` (Task 3).
- Produces:
  - `Connection` constructor option `features` (default `'large-files'`).
  - `CLOSE_ENDED = 4410`.
  - Admin request `{ op: 'end' }` (owner only), after which `fatal` fires on every connection with `err.ended === true`.
  - Stored files are deleted on sweep, on end, and for unreferenced ids when a room unloads.

- [ ] **Step 1: Write the failing tests**

Append to `test/relay.test.js`:

```js
test('the owner can end a session: everyone is sent away and its data is deleted', async (t) => {
  const defer = cleanups(t)
  const dataDir = tmp('end')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir })
  defer(() => srv.close())
  const server = `ws://127.0.0.1:${srv.port}`
  const ownerDoc = new Y.Doc()
  const owner = new Connection({ server, room: 'ending', secret: 's', viewSecret: 'v', name: 'olive', identity: generateIdentity(), doc: ownerDoc })
  defer(() => owner.close())
  await owner.waitForSync()
  await waitFor(() => owner.access && owner.access.owner)
  ownerDoc.getText('t').insert(0, 'bye')
  await waitFor(() => fs.existsSync(path.join(dataDir, 'ending.ydoc')))
  fs.mkdirSync(path.join(dataDir, 'blobs', 'ending'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'blobs', 'ending', 'a'.repeat(32)), 'x')

  const ended = new Promise((resolve) => owner.on('fatal', resolve))
  await owner.adminRequest({ op: 'end' })
  const err = await ended
  assert.equal(err.ended, true)
  await waitFor(() => !srv.rooms.has('ending'))
  assert.equal(fs.existsSync(path.join(dataDir, 'ending.ydoc')), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'ending.json')), false)
  await waitFor(() => !fs.existsSync(path.join(dataDir, 'blobs', 'ending')))
})

test('only the owner can end a session', async (t) => {
  const defer = cleanups(t)
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir: tmp('end2') })
  defer(() => srv.close())
  const c = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'open-room', secret: 's', name: 'eve', identity: generateIdentity(), doc: new Y.Doc() })
  defer(() => c.close())
  await c.waitForSync()
  await assert.rejects(c.adminRequest({ op: 'end' }), /only the session owner/)
})

test('stored files go with their room when it expires, and unreferenced ones when it unloads', async (t) => {
  const defer = cleanups(t)
  const dataDir = tmp('gc')
  fs.writeFileSync(path.join(dataDir, 'old.json'), JSON.stringify({ secretHash: 'ab', lastActive: Date.now() - 40 * 86400e3 }))
  fs.mkdirSync(path.join(dataDir, 'blobs', 'old'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'blobs', 'old', 'a'.repeat(32)), 'x')
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: quiet, dataDir, roomTtlDays: 30, idleUnloadMs: 50 })
  defer(() => srv.close())
  await waitFor(() => !fs.existsSync(path.join(dataDir, 'blobs', 'old')))

  // A room that stored two files but only references one of them now.
  const doc = new Y.Doc()
  const c = new Connection({ server: `ws://127.0.0.1:${srv.port}`, room: 'gc', secret: 's', name: 'gil', identity: generateIdentity(), doc })
  defer(() => { if (!c.closed) c.close() })
  await c.waitForSync()
  const keep = 'a'.repeat(32)
  const drop = 'b'.repeat(32)
  const room = srv.rooms.get('gc')
  const old = Date.now() - 2 * 60 * 60 * 1000
  room.meta.blobs = { [keep]: { size: 1, ts: old }, [drop]: { size: 1, ts: old } }
  for (const id of [keep, drop]) { fs.mkdirSync(path.join(dataDir, 'blobs', 'gc'), { recursive: true }); fs.writeFileSync(path.join(dataDir, 'blobs', 'gc', id), 'x') }
  doc.getMap('blobs').set('img.png', { hash: 'h', size: 1, stored: { id: keep, key: 'k1' } })
  await waitFor(() => room.doc.getMap('blobs').has('img.png'))
  c.close()
  await waitFor(() => !srv.rooms.has('gc'), 3000)
  await waitFor(() => !fs.existsSync(path.join(dataDir, 'blobs', 'gc', drop)))
  assert.equal(fs.existsSync(path.join(dataDir, 'blobs', 'gc', keep)), true)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/relay.test.js`
Expected: the three new tests FAIL ("unknown request", files still present).

- [ ] **Step 3: Close code**

In `src/protocol.js`, below `CLOSE_ROOM_FULL`, add:

```js
export const CLOSE_ENDED = 4410 // the owner ended the session and it was deleted
```

- [ ] **Step 4: Apps announce support, and hear when a session ends**

In `src/connection.js`, add `CLOSE_ENDED` to the import from `./protocol.js`. Change the constructor signature to take `features = 'large-files'`:

```js
  constructor ({ server, room, secret, key, viewSecret, kind = 'human', name, identity, doc, beforeRemote, features = 'large-files' }) {
```

After `if (viewSecret) q.set('viewSecret', viewSecret)`, add:

```js
    if (features) q.set('features', features)
```

In `ws.on('close', (code, reason) => {`, add a first branch:

```js
      if (code === CLOSE_ENDED) {
        this.emit('fatal', Object.assign(new Error(String(reason) || 'The owner ended this session'), { ended: true }))
        this.close()
      } else if (code === CLOSE_DENIED) {
```

(Replace the existing `if (code === CLOSE_DENIED) {` line with the `} else if` shown, so the chain stays intact.)

- [ ] **Step 5: The `end` request, and saving nothing after the end**

In `src/server.js`, add `CLOSE_ENDED` to the import from `./protocol.js`. In `Room.adminRequest`, directly after `if (!me || !me.owner) throw new Error('only the session owner can do that')`, add:

```js
    if (req.op === 'end') {
      // Reply first; the relay then sends everyone away and deletes the room.
      setTimeout(() => this.onEnd && this.onEnd(), 50)
      return { ok: true }
    }
```

At the top of `Room.save()` and of `Room.saveMeta()`, add `if (this.ended) return`.

Add a method to `Room` (next to `destroy`):

```js
  /** Stored-file ids the document still points at. */
  storedIds () {
    const ids = new Set()
    for (const b of this.blobs.values()) if (b && b.stored && b.stored.id) ids.add(b.stored.id)
    return ids
  }
```

- [ ] **Step 6: Delete a room's data in one place, and use it everywhere**

In `startServer`, after the `store` lines added in Task 3, add:

```js
  /** Deletes everything a room left on the relay and in storage. */
  const removeRoomData = (name) => {
    if (dataDir) {
      fs.rmSync(path.join(dataDir, `${name}.ydoc`), { force: true })
      fs.rmSync(path.join(dataDir, `${name}.json`), { force: true })
    }
    fs.rmSync(path.join(filesDir, name), { recursive: true, force: true })
    store.removeRoom(name).catch((err) => log(`[${name}] could not delete stored files: ${err.message}`))
  }
  /** Deletes stored files nothing points at any more (an hour's grace for uploads in flight). */
  const collectStored = (room) => {
    const blobs = room.meta.blobs || {}
    const used = room.storedIds()
    const cutoff = Date.now() - 60 * 60 * 1000
    const unused = Object.keys(blobs).filter((id) => !used.has(id) && (blobs[id].ts || 0) < cutoff)
    if (!unused.length) return
    for (const id of unused) delete blobs[id]
    room.saveMeta()
    store.remove(room.name, unused).catch((err) => log(`[${room.name}] could not delete stored files: ${err.message}`))
  }
```

In `getRoom`, inside `room.unloadTimer = setTimeout(() => {`, add `collectStored(room)` directly before `room.destroy()`. Below the `room.onEmpty = ...` block, add:

```js
      room.onEnd = () => {
        room.ended = true
        for (const ws of [...room.conns.keys(), ...room.pending.keys()]) ws.close(CLOSE_ENDED, 'The owner ended this session')
        clearTimeout(room.unloadTimer)
        room.guard.destroy(); room.awareness.destroy(); room.doc.destroy()
        rooms.delete(name)
        removeRoomData(name)
        log(`[${name}] ended by its owner`)
      }
```

In `sweep`, replace the three `fs.rmSync(...)` lines inside the loop with `removeRoomData(name)`.

`collectStored` needs the files the document points at, so the unload timer must run it before `room.destroy()` (it does, per the step above).

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: PASS, including the three new relay tests and Task 3's "turned away" test.

- [ ] **Step 8: Commit**

```bash
git add src/protocol.js src/connection.js src/server.js test/relay.test.js
git commit -m "Relay: end sessions, and delete stored files when they're no longer needed"
```

---

### Task 5: The app stores large files encrypted

**Files:**
- Modify: `src/pathrules.js:5-6`, `src/fsutil.js:7`
- Modify: `src/session.js` (constructor, `goLive`, `readDisk`, `ingest`, `writeOut`, `rejectLocal`, `reclaim`, `readShared`, plus new methods)
- Test: `test/large-files-sync.test.js`

**Interfaces:**
- Consumes: Task 1's functions, Task 3's endpoints, and Task 4's `features` default.
- Produces:
  - A `blobs` entry for a large file: `{ hash: string, size: number, stored: { id: string, key: string } }`, with no `data`.
  - A `fileKeys` map in the document: `keyId -> { wraps: string[], ts: number }`.
  - `Session` methods: `currentFileKey()`, `fileKeysICanOpen(): Map<string, Buffer>`, `shareKeysWithViewers()`, `uploadLarge(rel, disk)`, `downloadLarge(rel, entry)`, `blobRequest(id, action, body)`, `endForEveryone()`.

- [ ] **Step 1: Write the failing test**

Create `test/large-files-sync.test.js`:

```js
// Big binary files travel encrypted through storage, not inside the session document.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'

let srv, server, dataDir
const sessions = []
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-lf-${n}-`))
const bytes = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel)) } catch { return null } }
async function waitFor (fn, ms = 8000) {
  const start = Date.now()
  let last
  while (Date.now() - start < ms) {
    try { last = await fn(); if (last) return last } catch (err) { last = err }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out; last value: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}
async function open (dir, name, extra) {
  const s = new Session({ dir, server, secret: 'edit', name, identity: generateIdentity(), ...extra })
  sessions.push(s)
  await s.start({ waitTimeoutMs: 5000 })
  return s
}
let n = 0
const big = () => crypto.randomBytes(300 * 1024)

before(async () => {
  dataDir = tmp('relay')
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: () => {} })
  server = `ws://127.0.0.1:${srv.port}`
})
after(async () => {
  for (const s of sessions) await s.stop().catch(() => {})
  await srv.close()
})

test('a large file reaches the other app, stored encrypted and not in the document', async () => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const img = big()
  fs.writeFileSync(path.join(dirA, 'photo.png'), img)
  const A = await open(dirA, 'alice', { room })
  const B = await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'photo.png')?.equals(img))

  const entry = A.blobs.get('photo.png')
  assert.ok(entry.stored && entry.stored.id, 'stored, not inline')
  assert.equal(entry.data, undefined)
  assert.equal(entry.size, img.length)
  const onRelay = fs.readFileSync(path.join(dataDir, 'blobs', room, entry.stored.id))
  assert.ok(!onRelay.includes(img.subarray(5000, 5064)), 'the relay only has ciphertext')
  await waitFor(() => fs.existsSync(path.join(dataDir, `${room}.ydoc`)))
  assert.ok(fs.statSync(path.join(dataDir, `${room}.ydoc`)).size < 64 * 1024, 'the document stays small')

  const next = big()
  fs.writeFileSync(path.join(dirB, 'photo.png'), next)
  await waitFor(() => bytes(dirA, 'photo.png')?.equals(next))
  fs.rmSync(path.join(dirA, 'photo.png'))
  await waitFor(() => bytes(dirB, 'photo.png') === null)
  assert.equal(B.readShared('photo.png'), null)
})

test('small binary files and text still travel inside the document', async () => {
  const room = `lf-${++n}`
  const dirA = tmp('a'); const dirB = tmp('b')
  const icon = crypto.randomBytes(4 * 1024)
  fs.writeFileSync(path.join(dirA, 'icon.png'), icon)
  fs.writeFileSync(path.join(dirA, 'big.txt'), 'x'.repeat(400 * 1024))
  const A = await open(dirA, 'alice', { room })
  await open(dirB, 'bob', { room })
  await waitFor(() => bytes(dirB, 'icon.png')?.equals(icon))
  await waitFor(() => bytes(dirB, 'big.txt')?.length === 400 * 1024)
  assert.ok(A.blobs.get('icon.png').data, 'small files stay inline')
  assert.ok(A.files.get('big.txt'), 'text stays text')
})

test('people who can only view can open large files', async () => {
  const room = `lf-${++n}`
  const ownerDir = tmp('owner')
  const img = big()
  fs.writeFileSync(path.join(ownerDir, 'hero.jpg'), img)
  const owner = await open(ownerDir, 'olive', { room, viewSecret: 'view' })
  await waitFor(() => owner.access && owner.access.owner)
  await waitFor(() => owner.blobs.get('hero.jpg')?.stored)
  const viewerDir = tmp('viewer')
  const viewer = await open(viewerDir, 'vic', { room, secret: 'view' })
  const req = await waitFor(() => owner.waiting.find((p) => p.name === 'vic'))
  await owner.approve(req.key, { role: 'viewer' })
  await waitFor(() => viewer.access && viewer.access.state === 'approved')
  await waitFor(() => bytes(viewerDir, 'hero.jpg')?.equals(img))
})

test('an owner can end the session for everyone', async () => {
  const room = `lf-${++n}`
  const ownerDir = tmp('owner')
  fs.writeFileSync(path.join(ownerDir, 'a.bin'), big())
  const owner = await open(ownerDir, 'olive', { room, viewSecret: 'view' })
  await waitFor(() => owner.blobs.get('a.bin')?.stored)
  const fatal = new Promise((resolve) => owner.on('fatal', resolve))
  await owner.endForEveryone()
  assert.equal((await fatal).ended, true)
  await waitFor(() => !fs.existsSync(path.join(dataDir, 'blobs', room)))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/large-files-sync.test.js`
Expected: FAIL. `entry.stored` is undefined, because files are still inline, and `endForEveryone` is not a function.

- [ ] **Step 3: Size limits**

In `src/pathrules.js`, below `MAX_BINARY_BYTES`, add:

```js
// Binary files this big or bigger are stored encrypted outside the session document.
export const LARGE_FILE_BYTES = 256 * 1024
// The most a stored file may be (the relay may allow less).
export const MAX_STORED_BINARY_BYTES = 100 * 1024 * 1024
```

In `src/fsutil.js` line 7, add `LARGE_FILE_BYTES, MAX_STORED_BINARY_BYTES` to the re-export list.

- [ ] **Step 4: Session state and imports**

In `src/session.js`, add `LARGE_FILE_BYTES, MAX_STORED_BINARY_BYTES` to the import from `./fsutil.js`, and add:

```js
import { deriveWrapKey, newFileKey, wrapKey, unwrapKey, encryptBlob, decryptBlob, blobId } from './largefiles.js'
```

In the constructor, after `this.blobs = ...`, add:

```js
    // keyId -> { wraps, ts }: file keys for large files, each wrapped for editors and viewers.
    this.fileKeys = this.doc.getMap('fileKeys')
    this.uploading = new Map() // path -> hash being uploaded
    this.downloading = new Map() // path -> hash being downloaded
    this.largeFilesOff = false // the relay has no file storage (an older relay)
```

Change the `blobs` comment to `// path -> { hash, data(base64) } or { hash, size, stored: { id, key } }`.

- [ ] **Step 5: File keys**

Add these methods to `Session` (in a new `// ------------------------------------------------------- large files --` section, after `lastEditorOf`):

```js
  wrapKeys () {
    const keys = [deriveWrapKey(this.secret, this.room)]
    if (this.viewSecret) keys.push(deriveWrapKey(this.viewSecret, this.room))
    return keys
  }

  /** The file keys this app can open: keyId -> key. */
  fileKeysICanOpen () {
    const mine = this.wrapKeys()
    const out = new Map()
    for (const [id, entry] of this.fileKeys) {
      for (const w of (entry && entry.wraps) || []) {
        const key = mine.map((wk) => unwrapKey(w, wk)).find(Boolean)
        if (key) { out.set(id, key); break }
      }
    }
    return out
  }

  /** The key for new uploads: the first one we can open, or a new one. */
  currentFileKey () {
    const open = this.fileKeysICanOpen()
    if (open.size) {
      const id = [...open.keys()].sort()[0]
      return { id, key: open.get(id) }
    }
    const key = newFileKey()
    const id = crypto.randomBytes(4).toString('hex')
    const wraps = this.wrapKeys().map((wk) => wrapKey(key, wk))
    this.doc.transact(() => this.fileKeys.set(id, { wraps, ts: Date.now() }), LOCAL)
    return { id, key }
  }

  /** The owner (the only one with the view secret) makes every key open for viewers too. */
  shareKeysWithViewers () {
    if (!this.viewSecret) return
    const vk = deriveWrapKey(this.viewSecret, this.room)
    for (const [id, key] of this.fileKeysICanOpen()) {
      const entry = this.fileKeys.get(id)
      if (entry.wraps.some((w) => unwrapKey(w, vk))) continue
      this.doc.transact(() => this.fileKeys.set(id, { ...entry, wraps: [...entry.wraps, wrapKey(key, vk)] }), LOCAL)
    }
  }
```

- [ ] **Step 6: Upload and download**

Add these to the same section:

```js
  async blobRequest (id, action, body = {}) {
    const res = await fetch(`${this.httpBase()}/blobs/${encodeURIComponent(this.room)}/${id}/${action}`, {
      method: 'POST',
      headers: { 'x-quilt-secret': this.secret, 'content-type': 'application/json', ...(this.key ? { 'x-quilt-key': this.key } : {}) },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw Object.assign(new Error(await res.text()), { status: res.status })
    return res.json()
  }

  /** Encrypts and uploads a large file, then points the shared document at it. */
  async uploadLarge (rel, disk) {
    if (this.uploading.get(rel) === disk.hash) return
    this.uploading.set(rel, disk.hash)
    try {
      const { id: keyId, key } = this.currentFileKey()
      const id = blobId(key, disk.hash)
      const target = await this.blobRequest(id, 'upload', { size: disk.buf.length })
      const res = await fetch(new URL(target.url, this.httpBase() + '/'), {
        method: target.method || 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: encryptBlob(disk.buf, key)
      })
      if (!res.ok) throw new Error(`upload failed (HTTP ${res.status})`)
      const now = this.readDisk(rel)
      if (!now || now.key !== disk.key) return // it changed again; that change is already queued
      const existed = this.files.has(rel) || this.blobs.has(rel)
      this.doc.transact(() => {
        this.files.delete(rel)
        this.blobs.set(rel, { hash: disk.hash, size: disk.buf.length, stored: { id, key: keyId } })
        this.recordActivity(rel, existed ? 'edited' : 'created', `${disk.buf.length} bytes`)
      }, LOCAL)
      this.lastKnown.set(rel, disk.key)
      this.noteMyEdit(rel)
    } catch (err) {
      if (err.status === 404) {
        // An older relay without file storage: share it inside the document if it fits.
        this.largeFilesOff = true
        this.queue(rel)
      } else {
        this.log(`could not upload ${rel}: ${err.message}`)
      }
    } finally {
      if (this.uploading.get(rel) === disk.hash) this.uploading.delete(rel)
    }
  }

  /** Downloads and decrypts a large file, then writes it into the folder. */
  async downloadLarge (rel, entry) {
    if (this.downloading.get(rel) === entry.hash) return
    this.downloading.set(rel, entry.hash)
    try {
      const key = this.fileKeysICanOpen().get(entry.stored.key)
      if (!key) return // its key hasn't arrived yet; the fileKeys observer retries
      const { url } = await this.blobRequest(entry.stored.id, 'download')
      const res = await fetch(new URL(url, this.httpBase() + '/'))
      if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`)
      const buf = decryptBlob(Buffer.from(await res.arrayBuffer()), key)
      if (sha1(buf) !== entry.hash) throw new Error('the downloaded file did not match')
      const cur = this.blobs.get(rel)
      if (!cur || cur.hash !== entry.hash) return // replaced meanwhile; that version is on its way
      const abs = resolveInside(this.root, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, buf)
      this.lastKnown.set(rel, `bin:${entry.hash}`)
      if (this.ready) this.emit('file-changed', { path: rel, by: this.lastEditorOf(rel) || 'partner' })
    } catch (err) {
      this.log(`could not download ${rel}: ${err.message}`)
    } finally {
      if (this.downloading.get(rel) === entry.hash) this.downloading.delete(rel)
    }
  }

  /** Owner only: deletes the session from the relay and sends everyone away. */
  endForEveryone () { return this.conn.adminRequest({ op: 'end' }) }
```

- [ ] **Step 7: Wire them into reading, ingesting and writing files**

1. `readDisk`: replace `if (st.size > MAX_BINARY_BYTES) return { tooLarge: true }` with:

```js
    if (st.size > MAX_STORED_BINARY_BYTES) return { tooLarge: true }
```

and change the binary branch to:

```js
    if (looksBinary(buf)) {
      if (buf.length > MAX_BINARY_BYTES && this.largeFilesOff) return { tooLarge: true }
      const hash = sha1(buf)
      return { binary: true, buf, hash, key: `bin:${hash}` }
    }
```

2. `ingest`: directly after `if (!this.syncable(rel)) return false`, add:

```js
    if (this.downloading.has(rel)) return false // our copy is being replaced by a download
```

Directly after `if (disk.key === this.sharedKey(rel)) { this.lastKnown.set(rel, disk.key); return false }`, add:

```js
    if (disk.binary && disk.buf.length >= LARGE_FILE_BYTES && !this.largeFilesOff) {
      this.uploadLarge(rel, disk)
      return false
    }
```

3. `writeOut`: replace the block

```js
    } else {
      if (!disk || disk.key !== shared) {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        const t = this.files.get(rel)
        fs.writeFileSync(abs, t ? t.toString() : Buffer.from(this.blobs.get(rel).data, 'base64'))
      }
      this.lastKnown.set(rel, shared)
    }
```

with:

```js
    } else {
      const b = this.blobs.get(rel)
      if (b && b.stored) {
        // Written once it's downloaded; downloadLarge sets lastKnown and says who changed it.
        if (!disk || disk.key !== shared) { this.downloadLarge(rel, b); return }
      } else if (!disk || disk.key !== shared) {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        const t = this.files.get(rel)
        fs.writeFileSync(abs, t ? t.toString() : Buffer.from(b.data, 'base64'))
      }
      this.lastKnown.set(rel, shared)
    }
```

4. `rejectLocal`: replace

```js
    if (t || b) {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, t ? t.toString() : Buffer.from(b.data, 'base64'))
      this.lastKnown.set(rel, this.sharedKey(rel))
    } else {
```

with:

```js
    if (b && b.stored) {
      this.downloadLarge(rel, b)
    } else if (t || b) {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, t ? t.toString() : Buffer.from(b.data, 'base64'))
      this.lastKnown.set(rel, this.sharedKey(rel))
    } else {
```

5. `reclaim`: change the condition `if ((t || b) && this.sharedKey(rel) !== this.lastKnown.get(rel)) {` to `if ((t || (b && !b.stored)) && this.sharedKey(rel) !== this.lastKnown.get(rel)) {`. A partner's stored version stays in storage until it's collected, so there's nothing to copy aside.

6. `readShared`: replace the `if (b) return { ... }` line with:

```js
    if (b) return { path: rel, binary: true, size: b.size ?? (Math.floor(b.data.length * 3 / 4) - (b.data.endsWith('==') ? 2 : b.data.endsWith('=') ? 1 : 0)) }
```

7. `goLive`: after the `this.blobs.observe(...)` block, add:

```js
    this.fileKeys.observe(() => {
      this.shareKeysWithViewers()
      // Files whose key just arrived can be downloaded now.
      for (const [rel, b] of this.blobs) if (b && b.stored && this.lastKnown.get(rel) !== `bin:${b.hash}`) this.writeOut(rel)
    })
    this.shareKeysWithViewers()
```

- [ ] **Step 8: Run the tests**

Run: `node --test test/large-files-sync.test.js && npm test`
Expected: PASS, and the whole suite still passes.

- [ ] **Step 9: Commit**

```bash
git add src/pathrules.js src/fsutil.js src/session.js test/large-files-sync.test.js
git commit -m "Store large files encrypted outside the session document"
```

---

### Task 6: "End session for everyone" in the app

**Files:**
- Modify: `src/ui-server.js:292-295` (routes)
- Modify: `src/ui/session.js` (`membersHtml`, and the people-menu click handler that handles `data-remove`)
- Test: `test/ui.test.js` (append)

**Interfaces:**
- Consumes: `Session.endForEveryone()` (Task 5).
- Produces: `POST /api/sessions/:id/end`. It returns `{ ok: true }` and stops the local session.

- [ ] **Step 1: Write the failing test**

Append to `test/ui.test.js`. It uses that file's `api`, `home` and `ui` helpers; sessions made with `mode: 'create'` are owned, because `newConn` in `src/runner.js` gives them a view secret:

```js
test('the owner can end a session for everyone from the app', async () => {
  const dir = path.join(home, 'ending')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'bye')
  const created = await api('POST', '/api/sessions', { mode: 'create', dir, name: 'olive', tool: 'Claude Code', hostRelay: true })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const id = created.body.id
  const r = await api('POST', `/api/sessions/${id}/end`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body, { ok: true })
  const state = await api('GET', '/api/state')
  assert.equal(state.body.sessions.filter((s) => s.id === id).length, 0, 'stopped locally')
})
```

If `created.body.status.access` isn't `owner` yet when `/end` runs, the relay answers "only the session owner can do that". In that case, poll `GET /api/state` until the session's `status.access.owner` is true before calling `/end`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/ui.test.js`
Expected: FAIL with 404 for `/end`.

- [ ] **Step 3: The route**

In `src/ui-server.js`, after the `members/remove` route, add:

```js
    'POST /api/sessions/:id/end': async (b, id) => { await get(id).endForEveryone(); await stop(id); return { ok: true } },
```

- [ ] **Step 4: The button**

In `src/ui/session.js`'s `membersHtml`, in the owner's branch (the `return` that starts with `` `<div class="pm-sep"></div><div class="pm-title">Who can get in</div> ``), add at the very end of that template, after the list:

```js
    <div class="pm-sep"></div>
    <button type="button" class="btn sm ghost danger" data-end-session>End session for everyone</button>
```

In the people menu's click handler (the one that handles `[data-remove]`, around line 336), add a branch:

```js
  if (e.target.closest('[data-end-session]')) {
    if (!confirm('End this session for everyone? Everyone is disconnected, and the session and its stored files are deleted from the relay. Your own folder is not touched.')) return
    try { await api('POST', `/api/sessions/${current}/end`); toast('Session ended') } catch (err) { toast(err.message) }
    return
  }
```

If `.btn.danger` has no style in `src/ui/app.css`, add `.btn.danger { color: var(--bad); }` next to the other `.btn` variants.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Check it in the app**

Start the `ui` preview (`.claude/launch.json` entry `ui`). Start a session you own, open the people menu, and confirm the button shows only for the owner. Click it, confirm, and check that the toast says "Session ended" and the session stops.

- [ ] **Step 7: Commit**

```bash
git add src/ui-server.js src/ui/session.js src/ui/app.css test/ui.test.js
git commit -m "App: let the owner end a session for everyone"
```

---

### Task 7: Supabase bucket, relay settings and docs

**Files:**
- Create: `supabase/migrations/20261001000000_session_files_bucket.sql`
- Create: `scripts/storage-smoke.mjs`
- Modify: `fly.toml` (`[env]`)
- Modify: `docs/hosting.md` (settings table, and a "Large files" section)

**Interfaces:**
- Consumes: `SupabaseStore` (Task 2) and the relay endpoints (Task 3).
- Produces: the private bucket `session-files` in project `pwebomewzuezaxoowykk`, and the relay configured to use it.

- [ ] **Step 1: The bucket migration**

Create `supabase/migrations/20261001000000_session_files_bucket.sql`:

```sql
-- Encrypted large files from Quilt sessions. Private: only the relay (with its
-- secret key) signs upload and download links, so no policies are needed.
insert into storage.buckets (id, name, public, file_size_limit)
values ('session-files', 'session-files', false, 104857600)
on conflict (id) do nothing;
```

Apply it with the Supabase MCP `apply_migration` tool (project `pwebomewzuezaxoowykk`, name `session_files_bucket`). Check it: `select id, public, file_size_limit from storage.buckets where id = 'session-files';` should return one row with `public = false`.

- [ ] **Step 2: The smoke script**

Create `scripts/storage-smoke.mjs`:

```js
// Checks the relay's Supabase storage end to end: sign an upload, PUT, sign a
// download, GET, compare, delete.
// Usage: QUILT_STORAGE_URL=https://<ref>.supabase.co QUILT_STORAGE_KEY=sb_secret_… node scripts/storage-smoke.mjs
import crypto from 'node:crypto'
import { SupabaseStore } from '../src/blobstore.js'

const store = new SupabaseStore({ url: process.env.QUILT_STORAGE_URL, key: process.env.QUILT_STORAGE_KEY, bucket: process.env.QUILT_STORAGE_BUCKET || 'session-files' })
const room = `smoke-${Date.now()}`
const id = crypto.randomBytes(16).toString('hex')
const body = crypto.randomBytes(300 * 1024)

const up = await store.uploadTarget(room, id)
const put = await fetch(up.url, { method: up.method, headers: { 'content-type': 'application/octet-stream' }, body })
if (!put.ok) throw new Error(`upload failed: ${put.status} ${await put.text()}`)
console.log('ok uploaded')
const down = await store.downloadTarget(room, id)
const got = Buffer.from(await (await fetch(down.url)).arrayBuffer())
if (!got.equals(body)) throw new Error('downloaded bytes differ')
console.log('ok downloaded the same bytes')
await store.removeRoom(room)
const { data: left, error } = await store.bucket.list(room)
if (error) throw new Error(`list failed: ${error.message}`)
if (left.length) throw new Error('files still there after removeRoom')
console.log('ok deleted')
```

- [ ] **Step 3: The secret key (the user does this)**

Ask the user to create a new secret API key named `quilt-relay` in the Supabase dashboard (Project Settings, then API Keys), copy it, and run:

```bash
pbpaste | sed 's/^/QUILT_STORAGE_KEY=/' | fly secrets import -a cowove-relay --stage
```

`--stage` saves the secret without restarting the relay; the deploy in Step 6 picks it up. Never ask them to paste the key into chat.

Then run the smoke script with the same key in their terminal: `QUILT_STORAGE_URL=https://pwebomewzuezaxoowykk.supabase.co QUILT_STORAGE_KEY=<key> node scripts/storage-smoke.mjs`. It should print all three `ok` lines.

- [ ] **Step 4: Relay settings**

In `fly.toml`, add to `[env]`:

```toml
  QUILT_STORAGE_URL = "https://pwebomewzuezaxoowykk.supabase.co"
  # Supabase's free plan caps uploads at 50 MB per file; raise this on a paid plan.
  QUILT_MAX_STORED_FILE_MB = "50"
```

- [ ] **Step 5: Docs**

In `docs/hosting.md`, add these rows to the settings table (after `QUILT_TRUST_PROXY`):

```markdown
| `QUILT_STORAGE_URL` | none | A Supabase project URL. With `QUILT_STORAGE_KEY`, large files go to Supabase Storage instead of the relay's disk. |
| `QUILT_STORAGE_KEY` | none | A Supabase secret key for that project. Set it as a secret, never in `fly.toml`. |
| `QUILT_STORAGE_BUCKET` | `session-files` | The private bucket to use (see `supabase/migrations/20261001000000_session_files_bucket.sql`). |
| `QUILT_MAX_STORED_FILE_MB` | `100` | The largest file people can share this way. |
```

Add a section after "Checking on it":

```markdown
## Large files

Binary files of 256 KB or more (images, builds, archives) don't travel inside
the session. Each person's Quilt encrypts them with a key only the session's
members have, and uploads them to storage: Supabase Storage when
`QUILT_STORAGE_URL` and `QUILT_STORAGE_KEY` are set, otherwise the relay's own
disk. Whoever runs the storage can't read them. They're deleted when the owner
ends the session, when the session is deleted after `QUILT_ROOM_TTL_DAYS`, and
when a file is replaced or removed (an hour later, once the session is idle).
```

- [ ] **Step 6: Deploy and check**

Run `npm test`. Then run `fly deploy --remote-only` from the repo root (deploying the relay is Claude's job). Then:

1. `curl -s https://cowove-relay.fly.dev/healthz` should return `{"ok":true,...}`.
2. In two local apps (or two `quilt` sessions in temporary folders) pointed at the hosted relay, share a folder containing a 1 MB image. The image should arrive in the second folder, and the Supabase `session-files` bucket should hold one object under the room's name. Opening it in the dashboard should show binary noise, not an image.
3. End the session from the owner's app, and check that the room's folder in the bucket is empty.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20261001000000_session_files_bucket.sql scripts/storage-smoke.mjs fly.toml docs/hosting.md
git commit -m "Use Supabase Storage for encrypted large files on the hosted relay"
git push origin main
```

---

## Self-Review Notes

- **Spec coverage:**
  - Encrypted storage: Tasks 1 and 5.
  - Supabase with a disk fallback: Tasks 2 and 7.
  - Direct upload and download that skip the relay machine: Tasks 3 and 5 (for Supabase-signed links).
  - Viewers can open files: Task 5, test 3.
  - Old apps turned away: Tasks 3 and 4.
  - Cleanup on end, expiry and replacement: Tasks 4 and 6.
  - Docs and deploy: Task 7.
- **Known limits:**
  - A local edit made while that file is downloading is dropped in favour of the download.
  - Stored files are whole-file, last write wins, the same as today's binary files.
  - Code and small files are unchanged, and still travel unencrypted through the relay.
- **Follow-ups, not in this plan:**
  - Per-file documents, so the relay doesn't hold all code in memory.
  - Keeping the raw session secret away from the relay.
  - Showing upload and download progress in the app.
