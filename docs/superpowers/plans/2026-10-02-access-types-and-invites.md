# Access Types and Invites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People define reusable access types and invite anyone, person or agent, to a session as one; the owner can narrow one person's access in a session but never widen it past their type; the relay enforces it all, including for hosted agents on `/mcp`; and the owner invites people they've worked with, or anyone by email, who get in automatically once they sign in.

**Architecture:** One pure module, `src/session-access.js`, holds the maths (built-in types, checking fields, what a grant comes to, narrowing) and is shared by the accounts API, the relay and the app. The API stores access types, grants and session invites (a new migration), works out each person's access, and signs it into **room passes** (`POST /v1/passes { room }`); it also sends invite emails and turns an email invite into a grant on the invitee's first room pass. The relay admits people by their room pass's grant, enforces view, folders, folder exceptions and "no posting" with its UndoManager guard (and on the hosted `/mcp` tools), lets the owner narrow access live, and asks an app to fetch a fresh pass when its access changes. The app asks for passes for its own room, offers access types in the approve control, the people menu and the invite panel, and disables posting when it may not post. The website gets a Dashboard page to manage access types.

**Tech Stack:** Node 22 (`node:test`), `ws`, Yjs (`Y.UndoManager`), plain-DOM app in `src/ui/`, Postgres (Supabase migration, plpgsql functions), `@supabase/supabase-js`, nodemailer (Resend SMTP), Next.js 16 app router in `web/`, Fly.io (relay `cowove-relay` at `relay.heyquilt.com`, API `quilt-api` at `api.heyquilt.com`), Netlify (`heyquilt.com`).

**Spec:** `docs/superpowers/specs/2026-10-02-access-types-and-invites-design.md`. Read it before starting; this plan argues from it. It builds on `2026-10-01-required-sign-in-design.md` (passes, `kind:sub` identity, owner approval) and `2026-10-01-session-activity-dashboard-design.md` (`relay_sessions.owner_account`, `GET /v1/me/collaborators`), both already on `main`, as are cloud agents (the relay's `/mcp` and the API's `/mcp` proxy).

**Verified:** every task below was carried out in a scratch clone of `access-invites` at `32afc0f` (equal to `main`), one commit per task, and after each commit both `npm test` and `cd web && npm test` passed. Each task's new tests were also run against the code before that task, and failed as Step 2 says. The migration was applied to a local Postgres 16 on top of the session-activity migration, and its three functions were exercised there. The app's screens were checked by hand in a browser against a local API and relay (approve as a type, the Access section, the invite panel). Code that changes existing files is given as unified diffs against the branch as each task finds it: apply them by hand, or save one to a file and `git apply` it.

## Global Constraints

- Code style: StandardJS (no semicolons, 2-space indent, single quotes, a space before function parens), ES modules, matching the files around it. The website uses JSX in the same style.
- Run `npm test` from the repo root after every task; every test must pass before committing. Tasks that touch `web/` also run `cd web && npm test`.
- Tests never touch the network or production: a local API (`startTestApi`, a memory store), a local relay (`startServer` on port 0), stand-in Supabase clients and mailers, test pass keys (`test/pass-helpers.js`).
- An **access type** belongs to an account (`owner_account`, `person:<id>`) and has `id`, `name` (1 to 40 characters), `files` (`'edit' | 'view'`), `folders` (at most 20 relative folder prefixes, the same normalisation as agent scopes; empty means all), `talk` (may post to chat and the feed), `created_at`, `updated_at`.
- Built-in types, on every account, fixed ids, never edited or deleted: `builtin:edit` "Can edit" (edit, all folders, talk) and `builtin:view` "View only" (view, talk).
- At most **50** types per account. Deleting a type moves the grants that used it to `builtin:view`.
- A **grant**: `session_grants (room, account 'kind:sub', type_id, tighten jsonb, granted_by, created_at, updated_at)`, unique on `(room, account)`. `tighten` is `{ files?: 'view', foldersRemove?: [prefix], talk?: false }` and never widens.
- **Effective access**: `files` is `view` if either the type or the tightening says so; `folders` is the type's folders minus the removed ones; removing from "all folders" is kept as `foldersExcept`; `talk` is the type's and not tightened.
- The session's **owner** (`relay_sessions.owner_account`) has full access, never has a grant, and is the only one who may set grants or invite.
- API (user auth: website JWT or the app's `qd_` token): `GET|POST /v1/access-types`, `PUT|DELETE /v1/access-types/:id`, `GET /v1/sessions/:room/grants`, `PUT|DELETE /v1/sessions/:room/grants/:account` (`{ typeId, tighten? }`), `POST|GET /v1/sessions/:room/invites` (`{ typeId, to: { email } | { account }, link }`), `DELETE /v1/sessions/:room/invites/:id`.
- `POST /v1/passes` takes an optional `{ room }`. A room pass carries `room`, `access` (the effective grant; `null` with no grant; for the owner `{ owner: true, ... }`) and `email` (the person's confirmed email; absent for agents). Without `room`, a pass is as before.
- Access changes reach a connection within the 5-minute pass refresh, or at once when the owner changes it from the app.
- Relay: the owner is unchanged; a room pass with a grant is let in at once with that access; no grant waits for the owner as today; the owner's `approve` carries `{ typeId }`; `set` is accepted only from the owner and only narrows what the connection's pass allows; members approved before this change keep working, and a pass with a grant wins over their stored role.
- `talk: false`: the relay undoes chat and feed additions and sends the access message `you can't post in this session`; it refuses chat-file uploads (`POST /files`). The app shows chat inputs disabled with `You can't post in this session.`
- Hosted agents get the same: their grant, role, folders and talk permission are enforced on the relay's `/mcp` tools.
- Session invites: `session_invites (id, room, email?, account?, type_id, invited_by, created_at, expires_at = +7 days, used_at, cancelled_at)`; email from `Quilt <hello@hq.heyquilt.com>`, subject `<inviter name> invited you to <session name> on Quilt`, a body with who invited them, the session name, the join link, `This invite expires in 7 days.`, and a line for people new to Quilt; no email for agents; a collaborator's email is never returned; the link (it holds the room secret) is never stored.
- Auto let-in: a room pass for a person whose confirmed email matches an open email invite to that room turns that grant into theirs and marks the invite used.
- The migration goes in `supabase/migrations/` with RLS on, no client policies and no client grants, like the session-activity migration.
- The relay keeps working for apps older than this release (see "Older apps" in the Deploy section).
- No em dashes in user-facing text (`web/test/no-em-dash.test.js` scans the website; Task 14 adds a scan of the app).
- The desktop release with these changes is **0.3.4**.

## Decisions made in this plan

The spec was written before session activity and cloud agents landed; `main` has moved, and these adapt the spec to it or settle what it leaves open:

1. **One shared module.** `src/session-access.js` is pure and used by the API, the relay and the app. Access travels in the spec's shape (`files`, `folders`, `foldersExcept`, `talk`); the relay keeps members in its existing shape (`role`, `scopes`) plus `scopesExcept` and `talk`, and converts with `relayAccess` and `fromRelay`.
2. **Type ids are text.** Built-ins live in code, so `session_grants.type_id` and `session_invites.type_id` are text, not foreign keys. Grants and invites reference `relay_sessions (room) on delete cascade`, so they go with their session (account deletion and the 12-month prune already delete sessions).
3. **Folder maths.** Removing a folder a limited type doesn't list (for example `src/keys` from a `src` type) is kept as an exception too. Removing every folder a limited type has leaves nothing to change, so it becomes view only rather than "all folders".
4. **The owner in a pass.** The owner's room pass says `access: { owner: true, files: 'edit', folders: [], foldersExcept: [], talk: true }`. The relay keeps its own owner rule (creator key, then account) and never makes anyone owner from a pass.
5. **Passes carry `iat`.** A room pass says when it was issued. The relay remembers when the owner removed someone (`meta.removed`) and when it narrowed someone (`members[id].setAt`), so an older pass that is still valid can't bring a removed person back or undo a narrowing.
6. **`approve` carries the access too.** The relay doesn't know anyone's types, so the app's approve op carries `{ typeId, access }`. The app writes the grant first (as the spec says), then approves. If the API refuses (for example the session hasn't reached it yet), the person is still let in and the owner sees a warning; the relay's stored access holds until a pass brings a grant.
7. **"Asks the relay to reload" is a pass nudge.** After `approve` or `set`, the relay sends the person's connection `MSG_ACCESS` with `refresh: true`, and the app fetches a fresh pass at once (`Connection#refreshPass`). So narrowing applies at once, and widening applies as soon as that fresh pass arrives (the relay never widens from the owner's request alone).
8. **The API learns the owner within seconds.** Only the owner may set grants, and the API knows the owner from presence reports, which go every minute. The relay now reports the owner's visit at once (`presence.tick()`); until then the grant routes answer 404 `That session hasn't reached heyquilt.com yet. Try again in a minute.`
9. **Granted people are on the relay's member list.** Someone let in by a grant is kept in `meta.members` (with `granted: true`), so the owner (on any app version) sees and can remove them. A later pass with no grant leaves that entry alone; to take access away the owner removes them, and the app also deletes the grant.
10. **Hosted agents get room passes.** The API's `/mcp` proxy mints a pass for the room the agent is joining (read from the `quilt_join_session` call's invite in the request body), or else the room the relay last named in a new `x-quilt-room` response header. A minted pass is reused for at most 5 minutes (was 8), the same as a connected app's refresh. The relay's `hostedAccess` honours the grant, and the `/mcp` tools refuse posts (`quilt_message`, `quilt_share`) and changes in excepted folders.
11. **The guard undoes exactly the refused change.** Extending the UndoManager guard to `chat` and `agentFeed` showed an old flaw: two refused changes arriving in one network read undid only one (the guard's `undo()` took the newest stack item and then cleared the stack). The relay now takes each change's own stack item (`stack-item-added`) and undoes or forgets just that one.
12. **Invites.** Account invites are only for someone in the owner's `GET /v1/me/collaborators` (404 otherwise). One open invite per address or account (409). Cancelling deletes the grant the invite made unless another open invite needs it. An account invite is marked used when that account first gets a room pass; expiry matters for email invites (an account's grant stays until the owner cancels the invite or removes them).
13. **Which link goes in the email.** The app's server sends the session's view link for a view-only type (when the session has one) and the edit link otherwise; the access comes from the grant either way. The API only checks the link is this room's (`parseInvite`) and never stores it.
14. **Sender.** Mail messages may name their own `from`; session invites come from `Quilt <hello@hq.heyquilt.com>`, other mail still from `SMTP_FROM`.
15. **"Verified email"** is Supabase's confirmed email, compared lowercase; an unconfirmed address never claims an invite.
16. **Website.** The page is `/dashboard/access`, a personal tab named "Access types". Each type edits inline in a `<details>`; Delete asks in-page ("Delete it" / "Keep it"); folders are a textarea, one per line, placeholder "All folders".
17. **App.** The approve control's type picker replaces the role picker once the types load (the old picker stays if the API can't be reached). The people menu's Access section shows for members known by account; older members (known by key) keep the role picker. The approve bar no longer redraws under an open type picker (the app's dropdowns are buttons, which the old guard missed).
18. **Overlap with `issues/unlocks.md`.** Email invites plus `email` in room passes deliver the per-person half of "Quick let-in and auto let-in"; the email-domain rule stays an idea. "View-only guests don't get a local folder" is unaffected (view-only types use the same viewer role).

## File Structure

New files:

- `src/session-access.js`: built-in types, `cleanFolders`, `cleanTypeName`, `cleanTypeFields`, `cleanTighten`, `effectiveAccess`, `narrowAccess`, `cleanAccess`, `relayAccess`, `fromRelay`, `mayChange`, `changeRefusal`, `sameAccess`, `describeAccess`, constants. Shared by API, relay and app.
- `supabase/migrations/20261002010000_access_types_and_invites.sql`: `access_types`, `session_grants`, `session_invites`, and `delete_access_type`, `claim_email_invites`, `delete_account_access`.
- `src/api/access.js`: `ownType`, `typeOfGrant`, `grantView`, `roomAccess`, `OWNER_ACCESS`.
- `src/api/routes/access-types.js`, `src/api/routes/grants.js`, `src/api/routes/session-invites.js`.
- `web/app/dashboard/access/page.js`, `web/app/dashboard/access/actions.js`, `web/components/ConfirmDelete.js`, `web/lib/access-form.js`.
- Tests: `test/session-access.test.js`, `test/api-migration-access.test.js`, `test/api-store-access.test.js`, `test/api-supabase-access.test.js`, `test/api-access-types.test.js`, `test/api-grants.test.js`, `test/api-session-invites.test.js`, `test/api-room-passes.test.js`, `test/relay-grants.test.js`, `test/relay-talk.test.js`, `test/relay-owner-access.test.js`, `test/session-room-passes.test.js`, `test/ui-access.test.js`, `test/ui-access-screens.test.js`, `web/test/access-form.test.js`.

Modified files:

- `src/api/memory-store.js`, `src/api/supabase-store.js`: types, grants and invites; `deleteUser` removes them.
- `src/api/server.js`: the new routes, room passes (`mintPass`), the `/mcp` proxy's room passes (`joiningRoom`).
- `src/api/routes/sessions.js` (`overviewOf`, `collaboratorsOf`), `src/api/invite-email.js`, `src/api/mailer.js`.
- `src/passes.js` (a room pass names a valid room), `src/server.js` (admission, refresh, guard, owner ops, hosted access, `/files`), `src/relay-mcp.js`, `src/protocol.js` (comments).
- `src/pass-source.js`, `src/connection.js`, `src/session.js`: room passes, the refresh nudge, keeping to access.
- `src/account.js`, `src/ui-server.js`, `src/ui/common.js`, `src/ui/session.js`, `src/ui/app.js`, `src/ui/app.css`.
- `web/lib/nav.js`, `web/app/globals.css`, `web/test/nav.test.js`, `web/test/routes.test.js`.
- `test/pass-helpers.js`, `test/passes.test.js`, `test/relay-presence.test.js`, `test/relay-hosted-mcp.test.js`, `test/api-mcp.test.js`, `test/api-mailer.test.js`, `test/api-supabase-activity.test.js`.
- `RELEASES.md`, `package.json`, `package-lock.json`.

---

### Task 1: The shared access maths

Everything that decides access is a pure function, shared by the API (which works access out), the relay (which enforces it) and the app (which shows it). It comes first, with no I/O.

**Files:**
- Create: `src/session-access.js`
- Create: `test/session-access.test.js`

**Interfaces:**
- Consumes: `globMatcher` from `src/pathrules.js`.
- Produces (in `src/session-access.js`):
  - `BUILTIN_TYPES` (frozen: `{ id, name, files, folders, talk, builtin: true }` for `builtin:edit` and `builtin:view`), `builtinType(id)`, `DEFAULT_TYPE = 'builtin:edit'`, `FALLBACK_TYPE = 'builtin:view'`, `MAX_TYPES = 50`, `MAX_FOLDERS = 20`, `TYPE_NAME_MAX = 40`, `TALK_REFUSED = "You can't post in this session."`, `BAD_FOLDER`, `TOO_MANY_FOLDERS`.
  - `cleanFolders(input): string[]` (throws `Error(BAD_FOLDER | TOO_MANY_FOLDERS)`), `cleanTypeName(value): string`, `cleanTypeFields(body, { partial }): { name?, files?, folders?, talk? }` (throws `Error` with a plain message).
  - `cleanTighten(raw): { files?: 'view', foldersRemove?: string[], talk?: false }`.
  - `effectiveAccess(type, tighten): Access`, `narrowAccess(a: Access, b: Access): Access`, `cleanAccess(raw): Access | null`, where `Access = { files: 'edit'|'view', folders: string[], foldersExcept: string[], talk: boolean }`.
  - `relayAccess(Access): { role: 'editor'|'viewer', scopes, scopesExcept, talk }`, `fromRelay(member): Access`, `mayChange(relayAccess, rel): boolean`, `changeRefusal(relayAccess, rel): string | null`, `sameAccess(a, b): boolean`, `describeAccess(Access): string`.

- [ ] **Step 1: Write the failing test**

Create `test/session-access.test.js`:

```js
// Access types and grants: the built-ins, checking fields, and the maths of what a
// grant comes to and what an owner's live change may narrow it to.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_TYPES, builtinType, cleanFolders, cleanTypeFields, cleanTighten, effectiveAccess, narrowAccess,
  cleanAccess, relayAccess, fromRelay, mayChange, changeRefusal, sameAccess, describeAccess, BAD_FOLDER, TOO_MANY_FOLDERS
} from '../src/session-access.js'

const type = (files, folders = [], talk = true) => ({ files, folders, talk })

test('two built-in types, with fixed ids', () => {
  assert.deepEqual(BUILTIN_TYPES.map((t) => [t.id, t.name, t.files, t.folders, t.talk]), [
    ['builtin:edit', 'Can edit', 'edit', [], true],
    ['builtin:view', 'View only', 'view', [], true]
  ])
  assert.equal(builtinType('builtin:view').name, 'View only')
  assert.equal(builtinType('nope'), null)
  assert.throws(() => { BUILTIN_TYPES[0].name = 'x' }, TypeError)
})

test('folders are cleaned like agent scopes: at most 20, inside the project', () => {
  assert.deepEqual(cleanFolders([' ./src/ ', 'docs', 'src', '']), ['src', 'docs'])
  for (const bad of [['/etc'], ['../x'], ['a/../b'], ['C:/x'], ['a\\b'], [3], 'src']) assert.throws(() => cleanFolders(bad), { message: BAD_FOLDER }, JSON.stringify(bad))
  assert.throws(() => cleanFolders(Array.from({ length: 21 }, (_, i) => `f${i}`)), { message: TOO_MANY_FOLDERS })
  assert.deepEqual(cleanFolders(undefined), [])
})

test('a type needs a name of 1 to 40 characters, edit or view, and talk true or false', () => {
  assert.deepEqual(cleanTypeFields({ name: '  Reviewer ', files: 'view' }), { name: 'Reviewer', files: 'view', folders: [], talk: true })
  assert.deepEqual(cleanTypeFields({ name: 'Docs bot', files: 'edit', folders: ['docs/'], talk: false }), { name: 'Docs bot', files: 'edit', folders: ['docs'], talk: false })
  assert.throws(() => cleanTypeFields({ name: '', files: 'edit' }), /name of 1 to 40 characters/)
  assert.throws(() => cleanTypeFields({ name: 'x'.repeat(41), files: 'edit' }), /name of 1 to 40 characters/)
  assert.throws(() => cleanTypeFields({ name: 'x', files: 'admin' }), /files must be edit or view/)
  assert.throws(() => cleanTypeFields({ name: 'x', files: 'edit', talk: 'yes' }), /talk must be true or false/)
  assert.deepEqual(cleanTypeFields({ talk: false }, { partial: true }), { talk: false }, 'a change keeps what it did not send')
  const zeroWidth = String.fromCharCode(0x200b)
  assert.equal(cleanTypeFields({ name: `Re${zeroWidth}viewer`, files: 'view' }).name, 'Reviewer', 'nothing invisible')
})

test('tightening keeps only the three narrowing fields', () => {
  assert.deepEqual(cleanTighten({ files: 'view', foldersRemove: ['src/'], talk: false, files2: 'edit' }), { files: 'view', foldersRemove: ['src'], talk: false })
  assert.deepEqual(cleanTighten({ files: 'edit', talk: true }), {}, 'nothing here can widen')
  assert.deepEqual(cleanTighten(null), {})
})

test('effective access: view wins, removed folders go, and removing from all folders is kept as exceptions', () => {
  assert.deepEqual(effectiveAccess(type('edit')), { files: 'edit', folders: [], foldersExcept: [], talk: true })
  assert.deepEqual(effectiveAccess(type('edit'), { files: 'view' }).files, 'view')
  assert.deepEqual(effectiveAccess(type('view'), {}).files, 'view')
  assert.deepEqual(effectiveAccess(type('edit', ['src', 'docs']), { foldersRemove: ['docs'] }), { files: 'edit', folders: ['src'], foldersExcept: [], talk: true })
  assert.deepEqual(effectiveAccess(type('edit'), { foldersRemove: ['secrets'] }), { files: 'edit', folders: [], foldersExcept: ['secrets'], talk: true })
  assert.deepEqual(effectiveAccess(type('edit', ['src']), { foldersRemove: ['src/keys'] }), { files: 'edit', folders: ['src'], foldersExcept: ['src/keys'], talk: true })
  assert.deepEqual(effectiveAccess(type('edit', ['src']), { foldersRemove: ['src'] }), { files: 'view', folders: [], foldersExcept: [], talk: true }, 'nothing left to change')
  assert.equal(effectiveAccess(type('edit', [], false)).talk, false)
  assert.equal(effectiveAccess(type('edit'), { talk: false }).talk, false)
})

test('narrowing never widens', () => {
  const all = { files: 'edit', folders: [], foldersExcept: [], talk: true }
  assert.deepEqual(narrowAccess(all, { files: 'edit', folders: ['src'], foldersExcept: [], talk: true }).folders, ['src'])
  assert.deepEqual(narrowAccess({ ...all, folders: ['src'] }, { ...all, folders: [] }).folders, ['src'], 'all folders asks for more than src')
  assert.deepEqual(narrowAccess({ ...all, folders: ['src'] }, { ...all, folders: ['src/ui', 'docs'] }).folders, ['src/ui'])
  assert.equal(narrowAccess({ ...all, folders: ['src'] }, { ...all, folders: ['docs'] }).files, 'view', 'no folder in common')
  assert.equal(narrowAccess({ ...all, files: 'view' }, all).files, 'view')
  assert.deepEqual(narrowAccess({ ...all, foldersExcept: ['a'] }, { ...all, foldersExcept: ['b'] }).foldersExcept, ['a', 'b'])
  assert.equal(narrowAccess({ ...all, talk: false }, all).talk, false)
})

test('access from a pass or a request is checked, and converts to and from the relay shape', () => {
  assert.equal(cleanAccess(null), null)
  assert.equal(cleanAccess({ files: 'admin' }), null)
  assert.equal(cleanAccess({ files: 'edit', folders: ['../x'] }), null)
  const a = cleanAccess({ files: 'edit', folders: ['src/'], foldersExcept: ['src/keys'], talk: false, owner: true })
  assert.deepEqual(a, { files: 'edit', folders: ['src'], foldersExcept: ['src/keys'], talk: false })
  assert.deepEqual(relayAccess(a), { role: 'editor', scopes: ['src'], scopesExcept: ['src/keys'], talk: false })
  assert.deepEqual(fromRelay({ role: 'viewer', scopes: [] }), { files: 'view', folders: [], foldersExcept: [], talk: true }, 'a member saved before types')
  assert.ok(sameAccess(a, fromRelay(relayAccess(a))))
  assert.ok(!sameAccess(a, { ...a, talk: true }))
})

test('what someone may change, and why not', () => {
  const r = { role: 'editor', scopes: ['src'], scopesExcept: ['src/keys'], talk: true }
  assert.equal(mayChange(r, 'src/app.js'), true)
  assert.equal(mayChange(r, 'src/keys/prod.pem'), false)
  assert.equal(mayChange(r, 'docs/a.md'), false)
  assert.equal(mayChange({ role: 'viewer' }, 'src/app.js'), false)
  assert.equal(changeRefusal(r, 'src/keys/prod.pem'), 'you may not change files in src/keys')
  assert.equal(changeRefusal(r, 'docs/a.md'), 'you may only change files in src')
  assert.equal(changeRefusal({ role: 'viewer' }, 'x'), 'you can only view this session')
  assert.equal(changeRefusal(r, 'src/app.js'), null)
})

test('one line that describes access, with no em dashes', () => {
  assert.equal(describeAccess({ files: 'edit', folders: [], foldersExcept: [], talk: true }), 'Can edit · all folders')
  assert.equal(describeAccess({ files: 'edit', folders: ['src', 'docs'], foldersExcept: ['src/keys'], talk: false }), 'Can edit · src, docs · except src/keys · no posting')
  assert.equal(describeAccess({ files: 'view', folders: [], foldersExcept: [], talk: true }), 'View only')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/session-access.test.js`
Expected: FAIL with `Cannot find module '.../src/session-access.js'`.

- [ ] **Step 3: Implement**

Create `src/session-access.js`:

```js
// What someone may do in a session: the access types people define, the grants that
// give someone a type in one session (narrowed, never widened), and the access that
// works out to. Pure and shared: the accounts API works access out and signs it into
// passes, the relay enforces it, and the app shows it.
//
// Two shapes:
// - access, as the API and passes carry it: { files: 'edit'|'view', folders, foldersExcept, talk }
//   (empty folders means every folder);
// - relay access, as the relay and the app have always kept members: { role: 'editor'|'viewer',
//   scopes, scopesExcept, talk }.
import { globMatcher } from './pathrules.js'

export const BUILTIN_TYPES = Object.freeze([
  Object.freeze({ id: 'builtin:edit', name: 'Can edit', files: 'edit', folders: Object.freeze([]), talk: true, builtin: true }),
  Object.freeze({ id: 'builtin:view', name: 'View only', files: 'view', folders: Object.freeze([]), talk: true, builtin: true })
])
export const DEFAULT_TYPE = 'builtin:edit'
// Where grants go when their type is deleted: the safe default.
export const FALLBACK_TYPE = 'builtin:view'
export const MAX_TYPES = 50
export const MAX_FOLDERS = 20
export const MAX_FOLDER_LENGTH = 200
export const TYPE_NAME_MAX = 40
export const TALK_REFUSED = "You can't post in this session."
export const BAD_FOLDER = 'Folders must be paths inside the project, like src or docs.'
export const TOO_MANY_FOLDERS = 'An access type can list at most 20 folders.'

// Control and format characters (zero-width, bidi overrides) never belong in a name or a folder.
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu

export const builtinType = (id) => BUILTIN_TYPES.find((t) => t.id === id) || null

/** Folders as the relay checks them: trimmed, no leading "./" or trailing "/", each once. Throws BAD_FOLDER or TOO_MANY_FOLDERS. */
export function cleanFolders (input) {
  if (input == null) return []
  if (!Array.isArray(input)) throw new Error(BAD_FOLDER)
  const out = []
  for (const raw of input) {
    if (typeof raw !== 'string') throw new Error(BAD_FOLDER)
    const s = raw.replace(INVISIBLE, '').trim().replace(/^(\.\/)+/, '').replace(/\/+$/, '')
    if (!s) continue
    if (s.startsWith('/') || s.includes('\\') || s.length > MAX_FOLDER_LENGTH || /^[A-Za-z]:/.test(s)) throw new Error(BAD_FOLDER)
    if (s.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw new Error(BAD_FOLDER)
    if (!out.includes(s)) out.push(s)
  }
  if (out.length > MAX_FOLDERS) throw new Error(TOO_MANY_FOLDERS)
  return out
}

/** A type's name, trimmed: 1 to 40 characters with nothing invisible. Throws otherwise. */
export function cleanTypeName (value) {
  const name = [...String(value ?? '').replace(INVISIBLE, '').trim()]
  if (!name.length || name.length > TYPE_NAME_MAX) throw new Error('Give the access type a name of 1 to 40 characters.')
  return name.join('')
}

/** A new or changed access type's fields, checked. `partial` keeps fields that weren't sent out of the result. */
export function cleanTypeFields (body, { partial = false } = {}) {
  const b = body || {}
  const out = {}
  if (!partial || b.name !== undefined) out.name = cleanTypeName(b.name)
  if (!partial || b.files !== undefined) {
    if (b.files !== 'edit' && b.files !== 'view') throw new Error('files must be edit or view.')
    out.files = b.files
  }
  if (!partial || b.folders !== undefined) out.folders = cleanFolders(b.folders ?? [])
  if (!partial || b.talk !== undefined) {
    if (b.talk !== undefined && typeof b.talk !== 'boolean') throw new Error('talk must be true or false.')
    out.talk = b.talk !== false
  }
  return out
}

/** How a grant narrows its type: { files?: 'view', foldersRemove?: [...], talk?: false }. Anything else is dropped. */
export function cleanTighten (raw) {
  const t = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  if (t.files === 'view') out.files = 'view'
  const remove = cleanFolders(t.foldersRemove ?? [])
  if (remove.length) out.foldersRemove = remove
  if (t.talk === false) out.talk = false
  return out
}

/**
 * What a grant comes to: its type, narrowed. A type limited to folders loses the ones
 * removed; removing from "all folders" (or a folder the type doesn't list) is kept as
 * foldersExcept. Removing every folder a limited type has leaves nothing to change: view.
 */
export function effectiveAccess (type, tighten = {}) {
  const t = tighten || {}
  const typeFolders = type.folders || []
  const removed = t.foldersRemove || []
  let files = type.files === 'view' || t.files === 'view' ? 'view' : 'edit'
  let folders = typeFolders.filter((f) => !removed.includes(f))
  let foldersExcept = removed.filter((f) => !typeFolders.includes(f))
  if (typeFolders.length && !folders.length) { files = 'view'; folders = []; foldersExcept = [] }
  return { files, folders, foldersExcept, talk: type.talk !== false && t.talk !== false }
}

const inside = (rel, folder) => globMatcher(folder)(rel)

/**
 * What both allow. The relay uses it so an owner's live change can only narrow what a
 * person's pass allows. Folders: those of one that lie inside the other's; none left
 * means nothing to change (view). Exceptions and "no posting" add up.
 */
export function narrowAccess (a, b) {
  let files = a.files === 'view' || b.files === 'view' ? 'view' : 'edit'
  const fa = a.folders || []
  const fb = b.folders || []
  let folders
  if (!fa.length) folders = [...fb]
  else if (!fb.length) folders = [...fa]
  else {
    folders = [...new Set([...fa.filter((x) => fb.some((y) => inside(x, y))), ...fb.filter((y) => fa.some((x) => inside(y, x)))])]
    if (!folders.length) files = 'view'
  }
  const foldersExcept = [...new Set([...(a.foldersExcept || []), ...(b.foldersExcept || [])])]
  return { files, folders, foldersExcept, talk: a.talk !== false && b.talk !== false }
}

/** Access from anywhere it isn't trusted to be well formed (a pass, an owner's request): checked, or null. */
export function cleanAccess (raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.files !== 'edit' && raw.files !== 'view') return null
  try {
    return { files: raw.files, folders: cleanFolders(raw.folders ?? []), foldersExcept: cleanFolders(raw.foldersExcept ?? []), talk: raw.talk !== false }
  } catch { return null }
}

/** The relay's shape: { role, scopes, scopesExcept, talk }. */
export function relayAccess (access) {
  return { role: access.files === 'view' ? 'viewer' : 'editor', scopes: [...(access.folders || [])], scopesExcept: [...(access.foldersExcept || [])], talk: access.talk !== false }
}

/** Back from the relay's shape (a member saved before access types has no exceptions and may talk). */
export function fromRelay (m) {
  return { files: m.role === 'viewer' ? 'view' : 'edit', folders: [...(m.scopes || [])], foldersExcept: [...(m.scopesExcept || [])], talk: m.talk !== false }
}

/** May someone with this relay access change `rel`? */
export function mayChange (a, rel) {
  if (!a || a.role === 'viewer') return false
  if (a.scopes && a.scopes.length && !a.scopes.some((s) => inside(rel, s))) return false
  return !(a.scopesExcept || []).some((s) => inside(rel, s))
}

/** Why someone with this relay access may not change `rel`, in words, or null. */
export function changeRefusal (a, rel) {
  if (!a || a.role === 'viewer') return 'you can only view this session'
  if (a.scopes && a.scopes.length && !a.scopes.some((s) => inside(rel, s))) return `you may only change files in ${a.scopes.join(', ')}`
  const except = (a.scopesExcept || []).find((s) => inside(rel, s))
  return except ? `you may not change files in ${except}` : null
}

/** Same access? (Folder order doesn't matter.) */
export function sameAccess (a, b) {
  const set = (x) => [...(x || [])].sort().join('\n')
  return a.files === b.files && set(a.folders) === set(b.folders) && set(a.foldersExcept) === set(b.foldersExcept) && (a.talk !== false) === (b.talk !== false)
}

/** "Can edit · src, docs · except src/secrets · no posting": one line for menus and lists. */
export function describeAccess (a) {
  const parts = [a.files === 'view' ? 'View only' : 'Can edit']
  if (a.files !== 'view') parts.push(a.folders && a.folders.length ? a.folders.join(', ') : 'all folders')
  if (a.files !== 'view' && a.foldersExcept && a.foldersExcept.length) parts.push(`except ${a.foldersExcept.join(', ')}`)
  if (a.talk === false) parts.push('no posting')
  return parts.join(' · ')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/session-access.test.js`
Expected: PASS (9 tests).

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-access.js test/session-access.test.js
git commit -m "Access types: the shared maths of types, grants and what they allow"
```

---

### Task 2: Tables for types, grants and invites, and the memory store

The migration and its reference: the memory store mirrors each table, constraint and SQL function, the way the session-activity work did. The SQL is checked by string tests here; its functions were also run on a local Postgres while writing this plan (see Verified).

**Files:**
- Modify: `src/api/memory-store.js` (the import, new maps, cascades, `deleteUser`, and the new methods after `pruneActivity`)
- Create: `supabase/migrations/20261002010000_access_types_and_invites.sql`
- Create: `test/api-migration-access.test.js`
- Create: `test/api-store-access.test.js`

**Interfaces:**
- Consumes: `FALLBACK_TYPE` (Task 1).
- Produces (store methods, in the memory store now and the Supabase store in Task 3; times are epoch ms):
  - `listAccessTypes(ownerAccount): Type[]` (oldest first), `accessTypeById(id): Type | null`, `createAccessType({ ownerAccount, name, files, folders, talk }): Type`, `updateAccessType(id, patch): Type | null` (sets `updatedAt`), `deleteAccessType(id, ownerAccount): boolean` (its grants and invites move to `builtin:view`). `Type = { id, ownerAccount, name, files, folders, talk, createdAt, updatedAt }`.
  - `grantFor(room, account): Grant | null`, `listGrants(room): Grant[]`, `putGrant({ room, account, typeId, tighten, grantedBy }): Grant` (upsert; `23503` when the session doesn't exist), `deleteGrant(room, account): boolean`. `Grant = { room, account, typeId, tighten, grantedBy, createdAt, updatedAt }`.
  - `createSessionInvite({ room, email?, account?, accountName, typeId, invitedBy, expiresAt }): Invite` (email lowercased; exactly one of email and account), `listSessionInvites(room): Invite[]` (newest first, at most 50), `sessionInviteById(room, id)`, `cancelSessionInvite(id): boolean` (only one neither used nor cancelled), `claimEmailInvites(room, email, account): number` (open invites used; the `email:<address>` grant becomes the account's), `useAccountInvites(room, account)`.
  - `deleteUser` also removes the account's (and its agents') types, grants and invites.
- SQL: `delete_access_type(p_id uuid, p_owner text) returns boolean`, `claim_email_invites(p_room text, p_email text, p_account text, p_now timestamptz) returns integer`, `delete_account_access(p_accounts text[]) returns void`.

- [ ] **Step 1: Write the failing tests**

Create `test/api-migration-access.test.js`:

```js
// The access types migration: tables, row-level security with no client policies, and
// the SQL functions the Supabase store calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const sql = () => fs.readFileSync(new URL('../supabase/migrations/20261002010000_access_types_and_invites.sql', import.meta.url), 'utf8')
const table = (s, name) => (s.match(new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\n\\);`)) || [''])[0]
const TABLES = ['access_types', 'session_grants', 'session_invites']
const FUNCTIONS = ['delete_access_type (uuid, text)', 'claim_email_invites (text, text, text, timestamptz)', 'delete_account_access (text[])']

test('access types, grants and invites, with the columns the spec names', () => {
  const s = sql()
  const types = table(s, 'access_types')
  for (const col of ['id uuid primary key', 'owner_account text not null', 'name text not null check (char_length(name) between 1 and 40)', "files text not null check (files in ('edit', 'view'))", "folders text[] not null default '{}' check (cardinality(folders) <= 20)", 'talk boolean not null default true', 'created_at timestamptz not null', 'updated_at timestamptz not null']) assert.ok(types.includes(col), col)
  const grants = table(s, 'session_grants')
  for (const col of ['room text not null references public.relay_sessions (room) on delete cascade', 'account text not null', 'type_id text not null', "tighten jsonb not null default '{}'::jsonb", 'granted_by text not null', 'primary key (room, account)']) assert.ok(grants.includes(col), col)
  const invites = table(s, 'session_invites')
  for (const col of ['room text not null references public.relay_sessions (room) on delete cascade', 'email text check (email = lower(email)', 'account text check', 'type_id text not null', 'invited_by text not null', 'expires_at timestamptz not null', 'used_at timestamptz', 'cancelled_at timestamptz', 'check ((email is null) <> (account is null))']) assert.ok(invites.includes(col), col)
  assert.doesNotMatch(invites, /link|secret/, 'the invite link (it holds the room secret) is never stored')
})

test('clients never touch them: RLS on, no policies, no grants, functions for the service role only', () => {
  const s = sql()
  for (const t of TABLES) assert.match(s, new RegExp(`alter table public\\.${t} enable row level security`), t)
  assert.doesNotMatch(s, /create policy/)
  assert.match(s, /revoke all on public\.access_types, public\.session_grants, public\.session_invites from anon, authenticated;/)
  for (const line of s.split('\n').filter((l) => /^grant\b/.test(l))) assert.doesNotMatch(line, /\b(anon|authenticated)\b/, line)
  for (const f of FUNCTIONS) {
    assert.ok(s.includes(`revoke execute on function public.${f} from public, anon, authenticated;`), f)
    assert.ok(s.includes(`grant execute on function public.${f} to service_role;`), f)
  }
  for (const m of s.matchAll(/create function public\.\w+[\s\S]*?\nas \$\$/g)) assert.match(m[0], /set search_path = ''/, m[0].split('\n')[0])
})

test('deleting a type falls back to View only, and an email invite moves its grant to the account', () => {
  const s = sql()
  assert.match(s, /update public\.session_grants set type_id = 'builtin:view'/)
  assert.match(s, /update public\.session_invites set type_id = 'builtin:view'/)
  assert.match(s, /expires_at > p_now/)
  assert.match(s, /delete from public\.session_grants where room = p_room and account = 'email:' \|\| p_email;/)
})
```

Create `test/api-store-access.test.js`:

```js
// Access types, grants and session invites in the memory store, the reference for
// the functions in 20261002010000_access_types_and_invites.sql.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createMemoryStore } from '../src/api/memory-store.js'

const DAY = 24 * 60 * 60 * 1000
async function storeWithRoom (room = 'r1', owner = 'person:olive') {
  let clock = 1000
  const s = createMemoryStore({ now: () => clock })
  await s.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room, account: owner, name: 'Olive', owner: true, at: 500 }], 500)
  return { s, tick: (ms) => { clock += ms }, at: () => clock }
}

test('access types: create, list in order, change, and only the owner deletes', async () => {
  const { s, tick } = await storeWithRoom()
  const a = await s.createAccessType({ ownerAccount: 'person:olive', name: 'Docs', files: 'edit', folders: ['docs'], talk: true })
  tick(1)
  await s.createAccessType({ ownerAccount: 'person:olive', name: 'Quiet', files: 'view', folders: [], talk: false })
  await s.createAccessType({ ownerAccount: 'person:otto', name: 'Not mine', files: 'edit' })
  assert.deepEqual((await s.listAccessTypes('person:olive')).map((t) => t.name), ['Docs', 'Quiet'])
  tick(5)
  const changed = await s.updateAccessType(a.id, { name: 'Docs writer', folders: ['docs', 'web'] })
  assert.deepEqual([changed.name, changed.files, changed.folders, changed.updatedAt > changed.createdAt], ['Docs writer', 'edit', ['docs', 'web'], true])
  assert.equal(await s.updateAccessType(crypto.randomUUID(), { name: 'x' }), null)
  assert.equal(await s.deleteAccessType(a.id, 'person:otto'), false)
  assert.ok(await s.accessTypeById(a.id))
})

test('deleting a type moves its grants and invites to View only', async () => {
  const { s, at } = await storeWithRoom()
  const t = await s.createAccessType({ ownerAccount: 'person:olive', name: 'Docs', files: 'edit', folders: ['docs'] })
  await s.putGrant({ room: 'r1', account: 'person:mo', typeId: t.id, tighten: { talk: false }, grantedBy: 'person:olive' })
  const inv = await s.createSessionInvite({ room: 'r1', email: 'Lin@Acme.com', typeId: t.id, invitedBy: 'person:olive', expiresAt: at() + DAY })
  assert.equal(inv.email, 'lin@acme.com')
  assert.equal(await s.deleteAccessType(t.id, 'person:olive'), true)
  assert.equal(await s.accessTypeById(t.id), null)
  const g = await s.grantFor('r1', 'person:mo')
  assert.deepEqual([g.typeId, g.tighten], ['builtin:view', { talk: false }])
  assert.equal((await s.sessionInviteById('r1', inv.id)).typeId, 'builtin:view')
})

test('grants: one per room and account, replaced in place, only in a session that exists', async () => {
  const { s, tick } = await storeWithRoom()
  const first = await s.putGrant({ room: 'r1', account: 'agent:a1', typeId: 'builtin:edit', grantedBy: 'person:olive' })
  tick(10)
  const again = await s.putGrant({ room: 'r1', account: 'agent:a1', typeId: 'builtin:view', tighten: { files: 'view' }, grantedBy: 'person:olive' })
  assert.deepEqual([again.typeId, again.createdAt, again.updatedAt], ['builtin:view', first.createdAt, first.createdAt + 10])
  assert.equal((await s.listGrants('r1')).length, 1)
  await assert.rejects(s.putGrant({ room: 'nope', account: 'agent:a1', typeId: 'builtin:edit', grantedBy: 'x' }), { code: '23503' })
  assert.equal(await s.deleteGrant('r1', 'agent:a1'), true)
  assert.equal(await s.grantFor('r1', 'agent:a1'), null)
})

test('an open email invite moves its grant to whoever signs in with that email, once', async () => {
  const { s, tick, at } = await storeWithRoom()
  await s.putGrant({ room: 'r1', account: 'email:lin@acme.com', typeId: 'builtin:view', grantedBy: 'person:olive' })
  const inv = await s.createSessionInvite({ room: 'r1', email: 'lin@acme.com', typeId: 'builtin:view', invitedBy: 'person:olive', expiresAt: at() + DAY })
  assert.equal(await s.claimEmailInvites('r1', 'lin@acme.com', 'person:lin'), 1)
  assert.equal(await s.grantFor('r1', 'email:lin@acme.com'), null)
  assert.equal((await s.grantFor('r1', 'person:lin')).typeId, 'builtin:view')
  const used = await s.sessionInviteById('r1', inv.id)
  assert.deepEqual([used.usedBy, used.usedAt > 0], ['person:lin', true])
  assert.equal(await s.claimEmailInvites('r1', 'lin@acme.com', 'person:lin'), 0, 'used once')

  await s.putGrant({ room: 'r1', account: 'email:old@acme.com', typeId: 'builtin:edit', grantedBy: 'person:olive' })
  await s.createSessionInvite({ room: 'r1', email: 'old@acme.com', typeId: 'builtin:edit', invitedBy: 'person:olive', expiresAt: at() + DAY })
  tick(DAY + 1)
  assert.equal(await s.claimEmailInvites('r1', 'old@acme.com', 'person:old'), 0, 'expired')
  assert.equal(await s.grantFor('r1', 'person:old'), null)
})

test('cancelling: only a waiting invite; account invites are used when the account comes in', async () => {
  const { s, at } = await storeWithRoom()
  const a = await s.createSessionInvite({ room: 'r1', account: 'agent:a1', accountName: 'Larry', typeId: 'builtin:edit', invitedBy: 'person:olive', expiresAt: at() + DAY })
  const b = await s.createSessionInvite({ room: 'r1', account: 'person:mo', accountName: 'Mo', typeId: 'builtin:edit', invitedBy: 'person:olive', expiresAt: at() + DAY })
  await assert.rejects(s.createSessionInvite({ room: 'r1', typeId: 'builtin:edit', invitedBy: 'x', expiresAt: 1 }), { code: '23514' })
  await s.useAccountInvites('r1', 'agent:a1')
  assert.equal((await s.sessionInviteById('r1', a.id)).usedBy, 'agent:a1')
  assert.equal(await s.cancelSessionInvite(a.id), false, 'already used')
  assert.equal(await s.cancelSessionInvite(b.id), true)
  assert.equal(await s.cancelSessionInvite(b.id), false, 'once')
  assert.deepEqual((await s.listSessionInvites('r1')).map((i) => i.accountName).sort(), ['Larry', 'Mo'], 'used and cancelled ones are still listed')
  assert.equal(await s.sessionInviteById('other', a.id), null)
})

test("deleting an account takes its types, its grants and its sessions' grants and invites", async () => {
  const { s, at } = await storeWithRoom('r1', 'person:olive')
  s.addUser('olive', { name: 'Olive' })
  s.addUser('mo', { name: 'Mo' })
  await s.createAccessType({ ownerAccount: 'person:mo', name: 'Mine', files: 'edit' })
  await s.putGrant({ room: 'r1', account: 'person:mo', typeId: 'builtin:edit', grantedBy: 'person:olive' })
  await s.createSessionInvite({ room: 'r1', email: 'x@y.com', typeId: 'builtin:edit', invitedBy: 'person:olive', expiresAt: at() + DAY })
  await s.deleteUser('mo')
  assert.deepEqual([(await s.listAccessTypes('person:mo')).length, await s.grantFor('r1', 'person:mo')], [0, null])
  assert.equal((await s.listSessionInvites('r1')).length, 1)
  await s.deleteUser('olive')
  assert.equal((await s.listSessionInvites('r1')).length, 0, 'her session went, and its invites with it')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/api-migration-access.test.js test/api-store-access.test.js`
Expected: FAIL: `ENOENT ... 20261002010000_access_types_and_invites.sql`, and `s.createAccessType is not a function`.

- [ ] **Step 3: Implement**

Change `src/api/memory-store.js` (the import, new maps, cascades, `deleteUser`, and the new methods after `pruneActivity`):

```diff
diff --git a/src/api/memory-store.js b/src/api/memory-store.js
index 01fd259..e6b9a5e 100644
--- a/src/api/memory-store.js
+++ b/src/api/memory-store.js
@@ -1,6 +1,7 @@
 // The accounts API's data, in memory. Used by tests and `quilt api --memory`;
 // production uses supabase-store.js, which has the same methods.
 import crypto from 'node:crypto'
+import { FALLBACK_TYPE } from '../session-access.js'
 
 const uuid = () => crypto.randomUUID()
 const copy = (o) => (o ? structuredClone(o) : null)
@@ -27,6 +28,9 @@ export function createMemoryStore ({ now = Date.now } = {}) {
   const teams = new Map(); const teamMembers = new Map(); const invites = new Map(); const requests = new Map()
   const agentInvites = new Map(); const keyRows = new Map()
   const relaySessions = new Map(); const visits = new Map(); const seenEvents = new Map()
+  const accessTypes = new Map(); const grants = new Map(); const sessionInvites = new Map()
+  const grantKey = (room, account) => `${room}\n${account}`
+  const inviteOpenAt = (i, at) => !i.usedAt && !i.cancelledAt && i.expiresAt > at
   const all = (m, keep) => [...m.values()].filter(keep)
   const nameOf = (userId) => profiles.get(userId)?.name || ''
   const findMember = (orgId, userId) => all(members, (m) => m.orgId === orgId && m.userId === userId)[0]
@@ -56,6 +60,18 @@ export function createMemoryStore ({ now = Date.now } = {}) {
   const dropActivity = (accounts) => {
     for (const [room, s] of relaySessions) if (accounts.includes(s.ownerAccount)) relaySessions.delete(room)
     for (const [id, v] of visits) if (accounts.includes(v.account) || !relaySessions.has(v.room)) visits.delete(id)
+    dropOrphans()
+  }
+  // Grants and invites go with their session (on delete cascade).
+  const dropOrphans = () => {
+    for (const [k, g] of grants) if (!relaySessions.has(g.room)) grants.delete(k)
+    for (const [id, i] of sessionInvites) if (!relaySessions.has(i.room)) sessionInvites.delete(id)
+  }
+  // Mirrors delete_account_access.
+  const dropAccess = (accounts) => {
+    for (const [id, t] of accessTypes) if (accounts.includes(t.ownerAccount)) accessTypes.delete(id)
+    for (const [k, g] of grants) if (accounts.includes(g.account)) grants.delete(k)
+    for (const [id, i] of sessionInvites) if (accounts.includes(i.account)) sessionInvites.delete(id)
   }
 
   return {
@@ -176,7 +192,9 @@ export function createMemoryStore ({ now = Date.now } = {}) {
       if (k && !k.revokedAt) k.refreshedAt = null
     },
     async deleteUser (userId) {
-      dropActivity([`person:${userId}`, ...all(agents, (a) => a.ownerUserId === userId).map((a) => `agent:${a.id}`)])
+      const accounts = [`person:${userId}`, ...all(agents, (a) => a.ownerUserId === userId).map((a) => `agent:${a.id}`)]
+      dropAccess(accounts)
+      dropActivity(accounts)
       profiles.delete(userId); users.delete(userId)
       for (const [id, d] of devices) if (d.userId === userId) devices.delete(id)
       for (const [id, a] of agents) if (a.ownerUserId === userId) dropAgent(id)
@@ -243,6 +261,84 @@ export function createMemoryStore ({ now = Date.now } = {}) {
       for (const [id, v] of visits) if (v.endedAt != null && v.endedAt < before) visits.delete(id)
       for (const [room, s] of relaySessions) if (s.lastActiveAt < before && !all(visits, (v) => v.room === room).length) relaySessions.delete(room)
       for (const [id, at] of seenEvents) if (at < seenBefore) seenEvents.delete(id)
+      dropOrphans()
+    },
+
+    // Access types (see 20261002010000_access_types_and_invites.sql). The built-ins live in
+    // session-access.js, not here.
+    async listAccessTypes (ownerAccount) {
+      return all(accessTypes, (t) => t.ownerAccount === ownerAccount).sort((a, b) => a.createdAt - b.createdAt).map(copy)
+    },
+    async accessTypeById (id) { return copy(accessTypes.get(id)) },
+    async createAccessType ({ ownerAccount, name, files, folders = [], talk = true }) {
+      if (folders.length > 20) throw checkViolation('at most 20 folders')
+      const row = { id: uuid(), ownerAccount, name, files, folders: [...folders], talk, createdAt: now(), updatedAt: now() }
+      accessTypes.set(row.id, row); return copy(row)
+    },
+    async updateAccessType (id, patch) {
+      const t = accessTypes.get(id)
+      if (!t) return null
+      for (const k of ['name', 'files', 'folders', 'talk']) if (patch[k] !== undefined) t[k] = copy(patch[k])
+      t.updatedAt = now()
+      return copy(t)
+    },
+    // Mirrors delete_access_type: grants and invites that used it fall back to View only.
+    async deleteAccessType (id, ownerAccount) {
+      const t = accessTypes.get(id)
+      if (!t || t.ownerAccount !== ownerAccount) return false
+      accessTypes.delete(id)
+      for (const g of grants.values()) if (g.typeId === id) Object.assign(g, { typeId: FALLBACK_TYPE, updatedAt: now() })
+      for (const i of sessionInvites.values()) if (i.typeId === id) i.typeId = FALLBACK_TYPE
+      return true
+    },
+
+    // Grants: one per (room, account). Mirrors the foreign key to relay_sessions.
+    async grantFor (room, account) { return copy(grants.get(grantKey(room, account))) },
+    async listGrants (room) { return all(grants, (g) => g.room === room).sort((a, b) => a.createdAt - b.createdAt).map(copy) },
+    async putGrant ({ room, account, typeId, tighten = {}, grantedBy }) {
+      if (!relaySessions.has(room)) throw fkViolation('session', 'does not exist')
+      const k = grantKey(room, account)
+      const old = grants.get(k)
+      const row = { room, account, typeId, tighten: copy(tighten), grantedBy, createdAt: old ? old.createdAt : now(), updatedAt: now() }
+      grants.set(k, row); return copy(row)
+    },
+    async deleteGrant (room, account) { return grants.delete(grantKey(room, account)) },
+
+    // Session invites: the link is never kept.
+    async createSessionInvite ({ room, email = null, account = null, accountName = '', typeId, invitedBy, expiresAt }) {
+      if (!relaySessions.has(room)) throw fkViolation('session', 'does not exist')
+      if ((email == null) === (account == null)) throw checkViolation('an invite is for an email or an account')
+      const row = { id: uuid(), room, email: email && email.toLowerCase(), account, accountName, typeId, invitedBy, createdAt: now(), expiresAt, usedAt: null, usedBy: null, cancelledAt: null }
+      sessionInvites.set(row.id, row); return copy(row)
+    },
+    async listSessionInvites (room) {
+      return all(sessionInvites, (i) => i.room === room).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(copy)
+    },
+    async sessionInviteById (room, id) { const i = sessionInvites.get(id); return i && i.room === room ? copy(i) : null },
+    // Check-and-set: only a waiting invite is cancelled.
+    async cancelSessionInvite (id) {
+      const i = sessionInvites.get(id)
+      if (!i || i.usedAt || i.cancelledAt) return false
+      i.cancelledAt = now(); return true
+    },
+    // Mirrors claim_email_invites: the open invites are used, and the email's grant becomes the account's.
+    async claimEmailInvites (room, email, account) {
+      const at = now()
+      const open = all(sessionInvites, (i) => i.room === room && i.email === email && inviteOpenAt(i, at))
+      if (!open.length) return 0
+      for (const i of open) Object.assign(i, { usedAt: at, usedBy: account })
+      const from = grants.get(grantKey(room, `email:${email}`))
+      if (from) {
+        const old = grants.get(grantKey(room, account))
+        grants.set(grantKey(room, account), { ...copy(from), account, createdAt: old ? old.createdAt : at, updatedAt: at })
+        grants.delete(grantKey(room, `email:${email}`))
+      }
+      return open.length
+    },
+    // An invited account came in: its open invites are used.
+    async useAccountInvites (room, account) {
+      const at = now()
+      for (const i of sessionInvites.values()) if (i.room === room && i.account === account && inviteOpenAt(i, at)) Object.assign(i, { usedAt: at, usedBy: account })
     },
 
     // Orgs. Creating one makes its three built-in roles and its owner together.
```

Create `supabase/migrations/20261002010000_access_types_and_invites.sql`:

```sql
-- Access types and session invites: people define reusable access types, give someone
-- one in a session (a grant, which may narrow it but never widen it), and invite people
-- and agents to a session as one. The accounts API is the only reader and writer, and
-- signs the access into session passes; the relay enforces it. So row-level security is
-- on with no client policies and no client grants, like session activity.

-- An account's own access types. The built-ins ('builtin:edit', 'builtin:view') live in
-- code, not here, so grants keep type ids as text.
create table public.access_types (
  id uuid primary key default gen_random_uuid(),
  owner_account text not null check (owner_account ~ '^person:[A-Za-z0-9_-]{1,64}$'),
  name text not null check (char_length(name) between 1 and 40),
  files text not null check (files in ('edit', 'view')),
  -- Relative folder prefixes; empty means every folder.
  folders text[] not null default '{}' check (cardinality(folders) <= 20),
  -- May post to chat and the feed.
  talk boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index access_types_owner_account on public.access_types (owner_account, created_at);

-- What someone may do in one session: a type, narrowed by `tighten`
-- ({ files?: 'view', foldersRemove?: [...], talk?: false }). Keyed by account
-- ('person:<uuid>' or 'agent:<uuid>'), or by 'email:<address>' for an email invite
-- nobody has signed in with yet. Goes with its session.
create table public.session_grants (
  room text not null references public.relay_sessions (room) on delete cascade,
  account text not null check (account ~ '^((person|agent):[A-Za-z0-9_-]{1,64}|email:[^[:space:]@]+@[^[:space:]@]+)$'),
  type_id text not null,
  tighten jsonb not null default '{}'::jsonb,
  granted_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (room, account)
);
create index session_grants_account on public.session_grants (account);
create index session_grants_type_id on public.session_grants (type_id);

-- Invites to a session, by email or to someone the owner has worked with (an account).
-- The link (it holds the room secret) is never stored: it only goes into the email.
create table public.session_invites (
  id uuid primary key default gen_random_uuid(),
  room text not null references public.relay_sessions (room) on delete cascade,
  email text check (email = lower(email) and char_length(email) <= 254),
  account text check (account ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$'),
  -- The name the owner saw when inviting an account (never its email).
  account_name text not null default '' check (char_length(account_name) <= 64),
  type_id text not null,
  invited_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by text,
  cancelled_at timestamptz,
  check ((email is null) <> (account is null))
);
create index session_invites_room on public.session_invites (room, created_at);
create index session_invites_email on public.session_invites (room, email) where used_at is null and cancelled_at is null;

alter table public.access_types enable row level security;
alter table public.session_grants enable row level security;
alter table public.session_invites enable row level security;
revoke all on public.access_types, public.session_grants, public.session_invites from anon, authenticated;
grant all on public.access_types, public.session_grants, public.session_invites to service_role;

-- Deleting a type: its grants and invites fall back to View only, the safe default.
create function public.delete_access_type (p_id uuid, p_owner text)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  delete from public.access_types where id = p_id and owner_account = p_owner;
  if not found then
    return false;
  end if;
  update public.session_grants set type_id = 'builtin:view', updated_at = now() where type_id = p_id::text;
  update public.session_invites set type_id = 'builtin:view' where type_id = p_id::text;
  return true;
end;
$$;

-- Someone signed in with an email that has an open invite to this room: the invite is
-- used, and its grant moves from the email to their account (replacing one they had).
create function public.claim_email_invites (p_room text, p_email text, p_account text, p_now timestamptz)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  claimed integer;
begin
  update public.session_invites set used_at = p_now, used_by = p_account
    where room = p_room and email = p_email and used_at is null and cancelled_at is null and expires_at > p_now;
  get diagnostics claimed = row_count;
  if claimed > 0 then
    insert into public.session_grants as g (room, account, type_id, tighten, granted_by, created_at, updated_at)
      select e.room, p_account, e.type_id, e.tighten, e.granted_by, p_now, p_now
      from public.session_grants e where e.room = p_room and e.account = 'email:' || p_email
      on conflict (room, account) do update set
        type_id = excluded.type_id, tighten = excluded.tighten, granted_by = excluded.granted_by, updated_at = excluded.updated_at;
    delete from public.session_grants where room = p_room and account = 'email:' || p_email;
  end if;
  return claimed;
end;
$$;

-- Deleting an account: its access types, and its grants and invites in other people's
-- sessions (its own sessions take theirs with them).
create function public.delete_account_access (p_accounts text[])
returns void
language sql
set search_path = ''
as $$
  delete from public.access_types where owner_account = any (p_accounts);
  delete from public.session_grants where account = any (p_accounts);
  delete from public.session_invites where account = any (p_accounts);
$$;

revoke execute on function public.delete_access_type (uuid, text) from public, anon, authenticated;
revoke execute on function public.claim_email_invites (text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.delete_account_access (text[]) from public, anon, authenticated;
grant execute on function public.delete_access_type (uuid, text) to service_role;
grant execute on function public.claim_email_invites (text, text, text, timestamptz) to service_role;
grant execute on function public.delete_account_access (text[]) to service_role;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/api-migration-access.test.js test/api-store-access.test.js`
Expected: PASS (9 tests).

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/memory-store.js supabase/migrations/20261002010000_access_types_and_invites.sql test/api-migration-access.test.js test/api-store-access.test.js
git commit -m "Access types: tables for types, grants and session invites, and the memory store"
```

---

### Task 3: The Supabase store's types, grants and invites

The production store: plain table calls with named columns, and the three SQL functions for the steps that must be atomic. Tested against a stand-in client that records each call.

**Files:**
- Modify: `src/api/supabase-store.js`
- Create: `test/api-supabase-access.test.js`
- Modify: `test/api-supabase-activity.test.js`

**Interfaces:**
- Consumes: the migration's tables and functions (Task 2).
- Produces: the same methods as the memory store (Task 2) in `createSupabaseStore`. `deleteUser` calls `delete_account_access`, then `delete_account_activity`, then deletes the auth user.

- [ ] **Step 1: Write the failing tests**

Create `test/api-supabase-access.test.js`:

```js
// The Supabase store's access-type, grant and invite methods, against a stand-in client
// that records each call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupabaseStore } from '../src/api/supabase-store.js'

// A stand-in supabase client. `answer(call)` gives each query's rows; every call is kept.
function fakeClient (answer = () => []) {
  const calls = []
  const chain = (call) => new Proxy({}, {
    get (_, op) {
      if (op === 'then') return (res, rej) => Promise.resolve({ data: answer(call), error: null }).then(res, rej)
      return (...args) => { call.ops.push([op, ...args]); return chain(call) }
    }
  })
  const client = {
    from (table) { const call = { table, ops: [] }; calls.push(call); return chain(call) },
    rpc (fn, args) { const call = { rpc: fn, args, ops: [] }; calls.push(call); return chain(call) },
    auth: { admin: { deleteUser: async (id) => { calls.push({ deletedUser: id }); return { error: null } } } }
  }
  return { client, calls }
}

const TYPE_ROW = { id: 't1', owner_account: 'person:u1', name: 'Docs', files: 'edit', folders: ['docs'], talk: false, created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' }

test('access types are read and written by owner, with named columns', async () => {
  const { client, calls } = fakeClient((call) => (call.rpc ? true : call.ops.some(([op]) => op === 'single' || op === 'maybeSingle') ? TYPE_ROW : [TYPE_ROW]))
  const s = createSupabaseStore({ client })
  const [t] = await s.listAccessTypes('person:u1')
  assert.deepEqual([t.ownerAccount, t.folders, t.talk, t.createdAt], ['person:u1', ['docs'], false, Date.parse('2026-10-02T00:00:00Z')])
  assert.deepEqual(calls[0].ops, [['select', 'id, owner_account, name, files, folders, talk, created_at, updated_at'], ['eq', 'owner_account', 'person:u1'], ['order', 'created_at']])
  await s.createAccessType({ ownerAccount: 'person:u1', name: 'Docs', files: 'edit', folders: ['docs'], talk: false })
  assert.deepEqual(calls[1].ops[0], ['insert', { owner_account: 'person:u1', name: 'Docs', files: 'edit', folders: ['docs'], talk: false }])
  await s.updateAccessType('t1', { talk: true })
  const [op, patch] = calls[2].ops[0]
  assert.equal(op, 'update')
  assert.deepEqual(Object.keys(patch).sort(), ['talk', 'updated_at'], 'only what changed, and when')
  assert.equal(await s.deleteAccessType('t1', 'person:u1'), true)
  assert.deepEqual([calls[3].rpc, calls[3].args], ['delete_access_type', { p_id: 't1', p_owner: 'person:u1' }])
})

test('grants upsert on (room, account), and an email invite is claimed by one function call', async () => {
  const { client, calls } = fakeClient((call) => (call.rpc ? 1 : call.ops.some(([op]) => op === 'delete') ? [{ account: 'agent:a1' }] : { room: 'r1', account: 'agent:a1', type_id: 'builtin:view', tighten: { talk: false }, granted_by: 'person:u1', created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' }))
  const s = createSupabaseStore({ client })
  const g = await s.putGrant({ room: 'r1', account: 'agent:a1', typeId: 'builtin:view', tighten: { talk: false }, grantedBy: 'person:u1' })
  assert.deepEqual([g.typeId, g.tighten, g.grantedBy], ['builtin:view', { talk: false }, 'person:u1'])
  const [op, row, opts] = calls[0].ops[0]
  assert.equal(op, 'upsert')
  assert.deepEqual([row.room, row.account, row.type_id, row.tighten, row.granted_by, opts], ['r1', 'agent:a1', 'builtin:view', { talk: false }, 'person:u1', { onConflict: 'room,account' }])
  assert.equal(await s.deleteGrant('r1', 'agent:a1'), true)
  assert.equal(await s.claimEmailInvites('r1', 'lin@acme.com', 'person:lin'), 1)
  const claim = calls[2]
  assert.equal(claim.rpc, 'claim_email_invites')
  assert.deepEqual([claim.args.p_room, claim.args.p_email, claim.args.p_account], ['r1', 'lin@acme.com', 'person:lin'])
  assert.ok(!Number.isNaN(Date.parse(claim.args.p_now)))
})

test('session invites keep a lowercase email and never a link', async () => {
  const { client, calls } = fakeClient(() => ({ id: 'i1', room: 'r1', email: 'lin@acme.com', account: null, account_name: '', type_id: 'builtin:edit', invited_by: 'person:u1', created_at: '2026-10-02T00:00:00Z', expires_at: '2026-10-09T00:00:00Z', used_at: null, used_by: null, cancelled_at: null }))
  const s = createSupabaseStore({ client })
  const i = await s.createSessionInvite({ room: 'r1', email: 'Lin@Acme.com', typeId: 'builtin:edit', invitedBy: 'person:u1', expiresAt: Date.parse('2026-10-09T00:00:00Z') })
  assert.deepEqual(calls[0].ops[0], ['insert', { room: 'r1', email: 'lin@acme.com', account: null, account_name: '', type_id: 'builtin:edit', invited_by: 'person:u1', expires_at: '2026-10-09T00:00:00.000Z' }])
  assert.deepEqual([i.typeId, i.expiresAt, i.usedAt], ['builtin:edit', Date.parse('2026-10-09T00:00:00Z'), null])
})

test('deleting a user removes its access before its activity, before the auth user', async () => {
  const { client, calls } = fakeClient((call) => (call.table === 'agents' ? [{ id: 'a1' }] : null))
  const s = createSupabaseStore({ client })
  await s.deleteUser('u1')
  assert.deepEqual(calls.slice(1).map((c) => c.rpc || (c.deletedUser && 'auth')), ['delete_account_access', 'delete_account_activity', 'auth'])
  assert.deepEqual(calls[1].args, { p_accounts: ['person:u1', 'agent:a1'] })
})
```

Change `test/api-supabase-activity.test.js` (`delete_account_access` now runs first):

```diff
diff --git a/test/api-supabase-activity.test.js b/test/api-supabase-activity.test.js
index 9e53c80..a1ec1e4 100644
--- a/test/api-supabase-activity.test.js
+++ b/test/api-supabase-activity.test.js
@@ -66,6 +66,7 @@ test("deleting a user removes its activity and its agents' before the auth user"
   const s = createSupabaseStore({ client })
   await s.deleteUser('u1')
   assert.deepEqual(calls[0].ops, [['select', 'id'], ['eq', 'owner_user_id', 'u1']])
-  assert.deepEqual([calls[1].rpc, calls[1].args], ['delete_account_activity', { p_accounts: ['person:u1', 'agent:a1', 'agent:a2'] }])
-  assert.deepEqual(calls[2], { deletedUser: 'u1' })
+  // delete_account_access (access types and grants) goes first; see api-supabase-access.test.js.
+  assert.deepEqual([calls[2].rpc, calls[2].args], ['delete_account_activity', { p_accounts: ['person:u1', 'agent:a1', 'agent:a2'] }])
+  assert.deepEqual(calls[3], { deletedUser: 'u1' })
 })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/api-supabase-access.test.js test/api-supabase-activity.test.js`
Expected: FAIL: `s.listAccessTypes is not a function` (and the activity test's call order, which now expects `delete_account_access` first).

- [ ] **Step 3: Implement**

Change `src/api/supabase-store.js`:

```diff
diff --git a/src/api/supabase-store.js b/src/api/supabase-store.js
index 801103a..63b1cf9 100644
--- a/src/api/supabase-store.js
+++ b/src/api/supabase-store.js
@@ -21,6 +21,9 @@ const REQUEST = 'id, org_id, user_id, email, status, decided_by, decided_at, cre
 const AGENT_INVITE = 'id, token_hash, owner_user_id, org_id, created_by, role_id, teams, expires_at, used_at, used_by_agent_id, cancelled_at, created_at'
 const AGENT_KEY = 'id, agent_id, family_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, refreshed_at, revoked_at, created_at'
 const RELAY_SESSION = 'room, name, owner_account, created_at, last_active_at, renamed_at'
+const ACCESS_TYPE = 'id, owner_account, name, files, folders, talk, created_at, updated_at'
+const GRANT = 'room, account, type_id, tighten, granted_by, created_at, updated_at'
+const SESSION_INVITE = 'id, room, email, account, account_name, type_id, invited_by, created_at, expires_at, used_at, used_by, cancelled_at'
 // PostgREST hands back at most 1000 rows per request: longer lists are read a page at a time.
 const PAGE = 1000
 
@@ -151,7 +154,9 @@ export function createSupabaseStore ({ url, serviceKey, client }) {
     // activity is keyed by 'person:<id>' and 'agent:<id>', not foreign keys, so it goes first.
     async deleteUser (userId) {
       const agents = await one(db.from('agents').select('id').eq('owner_user_id', userId))
-      await one(db.rpc('delete_account_activity', { p_accounts: [`person:${userId}`, ...agents.map((a) => `agent:${a.id}`)] }))
+      const accounts = [`person:${userId}`, ...agents.map((a) => `agent:${a.id}`)]
+      await one(db.rpc('delete_account_access', { p_accounts: accounts }))
+      await one(db.rpc('delete_account_activity', { p_accounts: accounts }))
       const { error } = await db.auth.admin.deleteUser(userId)
       if (error) throw error
     },
@@ -183,6 +188,53 @@ export function createSupabaseStore ({ url, serviceKey, client }) {
       await one(db.rpc('prune_activity', { p_before: ts(before), p_seen_before: ts(seenBefore) }))
     },
 
+    // Access types, grants and session invites (see 20261002010000_access_types_and_invites.sql).
+    async listAccessTypes (ownerAccount) {
+      return (await one(db.from('access_types').select(ACCESS_TYPE).eq('owner_account', ownerAccount).order('created_at'))).map(rowFrom)
+    },
+    async accessTypeById (id) { return rowFrom(await one(db.from('access_types').select(ACCESS_TYPE).eq('id', id).maybeSingle())) },
+    async createAccessType ({ ownerAccount, name, files, folders = [], talk = true }) {
+      return rowFrom(await one(db.from('access_types').insert({ owner_account: ownerAccount, name, files, folders, talk }).select(ACCESS_TYPE).single()))
+    },
+    async updateAccessType (id, { name, files, folders, talk }) {
+      return rowFrom(await one(db.from('access_types').update(toSnake({ name, files, folders, talk, updatedAt: new Date().toISOString() })).eq('id', id).select(ACCESS_TYPE).maybeSingle()))
+    },
+    // Its grants and invites fall back to View only, in the same transaction.
+    async deleteAccessType (id, ownerAccount) {
+      return await one(db.rpc('delete_access_type', { p_id: id, p_owner: ownerAccount }))
+    },
+    async grantFor (room, account) { return rowFrom(await one(db.from('session_grants').select(GRANT).eq('room', room).eq('account', account).maybeSingle())) },
+    async listGrants (room) { return (await one(db.from('session_grants').select(GRANT).eq('room', room).order('created_at'))).map(rowFrom) },
+    async putGrant ({ room, account, typeId, tighten = {}, grantedBy }) {
+      return rowFrom(await one(db.from('session_grants')
+        .upsert({ room, account, type_id: typeId, tighten, granted_by: grantedBy, updated_at: new Date().toISOString() }, { onConflict: 'room,account' })
+        .select(GRANT).single()))
+    },
+    async deleteGrant (room, account) {
+      return (await one(db.from('session_grants').delete().eq('room', room).eq('account', account).select('account'))).length > 0
+    },
+    async createSessionInvite ({ room, email = null, account = null, accountName = '', typeId, invitedBy, expiresAt }) {
+      return rowFrom(await one(db.from('session_invites')
+        .insert({ room, email: email && email.toLowerCase(), account, account_name: accountName, type_id: typeId, invited_by: invitedBy, expires_at: ts(expiresAt) })
+        .select(SESSION_INVITE).single()))
+    },
+    async listSessionInvites (room) {
+      return (await one(db.from('session_invites').select(SESSION_INVITE).eq('room', room).order('created_at', { ascending: false }).limit(50))).map(rowFrom)
+    },
+    async sessionInviteById (room, id) { return rowFrom(await one(db.from('session_invites').select(SESSION_INVITE).eq('room', room).eq('id', id).maybeSingle())) },
+    // Check-and-set: only a waiting invite is cancelled.
+    async cancelSessionInvite (id) {
+      const rows = await one(db.from('session_invites').update({ cancelled_at: new Date().toISOString() }).eq('id', id).is('used_at', null).is('cancelled_at', null).select('id'))
+      return rows.length > 0
+    },
+    async claimEmailInvites (room, email, account) {
+      return await one(db.rpc('claim_email_invites', { p_room: room, p_email: email, p_account: account, p_now: new Date().toISOString() }))
+    },
+    async useAccountInvites (room, account) {
+      const at = new Date().toISOString()
+      await one(db.from('session_invites').update({ used_at: at, used_by: account }).eq('room', room).eq('account', account).is('used_at', null).is('cancelled_at', null).gt('expires_at', at))
+    },
+
     // Orgs. create_org makes the org, its three built-in roles and its owner in one
     // transaction. first: true is for "a team" sign-ups, where two tabs (or a double
     // click) can both see no org yet; create_org locks on the owner and hands back
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/api-supabase-access.test.js test/api-supabase-activity.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/supabase-store.js test/api-supabase-access.test.js test/api-supabase-activity.test.js
git commit -m "Access types: the Supabase store's types, grants and invites"
```

---

### Task 4: `/v1/access-types`

Listing, creating, changing and deleting access types, from the website (JWT) or the app (`qd_` token).

**Files:**
- Create: `src/api/routes/access-types.js`
- Modify: `src/api/server.js`
- Create: `test/api-access-types.test.js`

**Interfaces:**
- Consumes: `BUILTIN_TYPES`, `builtinType`, `cleanTypeFields`, `MAX_TYPES` (Task 1); store type methods (Tasks 2 and 3); `person` from the API's route context.
- Produces:
  - `GET /v1/access-types` → `{ types: TypeView[] }`, built-ins first; `POST /v1/access-types` (`{ name, files, folders?, talk? }`) → `{ type }`; `PUT /v1/access-types/:id` (any of those fields) → `{ type }`; `DELETE /v1/access-types/:id` → `{ ok: true }`.
  - `TypeView = { id, name, files, folders, talk, builtin, createdAt?, updatedAt? }` (`typeView` exported from `src/api/routes/access-types.js`).
  - Errors: 400 with the field's message; 403 `Built-in access types can't be changed or deleted.`; 404 `no such access type`; 409 `You can have at most 50 access types. Delete one first.`

- [ ] **Step 1: Write the failing test**

Create `test/api-access-types.test.js`:

```js
// Access types over the API: the built-ins, your own (up to 50), changing and deleting
// them, from the website (a JWT) or the app (a computer token).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApi, linkDevice } from './api-helpers.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
const types = (userId) => t.call('GET', '/v1/access-types', null, userId)

test('everyone has the two built-ins first', async () => {
  const res = await types('lim')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.types, [
    { id: 'builtin:edit', name: 'Can edit', files: 'edit', folders: [], talk: true, builtin: true },
    { id: 'builtin:view', name: 'View only', files: 'view', folders: [], talk: true, builtin: true }
  ])
  assert.equal((await t.call('GET', '/v1/access-types')).status, 401)
})

test('create, list, change and delete your own; nobody else sees or touches them', async () => {
  const made = await t.call('POST', '/v1/access-types', { name: ' Docs writer ', files: 'edit', folders: ['./docs/', 'web'], talk: false }, 'mem')
  assert.equal(made.status, 200, JSON.stringify(made.body))
  const { type } = made.body
  assert.deepEqual([type.name, type.files, type.folders, type.talk, type.builtin], ['Docs writer', 'edit', ['docs', 'web'], false, false])
  assert.deepEqual((await types('mem')).body.types.map((x) => x.name), ['Can edit', 'View only', 'Docs writer'])
  assert.equal((await types('lim')).body.types.length, 2, "Lin doesn't see Mo's types")

  const changed = await t.call('PUT', `/v1/access-types/${type.id}`, { talk: true }, 'mem')
  assert.deepEqual([changed.status, changed.body.type.talk, changed.body.type.name, changed.body.type.folders], [200, true, 'Docs writer', ['docs', 'web']])
  assert.equal((await t.call('PUT', `/v1/access-types/${type.id}`, { name: 'Mine now' }, 'lim')).status, 404)
  assert.equal((await t.call('DELETE', `/v1/access-types/${type.id}`, null, 'lim')).status, 404)
  assert.equal((await t.call('PUT', '/v1/access-types/not-a-uuid', { name: 'x' }, 'mem')).status, 404)

  assert.deepEqual((await t.call('DELETE', `/v1/access-types/${type.id}`, null, 'mem')).body, { ok: true })
  assert.equal((await types('mem')).body.types.length, 2)
  assert.equal((await t.call('DELETE', `/v1/access-types/${type.id}`, null, 'mem')).status, 404)
})

test('the built-ins cannot be changed or deleted', async () => {
  for (const [method, body] of [['PUT', { name: 'Admin' }], ['DELETE', null]]) {
    const res = await t.call(method, '/v1/access-types/builtin:edit', body, 'mem')
    assert.deepEqual([res.status, res.body.error], [403, "Built-in access types can't be changed or deleted."], method)
  }
})

test('plain messages for bad fields', async () => {
  const bad = async (body) => (await t.call('POST', '/v1/access-types', body, 'mem')).body.error
  assert.equal(await bad({ name: '', files: 'edit' }), 'Give the access type a name of 1 to 40 characters.')
  assert.equal(await bad({ name: 'x'.repeat(41), files: 'edit' }), 'Give the access type a name of 1 to 40 characters.')
  assert.equal(await bad({ name: 'x', files: 'owner' }), 'files must be edit or view.')
  assert.equal(await bad({ name: 'x', files: 'edit', folders: ['../up'] }), 'Folders must be paths inside the project, like src or docs.')
  assert.equal(await bad({ name: 'x', files: 'edit', folders: Array.from({ length: 21 }, (_, i) => `f${i}`) }), 'An access type can list at most 20 folders.')
  assert.equal(await bad({ name: 'x', files: 'edit', talk: 'no' }), 'talk must be true or false.')
  for (const e of [await bad({ name: '' }), await bad({ name: 'x', files: 'x' })]) assert.doesNotMatch(e, /—/)
})

test('at most 50 of your own', async () => {
  for (let i = 0; i < 50; i++) assert.equal((await t.call('POST', '/v1/access-types', { name: `T${i}`, files: 'view' }, 'out')).status, 200)
  const over = await t.call('POST', '/v1/access-types', { name: 'One more', files: 'view' }, 'out')
  assert.deepEqual([over.status, over.body.error], [409, 'You can have at most 50 access types. Delete one first.'])
})

test("the app's computer token works too", async () => {
  const { token } = await linkDevice(t, 'gm')
  const res = await t.call('POST', '/v1/access-types', { name: 'From the app', files: 'view' }, null, { authorization: `Bearer ${token}` })
  assert.equal(res.status, 200)
  assert.deepEqual((await t.call('GET', '/v1/access-types', null, null, { authorization: `Bearer ${token}` })).body.types.map((x) => x.name), ['Can edit', 'View only', 'From the app'])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/api-access-types.test.js`
Expected: FAIL: 404 `not found` for every route.

- [ ] **Step 3: Implement**

Create `src/api/routes/access-types.js`:

```js
// Access types: reusable sets of what someone may do in a session (edit or view, which
// folders, and whether they may post). Every account has the two built-ins, which can't
// be changed, and up to 50 of its own.
import { HttpError, UUID } from '../http.js'
import { BUILTIN_TYPES, builtinType, cleanTypeFields, MAX_TYPES } from '../../session-access.js'

const NO_TYPE = 'no such access type'
const BUILT_IN = "Built-in access types can't be changed or deleted."

export const typeView = (t) => ({ id: t.id, name: t.name, files: t.files, folders: [...(t.folders || [])], talk: t.talk !== false, builtin: !!t.builtin, ...(t.builtin ? {} : { createdAt: t.createdAt, updatedAt: t.updatedAt }) })

export function accessTypeRoutes ({ store, person }) {
  const me = async (req) => `person:${(await person(req)).userId}`
  const fields = (body, opts) => {
    try { return cleanTypeFields(body, opts) } catch (err) { throw new HttpError(400, err.message) }
  }
  /** One of my own types (a built-in is 403, anything else 404). */
  async function mine (account, id) {
    if (builtinType(id)) throw new HttpError(403, BUILT_IN)
    const t = UUID.test(id) ? await store.accessTypeById(id) : null
    if (!t || t.ownerAccount !== account) throw new HttpError(404, NO_TYPE)
    return t
  }

  return [
    ['GET', /^\/v1\/access-types$/, async (req) => {
      const account = await me(req)
      return { types: [...BUILTIN_TYPES, ...await store.listAccessTypes(account)].map(typeView) }
    }],

    ['POST', /^\/v1\/access-types$/, async (req, body) => {
      const account = await me(req)
      const f = fields(body)
      if ((await store.listAccessTypes(account)).length >= MAX_TYPES) throw new HttpError(409, 'You can have at most 50 access types. Delete one first.')
      return { type: typeView(await store.createAccessType({ ownerAccount: account, ...f })) }
    }],

    ['PUT', /^\/v1\/access-types\/([^/]+)$/, async (req, body, [id]) => {
      const account = await me(req)
      const f = fields(body, { partial: true })
      const t = await mine(account, id)
      if (!Object.keys(f).length) return { type: typeView(t) }
      return { type: typeView(await store.updateAccessType(t.id, f)) }
    }],

    // Grants that used it fall back to View only.
    ['DELETE', /^\/v1\/access-types\/([^/]+)$/, async (req, body, [id]) => {
      const account = await me(req)
      const t = await mine(account, id)
      if (!await store.deleteAccessType(t.id, account)) throw new HttpError(404, NO_TYPE)
      return { ok: true }
    }]
  ]
}
```

Change `src/api/server.js`:

```diff
diff --git a/src/api/server.js b/src/api/server.js
index 1b56642..9a1e144 100644
--- a/src/api/server.js
+++ b/src/api/server.js
@@ -16,6 +16,7 @@ import { agentInviteRoutes } from './routes/agent-invites.js'
 import { joinRoutes } from './routes/join.js'
 import { relayRoutes } from './routes/relay.js'
 import { sessionRoutes } from './routes/sessions.js'
+import { accessTypeRoutes } from './routes/access-types.js'
 import { HOSTED_RELAY } from '../settings.js'
 
 const LINK_TTL_MS = 10 * 60 * 1000
@@ -225,7 +226,7 @@ export function startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, sit
 
   // Org routes live in their own modules and share the caller check and the limiter.
   const ctx = { store, user, person, bearer, now, site, apiUrl: api, mailer, log, limit: limitInvites, limitSend: limitInviteSend, limitTokens, limitJoin, agentAuth, relaySecret }
-  routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx), ...agentRoutes(ctx), ...agentInviteRoutes(ctx), ...joinRoutes(ctx), ...relayRoutes(ctx), ...sessionRoutes(ctx))
+  routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx), ...agentRoutes(ctx), ...agentInviteRoutes(ctx), ...joinRoutes(ctx), ...relayRoutes(ctx), ...sessionRoutes(ctx), ...accessTypeRoutes(ctx))
 
   async function openLink (code) {
     const userCode = normalizeUserCode(code)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/api-access-types.test.js`
Expected: PASS (6 tests).

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/access-types.js src/api/server.js test/api-access-types.test.js
git commit -m "Access types: GET, POST, PUT and DELETE /v1/access-types"
```

---

### Task 5: Session grants

The owner gives someone an access type in a session, optionally narrowed. Only the owner (as `relay_sessions.owner_account` records) may; the API answers with what the grant comes to.

**Files:**
- Create: `src/api/access.js`
- Create: `src/api/routes/grants.js`
- Modify: `src/api/server.js`
- Create: `test/api-grants.test.js`

**Interfaces:**
- Consumes: `builtinType`, `effectiveAccess`, `cleanTighten`, `FALLBACK_TYPE` (Task 1); store grant methods and `sessionByRoom`.
- Produces:
  - `src/api/access.js`: `ownType(store, ownerAccount, typeId): Type | null` (a built-in, or the owner's own), `typeOfGrant(store, grant): Type` (View only if its type is gone), `grantView(store, grant): { account, typeId, typeName, tighten, access, updatedAt }`.
  - `src/api/routes/grants.js`: `ROOM`, `ACCOUNT`, `NOT_YET`, `sessionOwner(store, person, req, room, forbidden?): { me, userId, session }` (404 `NOT_YET`, 403), and the routes `GET /v1/sessions/:room/grants` → `{ grants }`, `PUT /v1/sessions/:room/grants/:account` (`{ typeId, tighten? }`) → `{ grant }`, `DELETE ...` → `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

Create `test/api-grants.test.js`:

```js
// Session grants: only a session's owner gives people and agents an access type there,
// narrowed or not, and the API works out what that comes to.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startTestApi, linkDevice } from './api-helpers.js'

let t
before(async () => { t = await startTestApi() })
after(() => t.close())
let rooms = 0
/** A session the relay has reported, owned by `owner` (a user id in the test cast). */
async function session (owner = 'mem') {
  const room = `grants-${++rooms}`
  await t.store.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room, account: `person:${owner}`, name: 'Owner', owner: true, at: Date.now() }], Date.now())
  return room
}
const put = (room, account, body, userId = 'mem') => t.call('PUT', `/v1/sessions/${room}/grants/${account}`, body, userId)

test('the owner gives an agent a type, narrows it, and lists what it comes to', async () => {
  const room = await session()
  const docs = (await t.call('POST', '/v1/access-types', { name: 'Docs', files: 'edit', folders: ['docs', 'web'] }, 'mem')).body.type
  const res = await put(room, 'agent:a1', { typeId: docs.id, tighten: { foldersRemove: ['web'], talk: false, files: 'edit' } })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.grant, { ...res.body.grant, account: 'agent:a1', typeId: docs.id, typeName: 'Docs', tighten: { foldersRemove: ['web'], talk: false }, access: { files: 'edit', folders: ['docs'], foldersExcept: [], talk: false } })
  await put(room, 'person:lim', { typeId: 'builtin:edit', tighten: { foldersRemove: ['secrets'] } })
  const list = await t.call('GET', `/v1/sessions/${room}/grants`, null, 'mem')
  assert.deepEqual(list.body.grants.map((g) => [g.account, g.typeName, g.access.foldersExcept]), [['agent:a1', 'Docs', []], ['person:lim', 'Can edit', ['secrets']]])
  assert.deepEqual((await t.call('DELETE', `/v1/sessions/${room}/grants/agent:a1`, null, 'mem')).body, { ok: true })
  assert.equal((await t.call('GET', `/v1/sessions/${room}/grants`, null, 'mem')).body.grants.length, 1)
})

test('only the owner, only in a session heyquilt.com knows, and only with their own types', async () => {
  const room = await session()
  const notMine = (await t.call('POST', '/v1/access-types', { name: 'Lins', files: 'edit' }, 'lim')).body.type
  const forbidden = await put(room, 'person:lim', { typeId: 'builtin:edit' }, 'lim')
  assert.deepEqual([forbidden.status, forbidden.body.error], [403, 'Only the session owner can change who gets in.'])
  assert.equal((await t.call('GET', `/v1/sessions/${room}/grants`, null, 'lim')).status, 403)
  assert.equal((await t.call('DELETE', `/v1/sessions/${room}/grants/person:lim`, null, 'lim')).status, 403)
  const unknown = await put('never-reported', 'person:lim', { typeId: 'builtin:edit' })
  assert.deepEqual([unknown.status, unknown.body.error], [404, "That session hasn't reached heyquilt.com yet. Try again in a minute."])
  assert.equal((await put(room, 'person:lim', { typeId: notMine.id })).body.error, 'no such access type')
  assert.equal((await put(room, 'person:lim', { typeId: 'builtin:admin' })).status, 400)
  assert.equal((await put(room, 'Bob', { typeId: 'builtin:edit' })).status, 400, 'by account, never by name')
  assert.equal((await put(room, 'person:mem', { typeId: 'builtin:view' })).body.error, 'The owner always has full access.')
  assert.equal((await put(room, 'person:lim', { typeId: 'builtin:edit', tighten: { foldersRemove: ['/etc'] } })).status, 400)
  assert.equal((await t.call('GET', `/v1/sessions/${room}/grants`, null, null)).status, 401)
})

test('deleting a type leaves its grants on View only', async () => {
  const room = await session()
  const type = (await t.call('POST', '/v1/access-types', { name: 'Temp', files: 'edit' }, 'mem')).body.type
  await put(room, 'person:lim', { typeId: type.id, tighten: { talk: false } })
  await t.call('DELETE', `/v1/access-types/${type.id}`, null, 'mem')
  const [g] = (await t.call('GET', `/v1/sessions/${room}/grants`, null, 'mem')).body.grants
  assert.deepEqual([g.typeId, g.typeName, g.access], ['builtin:view', 'View only', { files: 'view', folders: [], foldersExcept: [], talk: false }])
})

test("the owner's app sets grants with its computer token", async () => {
  const room = await session('admin')
  const { token } = await linkDevice(t, 'admin')
  const res = await t.call('PUT', `/v1/sessions/${room}/grants/agent:a9`, { typeId: 'builtin:view' }, null, { authorization: `Bearer ${token}` })
  assert.deepEqual([res.status, res.body.grant.access.files], [200, 'view'])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/api-grants.test.js`
Expected: FAIL: 404 `not found` for the grant routes.

- [ ] **Step 3: Implement**

Create `src/api/access.js`:

```js
// Access types and grants for the API's routes: finding a type (a built-in, or one of
// the owner's own) and what a grant comes to.
import { UUID } from './http.js'
import { builtinType, effectiveAccess, FALLBACK_TYPE } from '../session-access.js'

/** A built-in, or one of `ownerAccount`'s own types; null otherwise (someone else's, or none). */
export async function ownType (store, ownerAccount, typeId) {
  const id = String(typeId || '')
  const b = builtinType(id)
  if (b) return b
  if (!UUID.test(id)) return null
  const t = await store.accessTypeById(id)
  return t && t.ownerAccount === ownerAccount ? t : null
}

/** A grant's type: View only when its own is gone (deleted while this was read). */
export async function typeOfGrant (store, grant) {
  return builtinType(grant.typeId) || (UUID.test(grant.typeId) && await store.accessTypeById(grant.typeId)) || builtinType(FALLBACK_TYPE)
}

/** A grant as the owner sees it: its type's name and what it comes to. */
export async function grantView (store, grant) {
  const type = await typeOfGrant(store, grant)
  return { account: grant.account, typeId: type.id, typeName: type.name, tighten: grant.tighten || {}, access: effectiveAccess(type, grant.tighten), updatedAt: grant.updatedAt }
}
```

Create `src/api/routes/grants.js`:

```js
// Who gets what in a session: the owner gives someone (an account) an access type,
// optionally narrowed. The API is where access lives; passes carry it to the relay.
import { HttpError } from '../http.js'
import { cleanTighten } from '../../session-access.js'
import { ownType, grantView } from '../access.js'

export const ROOM = /^[A-Za-z0-9_-]{1,64}$/
export const ACCOUNT = /^(person|agent):[A-Za-z0-9_-]{1,64}$/
export const NOT_YET = "That session hasn't reached heyquilt.com yet. Try again in a minute."

/**
 * The session's owner, from their request: { me: 'person:<id>', userId, session }. 404 for a
 * session the API hasn't heard of (the relay reports new ones within seconds), 403 for anyone else.
 */
export async function sessionOwner (store, person, req, room, forbidden = 'Only the session owner can change who gets in.') {
  const { userId } = await person(req)
  const me = `person:${userId}`
  if (!ROOM.test(room)) throw new HttpError(404, NOT_YET)
  const session = await store.sessionByRoom(room)
  if (!session) throw new HttpError(404, NOT_YET)
  if (session.ownerAccount !== me) throw new HttpError(403, forbidden)
  return { me, userId, session }
}

export function grantRoutes ({ store, person }) {
  return [
    ['GET', /^\/v1\/sessions\/([^/]+)\/grants$/, async (req, body, [room]) => {
      await sessionOwner(store, person, req, room)
      return { grants: await Promise.all((await store.listGrants(room)).map((g) => grantView(store, g))) }
    }],

    ['PUT', /^\/v1\/sessions\/([^/]+)\/grants\/([^/]+)$/, async (req, body, [room, account]) => {
      const { me } = await sessionOwner(store, person, req, room)
      if (!ACCOUNT.test(account)) throw new HttpError(400, 'Grants are for people and agents (person:<id> or agent:<id>).')
      if (account === me) throw new HttpError(400, 'The owner always has full access.')
      const type = await ownType(store, me, body.typeId)
      if (!type) throw new HttpError(400, 'no such access type')
      let tighten
      try { tighten = cleanTighten(body.tighten) } catch (err) { throw new HttpError(400, err.message) }
      const grant = await store.putGrant({ room, account, typeId: type.id, tighten, grantedBy: me })
      return { grant: await grantView(store, grant) }
    }],

    ['DELETE', /^\/v1\/sessions\/([^/]+)\/grants\/([^/]+)$/, async (req, body, [room, account]) => {
      await sessionOwner(store, person, req, room)
      await store.deleteGrant(room, account)
      return { ok: true }
    }]
  ]
}
```

Change `src/api/server.js`:

```diff
diff --git a/src/api/server.js b/src/api/server.js
index 9a1e144..3a6d61c 100644
--- a/src/api/server.js
+++ b/src/api/server.js
@@ -17,6 +17,7 @@ import { joinRoutes } from './routes/join.js'
 import { relayRoutes } from './routes/relay.js'
 import { sessionRoutes } from './routes/sessions.js'
 import { accessTypeRoutes } from './routes/access-types.js'
+import { grantRoutes } from './routes/grants.js'
 import { HOSTED_RELAY } from '../settings.js'
 
 const LINK_TTL_MS = 10 * 60 * 1000
@@ -226,7 +227,7 @@ export function startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, sit
 
   // Org routes live in their own modules and share the caller check and the limiter.
   const ctx = { store, user, person, bearer, now, site, apiUrl: api, mailer, log, limit: limitInvites, limitSend: limitInviteSend, limitTokens, limitJoin, agentAuth, relaySecret }
-  routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx), ...agentRoutes(ctx), ...agentInviteRoutes(ctx), ...joinRoutes(ctx), ...relayRoutes(ctx), ...sessionRoutes(ctx), ...accessTypeRoutes(ctx))
+  routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx), ...agentRoutes(ctx), ...agentInviteRoutes(ctx), ...joinRoutes(ctx), ...relayRoutes(ctx), ...sessionRoutes(ctx), ...accessTypeRoutes(ctx), ...grantRoutes(ctx))
 
   async function openLink (code) {
     const userCode = normalizeUserCode(code)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/api-grants.test.js`
Expected: PASS (4 tests).

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/access.js src/api/routes/grants.js src/api/server.js test/api-grants.test.js
git commit -m "Access types: session grants, set by the session's owner"
```

---

### Task 6: Inviting people and agents to a session

The owner invites anyone by email, or someone they've worked with, as an access type. The grant is made at once (keyed by the account, or by `email:<address>` until someone signs in with it). People get an email from hello@ with the session's link; agents get no email. The link is never stored, and a collaborator's email is never shown.

**Files:**
- Modify: `src/api/invite-email.js`
- Modify: `src/api/mailer.js`
- Create: `src/api/routes/session-invites.js`
- Modify: `src/api/routes/sessions.js`
- Modify: `src/api/server.js`
- Modify: `test/api-mailer.test.js`
- Create: `test/api-session-invites.test.js`

**Interfaces:**
- Consumes: `ownType`, `typeOfGrant` (Task 5); `sessionOwner`, `ACCOUNT` (Task 5); `parseInvite` (`src/ui/invite.js`); the store's invite and grant methods; `limitSend`, `mailer`, `site`, `log` from the route context.
- Produces:
  - `src/api/routes/sessions.js`: `overviewOf(store, account, tz, now)` and `collaboratorsOf(store, account, now): { account, name, kind, lastTogetherAt }[]` (the existing routes use them).
  - `src/api/invite-email.js`: `SESSION_INVITE_FROM = 'Quilt <hello@hq.heyquilt.com>'`, `sessionInviteEmail({ inviterName, sessionName, link, site }): { from, subject, text }`.
  - `src/api/mailer.js`: `send({ to, subject, text, from? })` (from falls back to `SMTP_FROM`).
  - `POST /v1/sessions/:room/invites` → `{ invite }`, `GET /v1/sessions/:room/invites` → `{ invites }`, `DELETE /v1/sessions/:room/invites/:id` → `{ ok: true }`. `InviteView = { id, email? | (account, name), typeId, typeName, status: 'waiting'|'used'|'cancelled'|'expired', createdAt, expiresAt }`. `SESSION_INVITE_TTL_MS` = 7 days.

- [ ] **Step 1: Write the failing tests**

Change `test/api-mailer.test.js` (a message can name its own sender):

```diff
diff --git a/test/api-mailer.test.js b/test/api-mailer.test.js
index 483e3f5..0461f1a 100644
--- a/test/api-mailer.test.js
+++ b/test/api-mailer.test.js
@@ -9,6 +9,13 @@ test('the SMTP mailer sends from SMTP_FROM with the message it is given', async
   assert.deepEqual(sent, [{ from: 'Quilt <invites@heyquilt.com>', to: 'a@acme.com', subject: 'Hi', text: 'Body' }])
 })
 
+test('a message can name its own sender', async () => {
+  const sent = []
+  const m = createSmtpMailer({ from: 'Quilt <invites@heyquilt.com>', transport: { sendMail: async (x) => { sent.push(x) } } })
+  await m.send({ to: 'a@acme.com', subject: 'Hi', text: 'Body', from: 'Quilt <hello@hq.heyquilt.com>' })
+  assert.equal(sent[0].from, 'Quilt <hello@hq.heyquilt.com>')
+})
+
 test('the SMTP mailer builds its transport from SMTP_URL without connecting', () => {
   const m = createSmtpMailer({ url: 'smtp://user:pass@127.0.0.1:2525', from: 'x@quilt.test' })
   assert.equal(typeof m.send, 'function')
```

Create `test/api-session-invites.test.js`:

```js
// Session invites: the owner invites anyone by email, or people and agents they've
// worked with, as an access type. The grant is made at once; the link only goes into
// the email; a person's email is never shown.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startTestApi } from './api-helpers.js'

let t
let clock = Date.parse('2026-10-02T12:00:00Z')
before(async () => { t = await startTestApi({ now: () => clock }) })
after(() => t.close())
const DAY = 24 * 60 * 60 * 1000
let rooms = 0
const start = (room, account, name, extra = {}) => ({ id: crypto.randomUUID(), type: 'start', room, account, name, at: clock - 60000, ...extra })

/** A session owned by Mo, where Lin and the agent Larry worked with him before. */
async function session () {
  const room = `inv-${++rooms}`
  const old = `old-${rooms}`
  await t.store.ingestPresence([
    start(old, 'person:mem', 'Mo', { owner: true }), start(old, 'person:lim', 'Lin'), start(old, 'agent:a1', 'Larry'),
    start(room, 'person:mem', 'Mo', { owner: true }),
    { id: crypto.randomUUID(), type: 'name', room, name: 'Pricing page', at: clock - 60000 }
  ], clock)
  return room
}
const link = (room) => `https://join.heyquilt.com/${room}#the-room-secret`
const invite = (room, body, userId = 'mem') => t.call('POST', `/v1/sessions/${room}/invites`, { link: link(room), typeId: 'builtin:edit', ...body }, userId)
const grants = async (room) => (await t.call('GET', `/v1/sessions/${room}/grants`, null, 'mem')).body.grants.map((g) => [g.account, g.typeName])

test('an email invite makes a grant for the address and sends the link from hello@', async () => {
  const room = await session()
  t.sent.length = 0
  const res = await invite(room, { to: { email: ' Pat@Example.com ' }, typeId: 'builtin:view' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual({ ...res.body.invite, id: 'x', createdAt: 0 }, { id: 'x', email: 'pat@example.com', typeId: 'builtin:view', typeName: 'View only', status: 'waiting', createdAt: 0, expiresAt: clock + 7 * DAY })
  assert.deepEqual(await grants(room), [['email:pat@example.com', 'View only']])
  assert.equal(t.sent.length, 1)
  const [mail] = t.sent
  assert.equal(mail.to, 'pat@example.com')
  assert.equal(mail.from, 'Quilt <hello@hq.heyquilt.com>')
  assert.equal(mail.subject, 'Mo invited you to Pricing page on Quilt')
  for (const line of [`Join the session: ${link(room)}`, 'This invite expires in 7 days.', 'New to Quilt? Download the app from https://quilt.test, sign in with this email address, then open the link again.']) assert.ok(mail.text.includes(line), line)
  assert.doesNotMatch(mail.subject + mail.text, /—/)
  const again = await invite(room, { to: { email: 'pat@example.com' } })
  assert.deepEqual([again.status, again.body.error], [409, 'That address already has an open invite. Cancel it first.'])
  assert.ok(!JSON.stringify((await t.call('GET', `/v1/sessions/${room}/invites`, null, 'mem')).body).includes('the-room-secret'), 'the link is never kept')
})

test("inviting someone you've worked with emails them, but never shows their email", async () => {
  const room = await session()
  t.sent.length = 0
  const res = await invite(room, { to: { account: 'person:lim' } })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual([res.body.invite.account, res.body.invite.name, res.body.invite.email], ['person:lim', 'Lin', undefined])
  assert.equal(t.sent[0].to, 'lin@acme.com')
  const list = await t.call('GET', `/v1/sessions/${room}/invites`, null, 'mem')
  assert.ok(!JSON.stringify(list.body).includes('lin@acme.com'))
  assert.deepEqual(await grants(room), [['person:lim', 'Can edit']])
})

test('an agent you worked with gets a grant and no email', async () => {
  const room = await session()
  t.sent.length = 0
  const res = await invite(room, { to: { account: 'agent:a1' }, typeId: 'builtin:view' })
  assert.deepEqual([res.status, res.body.invite.name], [200, 'Larry'])
  assert.equal(t.sent.length, 0)
  assert.deepEqual(await grants(room), [['agent:a1', 'View only']])
})

test('only the owner invites, only people they worked with or by email, and only with this session\'s link', async () => {
  const room = await session()
  const notOwner = await invite(room, { to: { email: 'x@y.com' } }, 'lim')
  assert.deepEqual([notOwner.status, notOwner.body.error], [403, 'Only the session owner can invite people.'])
  const stranger = await invite(room, { to: { account: 'person:out' } })
  assert.deepEqual([stranger.status, stranger.body.error], [404, "You can invite people you've worked with, or anyone by email."])
  assert.equal((await invite(room, { to: { account: 'person:mem' } })).body.error, "That's you.")
  assert.equal((await invite(room, { to: { email: 'a@b.c,d@e.f' } })).body.error, "That email doesn't look right.")
  assert.equal((await t.call('POST', `/v1/sessions/${room}/invites`, { to: { email: 'x@y.com' }, typeId: 'builtin:edit', link: link('another-room') }, 'mem')).body.error, "Send this session's invite link.")
  assert.equal((await invite(room, { to: { email: 'x@y.com' }, typeId: 'nope' })).body.error, 'no such access type')
  assert.equal((await invite(room, { to: {} })).status, 400)
})

test('cancelling takes back the grant; used and expired invites show as such', async () => {
  const room = await session()
  const a = (await invite(room, { to: { email: 'pat@example.com' } })).body.invite
  const b = (await invite(room, { to: { account: 'agent:a1' } })).body.invite
  assert.deepEqual((await t.call('DELETE', `/v1/sessions/${room}/invites/${a.id}`, null, 'mem')).body, { ok: true })
  assert.equal((await t.call('DELETE', `/v1/sessions/${room}/invites/${a.id}`, null, 'mem')).status, 409)
  assert.equal((await t.call('DELETE', `/v1/sessions/${room}/invites/not-an-id`, null, 'mem')).status, 404)
  assert.deepEqual(await grants(room), [['agent:a1', 'Can edit']])
  clock += 8 * DAY
  try {
    const list = (await t.call('GET', `/v1/sessions/${room}/invites`, null, 'mem')).body.invites
    assert.deepEqual(list.map((i) => [i.id, i.status]).sort(), [[a.id, 'cancelled'], [b.id, 'expired']].sort())
  } finally { clock -= 8 * DAY }
})

test('a failed email keeps the invite and says what to do', async () => {
  const room = await session()
  // The test mailer keeps what it sends in t.sent; make it fail instead.
  const send = t.sent.push
  t.sent.push = () => { throw new Error('smtp down') }
  try {
    const res = await invite(room, { to: { email: 'pat@example.com' } })
    assert.deepEqual([res.status, res.body.error], [502, "The invite was saved, but the email didn't send. Cancel it and invite them again."])
  } finally { t.sent.push = send }
  assert.equal((await t.call('GET', `/v1/sessions/${room}/invites`, null, 'mem')).body.invites.length, 1)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/api-session-invites.test.js test/api-mailer.test.js`
Expected: FAIL: 404 for the invite routes, and the mailer still sends from `SMTP_FROM`.

- [ ] **Step 3: Implement**

Change `src/api/invite-email.js`:

```diff
diff --git a/src/api/invite-email.js b/src/api/invite-email.js
index b90c928..180261f 100644
--- a/src/api/invite-email.js
+++ b/src/api/invite-email.js
@@ -1,4 +1,4 @@
-// The one email the accounts API sends itself: an org invite.
+// The emails the accounts API sends itself: org invites and session invites.
 export function inviteEmail ({ orgName, inviterName, roleName, link }) {
   const who = inviterName || 'Someone'
   return {
@@ -13,3 +13,25 @@ export function inviteEmail ({ orgName, inviterName, roleName, link }) {
     ].join('\n')
   }
 }
+
+// Session invites come from a person-to-person address, not the invites@ one.
+export const SESSION_INVITE_FROM = 'Quilt <hello@hq.heyquilt.com>'
+
+/** An invite to one session. `link` is the session's join link (it holds the room secret); `site` is heyquilt.com. */
+export function sessionInviteEmail ({ inviterName, sessionName, link, site }) {
+  const who = inviterName || 'Someone'
+  return {
+    from: SESSION_INVITE_FROM,
+    subject: `${who} invited you to ${sessionName} on Quilt`,
+    text: [
+      `${who} invited you to ${sessionName}, a live Quilt session where people and their AIs build one project together.`,
+      '',
+      `Join the session: ${link}`,
+      '',
+      'This invite expires in 7 days.',
+      '',
+      `New to Quilt? Download the app from ${site}, sign in with this email address, then open the link again.`,
+      "If you weren't expecting this, you can ignore this email."
+    ].join('\n')
+  }
+}
```

Change `src/api/mailer.js`:

```diff
diff --git a/src/api/mailer.js b/src/api/mailer.js
index 4d2f9d1..dd2fba7 100644
--- a/src/api/mailer.js
+++ b/src/api/mailer.js
@@ -37,7 +37,8 @@ function parseSmtpUrl (raw) {
 
 export function createSmtpMailer ({ url, from, transport, createTransport = nodemailer.createTransport }) {
   const t = transport || createTransport(parseSmtpUrl(url))
-  return { send: ({ to, subject, text }) => t.sendMail({ from, to, subject, text }) }
+  // A message may name its own sender (session invites come from hello@); otherwise SMTP_FROM.
+  return { send: ({ to, subject, text, from: sender }) => t.sendMail({ from: sender || from, to, subject, text }) }
 }
 
 // `quilt api --memory` prints emails instead, so invite links can be copied from the terminal.
```

Create `src/api/routes/session-invites.js`:

```js
// Inviting people and agents to a session, as an access type: by email, or someone the
// owner has worked with. The grant is made up front (keyed by the account, or by the
// email until someone signs in with it), so they get straight in. The invite link holds
// the room secret: it only passes through here into the email, and is never stored.
import { HttpError, UUID, stripInvisible } from '../http.js'
import { emailDomain } from '../domains.js'
import { sessionInviteEmail } from '../invite-email.js'
import { parseInvite } from '../../ui/invite.js'
import { ownType, typeOfGrant } from '../access.js'
import { sessionOwner, ACCOUNT } from './grants.js'
import { collaboratorsOf } from './sessions.js'

export const SESSION_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const FORBIDDEN = 'Only the session owner can invite people.'
// One address, nothing a mail header could split (the same rule as org invites).
const STRICT_EMAIL = /^[^\s@,;<>"()\\]+@[^\s@,;<>"()\\]+$/

export function sessionInviteRoutes ({ store, person, now, site, mailer, log, limitSend }) {
  const statusOf = (i) => (i.usedAt ? 'used' : i.cancelledAt ? 'cancelled' : i.expiresAt <= now() ? 'expired' : 'waiting')
  const open = (i) => statusOf(i) === 'waiting'
  // An account invite shows the name the owner saw, never the person's email.
  async function view (i) {
    const type = await typeOfGrant(store, { typeId: i.typeId })
    return { id: i.id, ...(i.email ? { email: i.email } : { account: i.account, name: i.accountName }), typeId: type.id, typeName: type.name, status: statusOf(i), createdAt: i.createdAt, expiresAt: i.expiresAt }
  }

  function cleanEmail (raw) {
    const email = String(raw || '').trim().toLowerCase()
    if (!email || email.length > 254 || !STRICT_EMAIL.test(email) || !emailDomain(email)) throw new HttpError(400, "That email doesn't look right.")
    return email
  }

  async function send (to, { userId, session, link }) {
    const inviter = await store.profile(userId)
    const inviterName = stripInvisible(inviter?.name || '').join('').trim() || undefined
    const msg = sessionInviteEmail({ inviterName, sessionName: session.name || 'Untitled session', link, site })
    try {
      await mailer.send({ to, ...msg })
    } catch (err) {
      log(`session invite email failed: ${err?.stack || err?.message || err}`)
      throw new HttpError(502, "The invite was saved, but the email didn't send. Cancel it and invite them again.")
    }
  }

  return [
    ['GET', /^\/v1\/sessions\/([^/]+)\/invites$/, async (req, body, [room]) => {
      await sessionOwner(store, person, req, room, FORBIDDEN)
      return { invites: await Promise.all((await store.listSessionInvites(room)).map(view)) }
    }],

    ['POST', /^\/v1\/sessions\/([^/]+)\/invites$/, async (req, body, [room]) => {
      const owner = await sessionOwner(store, person, req, room, FORBIDDEN)
      limitSend(owner.userId)
      const type = await ownType(store, owner.me, body.typeId)
      if (!type) throw new HttpError(400, 'no such access type')
      let inv = null
      try { inv = parseInvite(body.link, { allowRelay: () => true }) } catch {}
      if (!inv || inv.room !== room) throw new HttpError(400, "Send this session's invite link.")
      const link = String(body.link).trim()
      const to = body.to && typeof body.to === 'object' ? body.to : {}
      const invites = await store.listSessionInvites(room)

      if (to.email !== undefined) {
        const email = cleanEmail(to.email)
        if (invites.some((i) => i.email === email && open(i))) throw new HttpError(409, 'That address already has an open invite. Cancel it first.')
        await store.putGrant({ room, account: `email:${email}`, typeId: type.id, grantedBy: owner.me })
        const invite = await store.createSessionInvite({ room, email, typeId: type.id, invitedBy: owner.me, expiresAt: now() + SESSION_INVITE_TTL_MS })
        await send(email, { ...owner, link })
        return { invite: await view(invite) }
      }

      const account = String(to.account || '')
      if (!ACCOUNT.test(account)) throw new HttpError(400, 'Invite someone by email, or someone you have worked with.')
      if (account === owner.me) throw new HttpError(400, "That's you.")
      const who = (await collaboratorsOf(store, owner.me, now())).find((c) => c.account === account)
      if (!who) throw new HttpError(404, "You can invite people you've worked with, or anyone by email.")
      if (invites.some((i) => i.account === account && open(i))) throw new HttpError(409, 'They already have an open invite. Cancel it first.')
      await store.putGrant({ room, account, typeId: type.id, grantedBy: owner.me })
      const invite = await store.createSessionInvite({ room, account, accountName: who.name, typeId: type.id, invitedBy: owner.me, expiresAt: now() + SESSION_INVITE_TTL_MS })
      // A person hears about it at their sign-in email (looked up here, never sent back). An
      // agent has no email: its grant just lets it straight in.
      if (who.kind === 'person') {
        const mail = await store.userEmail(account.slice('person:'.length))
        if (mail?.confirmed && mail.email) await send(mail.email, { ...owner, link })
      }
      return { invite: await view(invite) }
    }],

    // Cancelling also takes back the grant the invite made, unless someone already used it.
    ['DELETE', /^\/v1\/sessions\/([^/]+)\/invites\/([^/]+)$/, async (req, body, [room, id]) => {
      await sessionOwner(store, person, req, room, FORBIDDEN)
      const invite = UUID.test(id) ? await store.sessionInviteById(room, id) : null
      if (!invite) throw new HttpError(404, 'no such invite')
      if (!await store.cancelSessionInvite(invite.id)) throw new HttpError(409, 'That invite was already used or cancelled.')
      const key = invite.email ? `email:${invite.email}` : invite.account
      const stillOpen = (await store.listSessionInvites(room)).some((i) => i.id !== invite.id && (i.email ? `email:${i.email}` : i.account) === key && open(i))
      if (!stillOpen) await store.deleteGrant(room, key)
      return { ok: true }
    }]
  ]
}
```

Change `src/api/routes/sessions.js`:

```diff
diff --git a/src/api/routes/sessions.js b/src/api/routes/sessions.js
index c5aec0b..4433f97 100644
--- a/src/api/routes/sessions.js
+++ b/src/api/routes/sessions.js
@@ -8,6 +8,20 @@ import { cleanSessionName, BAD_SESSION_NAME } from '../../session-name.js'
 const ROOM = /^[A-Za-z0-9_-]{1,64}$/
 const NO_SESSION = 'no such session'
 
+/** An account's dashboard: its sessions, with the people in each, and the totals. */
+export async function overviewOf (store, account, tz, t) {
+  // The latest sessions, plus every one active this week or month, for the totals.
+  const since = Math.min(weekStart(t, tz), monthStart(t, tz))
+  const sessions = await store.accountSessions(account, { since, limit: MAX_SESSIONS })
+  const visits = await store.visitsInRooms(sessions.map((s) => s.room))
+  return summarize({ me: account, sessions, visits, now: t, tz })
+}
+
+/** People and agents this account has worked with: [{ account, name, kind, lastTogetherAt }], most recent first. */
+export async function collaboratorsOf (store, account, t) {
+  return collaborators((await overviewOf(store, account, 'UTC', t)).sessions)
+}
+
 export function sessionRoutes ({ store, now, person }) {
   const me = async (req) => `person:${(await person(req)).userId}`
   const zoneOf = (req) => {
@@ -15,15 +29,7 @@ export function sessionRoutes ({ store, now, person }) {
     if (!isTimeZone(tz)) throw new HttpError(400, 'tz must be an IANA time zone, like Europe/London')
     return tz
   }
-
-  async function overview (account, tz) {
-    const t = now()
-    // The latest sessions, plus every one active this week or month, for the totals.
-    const since = Math.min(weekStart(t, tz), monthStart(t, tz))
-    const sessions = await store.accountSessions(account, { since, limit: MAX_SESSIONS })
-    const visits = await store.visitsInRooms(sessions.map((s) => s.room))
-    return summarize({ me: account, sessions, visits, now: t, tz })
-  }
+  const overview = (account, tz) => overviewOf(store, account, tz, now())
 
   /** A session I was in, with every visit to it; 404 otherwise, whether or not it exists. */
   async function mine (account, room) {
@@ -56,9 +62,6 @@ export function sessionRoutes ({ store, now, person }) {
     }],
 
     // People and agents you've worked with, for invites (most recent first, at most 30).
-    ['GET', /^\/v1\/me\/collaborators$/, async (req) => {
-      const { sessions } = await overview(await me(req), 'UTC')
-      return { collaborators: collaborators(sessions) }
-    }]
+    ['GET', /^\/v1\/me\/collaborators$/, async (req) => ({ collaborators: await collaboratorsOf(store, await me(req), now()) })]
   ]
 }
```

Change `src/api/server.js`:

```diff
diff --git a/src/api/server.js b/src/api/server.js
index 3a6d61c..5f2d6ec 100644
--- a/src/api/server.js
+++ b/src/api/server.js
@@ -18,6 +18,7 @@ import { relayRoutes } from './routes/relay.js'
 import { sessionRoutes } from './routes/sessions.js'
 import { accessTypeRoutes } from './routes/access-types.js'
 import { grantRoutes } from './routes/grants.js'
+import { sessionInviteRoutes } from './routes/session-invites.js'
 import { HOSTED_RELAY } from '../settings.js'
 
 const LINK_TTL_MS = 10 * 60 * 1000
@@ -227,7 +228,7 @@ export function startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, sit
 
   // Org routes live in their own modules and share the caller check and the limiter.
   const ctx = { store, user, person, bearer, now, site, apiUrl: api, mailer, log, limit: limitInvites, limitSend: limitInviteSend, limitTokens, limitJoin, agentAuth, relaySecret }
-  routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx), ...agentRoutes(ctx), ...agentInviteRoutes(ctx), ...joinRoutes(ctx), ...relayRoutes(ctx), ...sessionRoutes(ctx), ...accessTypeRoutes(ctx), ...grantRoutes(ctx))
+  routes.push(...orgRoutes(ctx), ...memberRoutes(ctx), ...teamRoutes(ctx), ...inviteRoutes(ctx), ...agentRoutes(ctx), ...agentInviteRoutes(ctx), ...joinRoutes(ctx), ...relayRoutes(ctx), ...sessionRoutes(ctx), ...accessTypeRoutes(ctx), ...grantRoutes(ctx), ...sessionInviteRoutes(ctx))
 
   async function openLink (code) {
     const userCode = normalizeUserCode(code)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/api-session-invites.test.js test/api-mailer.test.js test/api-sessions.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/invite-email.js src/api/mailer.js src/api/routes/session-invites.js src/api/routes/sessions.js src/api/server.js test/api-mailer.test.js test/api-session-invites.test.js
git commit -m "Access types: invite people and agents to a session, by email or from people you've worked with"
```

---

### Task 7: Room passes

`POST /v1/passes { room }` signs what the holder may do there into the pass: the owner's access, their grant's, or `null`. For a person it adds their confirmed email, and that email's open invite to the room becomes their grant now.

**Files:**
- Modify: `src/api/access.js`
- Modify: `src/api/server.js`
- Create: `test/api-room-passes.test.js`

**Interfaces:**
- Consumes: `roomAccess` (new here), store `sessionByRoom`, `claimEmailInvites`, `grantFor`, `useAccountInvites`, `userEmail`.
- Produces:
  - `src/api/access.js`: `OWNER_ACCESS`, `roomAccess(store, room, account, email?): Access | OWNER_ACCESS | null`.
  - `src/api/server.js`: `mintPass(holder, room?)` (internal; Task 11 uses it), and `POST /v1/passes` taking `{ room }` (400 `room must be a session name`). A room pass payload adds `{ room, iat, access, email? }`.

- [ ] **Step 1: Write the failing test**

Create `test/api-room-passes.test.js`:

```js
// Passes for one room carry what their holder may do there: the owner's access, their
// grant's, or nothing yet. An email invite turns into a grant on the invited person's
// first room pass.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startTestApi, makeAgent, linkDevice } from './api-helpers.js'
import { newPassKeys, verifyPass } from '../src/passes.js'
import { generateIdentity } from '../src/identity.js'

const KEYS = newPassKeys()
let t
before(async () => { t = await startTestApi({ passKey: KEYS.privateKey }) })
after(() => t.close())
let rooms = 0
async function session (owner = 'mem') {
  const room = `rp-${++rooms}`
  await t.store.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room, account: `person:${owner}`, name: 'Owner', owner: true, at: Date.now() }], Date.now())
  return room
}
async function roomPass (bearer, room) {
  const r = await t.call('POST', '/v1/passes', room === undefined ? {} : { room }, null, { authorization: `Bearer ${bearer}` })
  return r.status === 200 ? verifyPass(r.body.pass, KEYS.publicKey) : r
}

test("the owner's room pass says so, with the room, when it was issued and their email", async () => {
  const room = await session('mem')
  const { token } = await linkDevice(t, 'mem')
  const p = await roomPass(token, room)
  assert.deepEqual([p.room, p.email, p.access], [room, 'mo@acme.com', { owner: true, files: 'edit', folders: [], foldersExcept: [], talk: true }])
  assert.ok(p.iat <= Date.now() && p.exp - p.iat === 10 * 60 * 1000)
  const plain = await roomPass(token, undefined)
  assert.deepEqual(Object.keys(plain).sort(), ['exp', 'key', 'kind', 'name', 'sub', 'v'], 'without a room, a pass is as before')
})

test('a grant comes through as access; no grant is null; an unknown session is null', async () => {
  const room = await session('mem')
  const { token } = await linkDevice(t, 'lim')
  assert.equal((await roomPass(token, room)).access, null, 'not let in yet')
  await t.call('PUT', `/v1/sessions/${room}/grants/person:lim`, { typeId: 'builtin:edit', tighten: { foldersRemove: ['secrets'], talk: false } }, 'mem')
  assert.deepEqual((await roomPass(token, room)).access, { files: 'edit', folders: [], foldersExcept: ['secrets'], talk: false })
  assert.equal((await roomPass(token, 'never-reported')).access, null)
  assert.equal((await roomPass(token, 'bad room')).status, 400)
})

test('an agent has no email in its pass, and its grant applies', async () => {
  const room = await session('mem')
  const identity = generateIdentity()
  const { agent, accessKey } = await makeAgent(t, { name: 'Larry', publicKey: identity.publicKey, ownerUserId: 'mem' })
  await t.call('PUT', `/v1/sessions/${room}/grants/agent:${agent.id}`, { typeId: 'builtin:view' }, 'mem')
  const p = await roomPass(accessKey, room)
  assert.equal(p.email, undefined)
  assert.equal(p.access.files, 'view')
})

test('an email invite lets in whoever signs in with that confirmed email, once', async () => {
  const room = await session('mem')
  const link = `https://join.heyquilt.com/${room}#s`
  await t.call('POST', `/v1/sessions/${room}/invites`, { to: { email: 'Lin@acme.com' }, typeId: 'builtin:view', link }, 'mem')
  await t.call('POST', `/v1/sessions/${room}/invites`, { to: { email: 'una@acme.com' }, typeId: 'builtin:edit', link }, 'mem')
  const lin = await linkDevice(t, 'lim')
  assert.equal((await roomPass(lin.token, room)).access.files, 'view')
  const [invite] = (await t.call('GET', `/v1/sessions/${room}/invites`, null, 'mem')).body.invites.filter((i) => i.email === 'lin@acme.com')
  assert.equal(invite.status, 'used')
  const grants = (await t.call('GET', `/v1/sessions/${room}/grants`, null, 'mem')).body.grants.map((g) => g.account)
  assert.deepEqual(grants.sort(), ['email:una@acme.com', 'person:lim'])
  const una = await linkDevice(t, 'unconf')
  assert.equal((await roomPass(una.token, room)).access, null, "Una hasn't confirmed her email, so it can't be hers yet")
})

test('an account invite is marked used when its account first gets a room pass', async () => {
  const room = await session('admin')
  // Ada and Otto worked together a minute ago, so she may invite him by account.
  const before = Date.now() - 60000
  await t.store.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room: 'shared-before', account: 'person:admin', name: 'Ada', owner: true, at: before }, { id: crypto.randomUUID(), type: 'start', room: 'shared-before', account: 'person:out', name: 'Otto', at: before }], Date.now())
  await t.call('POST', `/v1/sessions/${room}/invites`, { to: { account: 'person:out' }, typeId: 'builtin:edit', link: `https://join.heyquilt.com/${room}#s` }, 'admin')
  const { token } = await linkDevice(t, 'out')
  assert.equal((await roomPass(token, room)).access.files, 'edit')
  assert.deepEqual((await t.call('GET', `/v1/sessions/${room}/invites`, null, 'admin')).body.invites.map((i) => i.status), ['used'])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/api-room-passes.test.js`
Expected: FAIL: the passes have no `room` or `access` (`Cannot read properties of undefined (reading 'files')`).

- [ ] **Step 3: Implement**

Change `src/api/access.js`:

```diff
diff --git a/src/api/access.js b/src/api/access.js
index c35e555..22bbf8b 100644
--- a/src/api/access.js
+++ b/src/api/access.js
@@ -3,6 +3,10 @@
 import { UUID } from './http.js'
 import { builtinType, effectiveAccess, FALLBACK_TYPE } from '../session-access.js'
 
+// The owner's access, as a pass carries it. The relay keeps its own record of who owns a
+// room; this only says the API agrees.
+export const OWNER_ACCESS = Object.freeze({ owner: true, files: 'edit', folders: Object.freeze([]), foldersExcept: Object.freeze([]), talk: true })
+
 /** A built-in, or one of `ownerAccount`'s own types; null otherwise (someone else's, or none). */
 export async function ownType (store, ownerAccount, typeId) {
   const id = String(typeId || '')
@@ -23,3 +27,19 @@ export async function grantView (store, grant) {
   const type = await typeOfGrant(store, grant)
   return { account: grant.account, typeId: type.id, typeName: type.name, tighten: grant.tighten || {}, access: effectiveAccess(type, grant.tighten), updatedAt: grant.updatedAt }
 }
+
+/**
+ * What `account` may do in `room`, for its pass: the owner's access, its grant's, or null
+ * (no grant: the owner lets them in, or not). `email` is a person's confirmed sign-in
+ * address: an open invite to it becomes their grant now, and the invite is used.
+ */
+export async function roomAccess (store, room, account, email = '') {
+  const session = await store.sessionByRoom(room)
+  if (!session) return null
+  if (session.ownerAccount === account) return OWNER_ACCESS
+  if (email) await store.claimEmailInvites(room, email.toLowerCase(), account)
+  const grant = await store.grantFor(room, account)
+  if (!grant) return null
+  await store.useAccountInvites(room, account)
+  return effectiveAccess(await typeOfGrant(store, grant), grant.tighten)
+}
```

Change `src/api/server.js`:

```diff
diff --git a/src/api/server.js b/src/api/server.js
index 5f2d6ec..22fb333 100644
--- a/src/api/server.js
+++ b/src/api/server.js
@@ -20,8 +20,10 @@ import { accessTypeRoutes } from './routes/access-types.js'
 import { grantRoutes } from './routes/grants.js'
 import { sessionInviteRoutes } from './routes/session-invites.js'
 import { HOSTED_RELAY } from '../settings.js'
+import { roomAccess } from './access.js'
 
 const LINK_TTL_MS = 10 * 60 * 1000
+const ROOM = /^[A-Za-z0-9_-]{1,64}$/
 // An approved link the app never collects stops working this long after its code expires.
 const COLLECT_GRACE_MS = 5 * 60 * 1000
 const POLL_INTERVAL_S = 3
@@ -106,6 +108,23 @@ export function startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, sit
 
   const needPassKey = () => { if (!passKey) throw new HttpError(503, 'passes are not set up on this server') }
 
+  /**
+   * A signed pass for `holder`. For a room, it also carries the room, when it was issued
+   * (the relay won't let an older pass undo a removal), what its holder may do there
+   * (see access.js), and a person's confirmed email.
+   */
+  async function mintPass (holder, room) {
+    const iat = now()
+    const exp = iat + PASS_TTL_MS
+    const payload = { v: PASS_VERSION, ...holder, exp }
+    if (room) {
+      const mail = holder.kind === 'person' ? await store.userEmail(holder.sub) : null
+      const email = mail?.confirmed ? String(mail.email || '').toLowerCase() : ''
+      Object.assign(payload, { room, iat, access: await roomAccess(store, room, `${holder.kind}:${holder.sub}`, email) }, email ? { email } : {})
+    }
+    return { pass: signPass(payload, passKey), expiresAt: exp }
+  }
+
   /** A person's profile and sign-in email, which the app keeps in account.json. */
   async function profileWithEmail (userId) {
     const p = await store.profile(userId)
@@ -203,12 +222,13 @@ export function startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, sit
     }],
 
     // A pass lets its holder into sessions on the relay for 10 minutes (see src/passes.js).
-    ['POST', /^\/v1\/passes$/, async (req) => {
+    // With { room }, it is for that room only and carries what its holder may do there.
+    ['POST', /^\/v1\/passes$/, async (req, body) => {
       needPassKey()
       const holder = await passHolder(req)
       limitPasses(hashToken(bearer(req)))
-      const exp = now() + PASS_TTL_MS
-      return { pass: signPass({ v: PASS_VERSION, ...holder, exp }, passKey), expiresAt: exp }
+      if (body.room !== undefined && !ROOM.test(String(body.room))) throw new HttpError(400, 'room must be a session name')
+      return mintPass(holder, body.room)
     }],
 
     // The relay's QUILT_PASS_PUBLIC_KEY. Public: it only checks passes.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/api-room-passes.test.js test/api-passes.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/access.js src/api/server.js test/api-room-passes.test.js
git commit -m "Access types: room passes carry the room, its access and the person's email"
```

---

### Task 8: The relay lets people in by their room pass's grant

A pass for this room with a grant admits its holder at once, with that access, and puts them on the member list. A fresh pass (`MSG_PASS`) applies its grant live, and lets in someone who was waiting. Exceptions (`scopesExcept`) are enforced with the rest. A pass for another room is refused, and the owner's visit is reported to the API at once so it can give out access straight away.

**Files:**
- Modify: `src/passes.js`
- Modify: `src/server.js` (imports, `accessFor`, `passGrant`, `noteGranted`, `passRenewed`, `letIn`, `hostedAccess`, `mayWrite`, `accessMessage`, `setAccess`, `memberList`, `admit`, `enter`, `renewPass`, the upgrade and HTTP pass checks)
- Modify: `test/pass-helpers.js`
- Modify: `test/passes.test.js`
- Create: `test/relay-grants.test.js`
- Modify: `test/relay-presence.test.js`

**Interfaces:**
- Consumes: `cleanAccess`, `narrowAccess`, `relayAccess`, `fromRelay`, `sameAccess`, `mayChange` (Task 1); `PASS_TTL_MS`.
- Produces:
  - `verifyPass` refuses a pass whose `room` isn't a session name.
  - `Room#passGrant(pass): Access | null` (null for another room, no grant, or removed since it was issued; narrowed by a later owner change), `Room#noteGranted(id, name, kind, access)`, `Room#passRenewed(ws)`. `accessFor(..., pass)` takes the connection's pass.
  - `MSG_ACCESS` and member-list entries now carry `scopesExcept` and `talk`.
  - `test/pass-helpers.js`: `makePass({ ..., ...extra })` signs extra fields (`room`, `access`, `iat`).

- [ ] **Step 1: Write the failing tests**

Change `test/pass-helpers.js` (`makePass` signs any extra fields):

```diff
diff --git a/test/pass-helpers.js b/test/pass-helpers.js
index b7342e9..d15446f 100644
--- a/test/pass-helpers.js
+++ b/test/pass-helpers.js
@@ -5,9 +5,9 @@ import { PassSource } from '../src/pass-source.js'
 
 export const PASS_KEYS = newPassKeys()
 
-/** A pass for `identity`, like the API would sign it (any field can be overridden). */
-export function makePass ({ identity, name = 'Dana', kind = 'person', sub = 'user-dana', exp = Date.now() + PASS_TTL_MS, v = 1, keys = PASS_KEYS }) {
-  return signPass({ v, sub, kind, name, key: identity.publicKey, exp }, keys.privateKey)
+/** A pass for `identity`, like the API would sign it (any field can be overridden; others, like room and access, are added). */
+export function makePass ({ identity, name = 'Dana', kind = 'person', sub = 'user-dana', exp = Date.now() + PASS_TTL_MS, v = 1, keys = PASS_KEYS, ...extra }) {
+  return signPass({ v, sub, kind, name, key: identity.publicKey, exp, ...extra }, keys.privateKey)
 }
 
 /** Passes made locally for `identity`, the way the API would hand them out. */
```

Change `test/passes.test.js` (a new test at the end):

```diff
diff --git a/test/passes.test.js b/test/passes.test.js
index fb60668..5df925d 100644
--- a/test/passes.test.js
+++ b/test/passes.test.js
@@ -45,3 +45,9 @@ test('a pass with no key is a valid HTTP-only pass; a pass with a bad key is not
   const bad = signPass({ v: 1, sub: 'agent-1', kind: 'agent', name: 'Grok-Bot', key: 'not-a-key', exp }, keys.privateKey)
   assert.equal(verifyPass(bad, keys.publicKey), null)
 })
+
+test('a room pass names its room as a session name, and keeps its access and email', () => {
+  const room = fields({ room: 'room-1', iat: Date.now(), access: { files: 'view', folders: [], foldersExcept: [], talk: false }, email: 'dana@acme.com' })
+  assert.deepEqual(verifyPass(signPass(room, keys.privateKey), keys.publicKey), room)
+  for (const bad of ['', 'a room', '../x', 7]) assert.equal(verifyPass(signPass(fields({ room: bad }), keys.privateKey), keys.publicKey), null, JSON.stringify(bad))
+})
```

Create `test/relay-grants.test.js`:

```js
// The relay with room passes: a pass for one room carries what its holder may do there
// (their grant, from the accounts API). A grant lets them straight in with that access,
// a fresh pass changes it live, and the relay enforces view, folders and exceptions.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity, signChallenge } from '../src/identity.js'
import { MSG_AUTH, MSG_ACCESS, MSG_MEMBERS, MSG_PASS, MSG_ADMIN, decoding, bytesMessage, jsonMessage } from '../src/protocol.js'
import { PASS_KEYS, makePass, testPasses } from './pass-helpers.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-rg-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-rg-${n}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 6000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
const EDIT_ALL = { files: 'edit', folders: [], foldersExcept: [], talk: true }

let srv, server
const sessions = []
before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  server = `ws://127.0.0.1:${srv.port}`
})
after(async () => {
  for (const s of sessions) await s.stop().catch(() => {})
  await srv.close()
})

let rooms = 0
/** A session with an owner (Olive) and a few files; `join` brings someone in with a room pass. */
async function ownedRoom () {
  const room = `rg-${++rooms}`
  const ownerDir = tmp('owner')
  write(ownerDir, 'README.md', 'hello\n')
  write(ownerDir, 'src/app.js', 'app\n')
  write(ownerDir, 'secrets/key.txt', 'k\n')
  const id = generateIdentity()
  const owner = new Session({ dir: ownerDir, server, room, secret: 'edit', viewSecret: 'view', name: 'Olive', identity: id, passes: testPasses(id, { name: 'Olive', sub: 'olive' }) })
  sessions.push(owner)
  await owner.start({ waitTimeoutMs: 5000 })
  await waitFor(() => owner.isOwner)
  const join = async (name, access, { secret = 'view' } = {}) => {
    const dir = tmp(name)
    const me = generateIdentity()
    const s = new Session({ dir, server, room, secret, name, identity: me, passes: testPasses(me, { name, sub: name, room, access }) })
    sessions.push(s)
    await s.start({ waitTimeoutMs: 5000 })
    return { s, dir }
  }
  return { room, owner, ownerDir, join }
}

/** A bare connection (see relay-passes.test.js): resolves once the relay says where it stands. */
function connect (r, { identity = generateIdentity(), pass, secret = 'view' } = {}) {
  const q = new URLSearchParams({ name: 'x', key: identity.publicKey, kind: 'human', features: 'large-files' })
  const ws = new WebSocket(`${server}/${r}?${q}`, { headers: { 'x-quilt-secret': secret, ...(pass ? { 'x-quilt-pass': pass } : {}) } })
  ws.binaryType = 'arraybuffer'
  const c = { ws, identity, access: [], members: [] }
  return new Promise((resolve) => {
    ws.on('unexpected-response', (req, res) => resolve({ status: res.statusCode }))
    ws.on('error', () => {})
    ws.on('message', (data) => {
      const dec = decoding.createDecoder(new Uint8Array(data))
      const type = decoding.readVarUint(dec)
      if (type === MSG_AUTH) ws.send(bytesMessage(MSG_AUTH, signChallenge(identity, r, decoding.readVarUint8Array(dec))))
      else if (type === MSG_ACCESS) { c.access.push(JSON.parse(decoding.readVarString(dec))); resolve(c) } else if (type === MSG_MEMBERS) c.members.push(JSON.parse(decoding.readVarString(dec)))
    })
  })
}
const last = (c) => c.access[c.access.length - 1]

test('a grant in the pass lets you straight in, with its access, and the owner sees you on the list', async () => {
  const { owner, join } = await ownedRoom()
  const { s: sam } = await join('sam', { ...EDIT_ALL, foldersExcept: ['secrets'] })
  await waitFor(() => sam.access && sam.access.state === 'approved')
  assert.deepEqual([sam.access.role, sam.access.scopes, sam.access.scopesExcept, sam.access.talk], ['editor', [], ['secrets'], true])
  assert.equal(owner.waiting.length, 0, 'no prompt for the owner')
  const m = await waitFor(() => owner.members.find((x) => x.key === 'person:sam'))
  assert.deepEqual([m.name, m.role, m.scopesExcept], ['sam', 'editor', ['secrets']])
})

test('the relay enforces exceptions, folders and view-only from the pass', async () => {
  const { ownerDir, join } = await ownedRoom()
  const { s: sam, dir: samDir } = await join('sam', { ...EDIT_ALL, foldersExcept: ['secrets'] })
  await waitFor(() => read(samDir, 'secrets/key.txt') === 'k\n')
  sam.doc.transact(() => sam.files.get('secrets/key.txt').insert(0, 'EVIL '))
  await waitFor(() => sam.files.get('secrets/key.txt').toString() === 'k\n')
  sam.doc.transact(() => sam.files.get('src/app.js').insert(0, 'ok '))
  await waitFor(() => read(ownerDir, 'src/app.js') === 'ok app\n')
  assert.equal(read(ownerDir, 'secrets/key.txt'), 'k\n', 'the owner never saw it')

  const { s: bot, dir: botDir } = await join('bot', { ...EDIT_ALL, folders: ['src'] })
  await waitFor(() => read(botDir, 'README.md') === 'hello\n')
  bot.doc.transact(() => bot.files.get('README.md').insert(0, 'sneaky '))
  await waitFor(() => bot.files.get('README.md').toString() === 'hello\n')

  const { s: vic, dir: vicDir } = await join('vic', { ...EDIT_ALL, files: 'view' }, { secret: 'edit' })
  await waitFor(() => read(vicDir, 'README.md') === 'hello\n')
  assert.equal(vic.access.role, 'viewer', 'the pass, not the edit secret, decides')
  vic.doc.transact(() => vic.files.get('src/app.js').insert(0, 'EVIL '))
  await waitFor(() => vic.files.get('src/app.js').toString() === 'ok app\n')
  await wait(150)
  assert.equal(read(ownerDir, 'README.md'), 'hello\n')
  assert.equal(read(ownerDir, 'src/app.js'), 'ok app\n')
})

test('a pass for another room is refused, on the socket and over HTTP', async () => {
  const { room } = await ownedRoom()
  const identity = generateIdentity()
  const other = makePass({ identity, sub: 'sam', room: 'some-other-room', access: EDIT_ALL })
  assert.equal((await connect(room, { identity, pass: other })).status, 401)
  const res = await fetch(`http://127.0.0.1:${srv.port}/files/${room}`, { method: 'POST', headers: { 'x-quilt-secret': 'edit', 'x-quilt-pass': other }, body: 'hi' })
  assert.equal(res.status, 401)
})

test('without a grant you wait for the owner; a fresh pass with one lets you in', async () => {
  const { room, owner } = await ownedRoom()
  const identity = generateIdentity()
  const c = await connect(room, { identity, pass: makePass({ identity, sub: 'pat', name: 'Pat', room, access: null }) })
  assert.equal(last(c).state, 'pending')
  await waitFor(() => owner.waiting.some((p) => p.key === 'person:pat'))
  c.ws.send(jsonMessage(MSG_PASS, { pass: makePass({ identity, sub: 'pat', name: 'Pat', room, access: { ...EDIT_ALL, talk: false } }) }))
  await waitFor(() => last(c).state === 'approved')
  assert.deepEqual([last(c).role, last(c).talk], ['editor', false])
  await waitFor(() => !owner.waiting.length && owner.members.some((m) => m.key === 'person:pat'))
  c.ws.close()
})

test('a fresh pass changes access live; one for another room is ignored', async () => {
  const { room } = await ownedRoom()
  const identity = generateIdentity()
  const pass = (access, extra = {}) => makePass({ identity, sub: 'kim', name: 'Kim', room, access, ...extra })
  const c = await connect(room, { identity, pass: pass(EDIT_ALL) })
  assert.equal(last(c).role, 'editor')
  c.ws.send(jsonMessage(MSG_PASS, { pass: pass({ ...EDIT_ALL, files: 'view' }) }))
  await waitFor(() => last(c).role === 'viewer')
  c.ws.send(jsonMessage(MSG_PASS, { pass: pass(EDIT_ALL, { room: 'elsewhere' }) }))
  await wait(150)
  assert.equal(last(c).role, 'viewer')
  assert.equal(srv.rooms.get(room).meta.members['person:kim'].role, 'viewer', 'kept for the member list')
  c.ws.close()
})

test("a pass's grant wins over a role the owner gave before access types", async () => {
  const { room } = await ownedRoom()
  const identity = generateIdentity()
  const first = await connect(room, { identity, pass: makePass({ identity, sub: 'lee', name: 'Lee', room, access: null }) })
  assert.equal(last(first).state, 'pending')
  // The owner's older app approves Lee as a viewer (no access types).
  const rm = srv.rooms.get(room)
  const ownerWs = [...rm.access].find(([, a]) => a.owner)[0]
  rm.handle(ownerWs, jsonMessage(MSG_ADMIN, { id: 'a1', op: 'approve', key: 'person:lee', role: 'viewer' }))
  await waitFor(() => last(first).state === 'approved')
  assert.equal(last(first).role, 'viewer')
  first.ws.close()
  // Lee comes back with a room pass whose grant says edit: the pass wins.
  const again = await connect(room, { identity, pass: makePass({ identity, sub: 'lee', name: 'Lee', room, access: EDIT_ALL }) })
  assert.equal(last(again).role, 'editor')
  again.ws.close()
  // And with no grant at all, the role the owner gave still holds.
  const plain = await connect(room, { identity, pass: makePass({ identity, sub: 'lee', name: 'Lee', room, access: null }) })
  assert.equal(last(plain).role, 'editor', 'the last access the relay saw')
  plain.ws.close()
})
```

Change `test/relay-presence.test.js` (a new test: the owner's visit is reported at once):

```diff
diff --git a/test/relay-presence.test.js b/test/relay-presence.test.js
index 7f7f2f9..0996ddd 100644
--- a/test/relay-presence.test.js
+++ b/test/relay-presence.test.js
@@ -103,6 +103,14 @@ test('an account let in starts a visit, and leaving ends it', async (t) => {
   assert.equal(api.events[2].start, api.events[1].id)
 })
 
+test("the owner's visit reaches the accounts API at once, so they can give people access straight away", async (t) => {
+  const api = collector()
+  const srv = await relay(t, { presenceOptions: { fetch: api.fetch, flushMs: 60 * 60 * 1000 } })
+  const r = room()
+  await connect(srv, r, { ...as('Olive', 'user-olive'), viewSecret: 'v' })
+  await waitFor(() => api.events.some((e) => e.type === 'start' && e.owner && e.room === r))
+})
+
 test('someone waiting for the owner records nothing, and nothing if they are turned away', async (t) => {
   const api = collector()
   const srv = await relay(t, { presenceOptions: { fetch: api.fetch } })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/relay-grants.test.js test/passes.test.js test/relay-presence.test.js`
Expected: FAIL: the granted sessions time out waiting to be let in, a pass with a bad `room` verifies, and the owner's visit isn't reported until the minute.

- [ ] **Step 3: Implement**

Change `src/passes.js`:

```diff
diff --git a/src/passes.js b/src/passes.js
index 933d7d8..4241cc0 100644
--- a/src/passes.js
+++ b/src/passes.js
@@ -10,6 +10,7 @@ export const PASS_VERSION = 1
 export const PASS_TTL_MS = 10 * 60 * 1000
 const MAX_NAME = 64
 const KINDS = ['person', 'agent']
+const ROOM = /^[A-Za-z0-9_-]{1,64}$/
 
 /** A new signing pair, encoded like identity keys: SPKI and PKCS8 DER, in base64url. */
 export function newPassKeys () {
@@ -55,6 +56,8 @@ export function verifyPass (pass, key, { now = Date.now() } = {}) {
   if (typeof p.exp !== 'number' || p.exp <= now) return null
   if (typeof p.sub !== 'string' || !p.sub || !KINDS.includes(p.kind)) return null
   if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > MAX_NAME) return null
+  // A room pass is good in that room only (see access in session-access.js).
+  if (p.room !== undefined && (typeof p.room !== 'string' || !ROOM.test(p.room))) return null
   // No key: an HTTP-only pass (a hosted agent, see relay-mcp.js); it can't open a WebSocket.
   if (typeof p.key !== 'string' || (p.key && !parsePublicKey(p.key))) return null
   return p
```

Change `src/server.js` (imports, `accessFor`, `passGrant`, `noteGranted`, `passRenewed`, `letIn`, `hostedAccess`, `mayWrite`, `accessMessage`, `setAccess`, `memberList`, `admit`, `enter`, `renewPass`, the upgrade and HTTP pass checks):

```diff
diff --git a/src/server.js b/src/server.js
index 17a8b44..8fa7d53 100644
--- a/src/server.js
+++ b/src/server.js
@@ -29,8 +29,9 @@ import {
   syncStep1Message, updateMessage, awarenessMessage, bytesMessage, jsonMessage
 } from './protocol.js'
 import { parsePublicKey, verifyChallenge } from './identity.js'
-import { verifyPass } from './passes.js'
-import { patternsOverlap, globMatcher } from './fsutil.js'
+import { verifyPass, PASS_TTL_MS } from './passes.js'
+import { cleanAccess, narrowAccess, relayAccess, fromRelay, sameAccess, mayChange } from './session-access.js'
+import { patternsOverlap } from './fsutil.js'
 import { adoptLegacyEnv } from './legacy.js'
 import { makeStore, DiskStore } from './blobstore.js'
 import { JOIN_HOST } from './ui/invite.js'
@@ -194,7 +195,7 @@ class Room {
    * for the owner. `account` is '<kind>:<sub>' from their pass when sign-in is
    * on: then they are their account, on any computer, not their key.
    */
-  accessFor (key, name, kind, invitedAs, account = '') {
+  accessFor (key, name, kind, invitedAs, account = '', pass = null) {
     if (!this.controlled) return { state: 'approved', role: 'editor', scopes: [], owner: false }
     if (!this.meta.owner) {
       // The room's creator becomes its owner when they sign in, and nobody else, however much
@@ -212,16 +213,74 @@ class Room {
       }
       return { state: 'approved', role: 'editor', scopes: [], owner: true }
     }
+    // A room pass with a grant (from the accounts API) lets them straight in, with its access.
+    const granted = this.passGrant(pass)
+    if (granted) {
+      this.noteGranted(account, name, kind, granted)
+      return { state: 'approved', ...relayAccess(granted), owner: false, id: account }
+    }
     // Members approved with a pass are kept under their account; older ones under their key.
     const id = account && this.meta.members[account] ? account : key
     const m = this.meta.members[id]
     if (m) {
       if (m.name !== name || m.kind !== kind) { m.name = name; m.kind = kind; this.saveMeta() }
-      return { state: 'approved', role: m.role, scopes: m.scopes || [], owner: false, id }
+      return { state: 'approved', ...memberAccess(m), owner: false, id }
     }
     return { state: 'pending', invitedAs }
   }
 
+  /**
+   * What a pass for this room lets its holder do here (the grant the accounts API signed
+   * into it), or null: no pass for this room, no grant, or the owner removed them after it
+   * was issued. An owner's narrowing made after it was issued still applies.
+   */
+  passGrant (pass) {
+    if (!pass || pass.room !== this.name) return null
+    const access = cleanAccess(pass.access)
+    if (!access) return null
+    const account = `${pass.kind}:${pass.sub}`
+    const issued = typeof pass.iat === 'number' ? pass.iat : pass.exp - PASS_TTL_MS
+    const removedAt = (this.meta.removed || {})[account]
+    if (removedAt && issued <= removedAt) return null
+    const m = this.meta.members[account]
+    if (m && m.setAt && issued <= m.setAt) return narrowAccess(access, fromRelay(m))
+    return access
+  }
+
+  /** Keeps someone let in by their pass's grant on the member list, with that access. */
+  noteGranted (id, name, kind, access) {
+    const m = this.meta.members[id]
+    if (m && m.name === name && m.kind === kind && sameAccess(fromRelay(m), access)) return
+    this.meta.members[id] = { ...(m || {}), name, kind, ...relayAccess(access), since: m?.since || Date.now(), granted: true }
+    this.saveMeta()
+  }
+
+  /**
+   * A fresh pass arrived (see renewPass): its grant applies now. Someone waiting is let in,
+   * and someone in the room gets the new access, both without the owner.
+   */
+  passRenewed (ws) {
+    const granted = this.passGrant(ws.pass)
+    if (!granted) return
+    const id = `${ws.pass.kind}:${ws.pass.sub}`
+    if (this.meta.ownerSub === id) return
+    const waiting = this.pending.get(ws)
+    if (waiting) {
+      this.pending.delete(ws)
+      this.noteGranted(id, waiting.name, waiting.kind, granted)
+      this.log(`[${this.name}] ${waiting.name} was let in by their invite`)
+      this.enter(ws, { key: waiting.key, id, name: waiting.name, kind: waiting.kind, ...relayAccess(granted), owner: false })
+      return
+    }
+    const a = this.access.get(ws)
+    if (!a || a.owner || sameAccess(fromRelay(a), granted)) return
+    this.noteGranted(id, a.name, a.kind, granted)
+    Object.assign(a, relayAccess(granted))
+    this.setAccess(ws, a)
+    send(ws, jsonMessage(MSG_ACCESS, this.accessMessage(a)))
+    this.broadcastMembers()
+  }
+
   /**
    * Remembers which computer keys an account has used here, so removing the
    * account also removes members approved by one of those keys.
@@ -249,6 +308,7 @@ class Room {
     if (!this.controlled) return true
     const account = `${pass.kind}:${pass.sub}`
     if (this.meta.owner && this.isOwner(pass.key, account)) return true
+    if (this.passGrant(pass)) return true
     return !!(this.meta.members[account] || this.meta.members[pass.key])
   }
 
@@ -281,7 +341,7 @@ class Room {
     const m = this.meta.members[id]
     if (m) {
       if (m.name !== pass.name) { m.name = pass.name; this.saveMeta() }
-      return { state: 'approved', role: m.role, scopes: m.scopes || [], owner: false, id }
+      return { state: 'approved', ...memberAccess(m), owner: false, id }
     }
     return { state: 'pending', id }
   }
@@ -315,10 +375,7 @@ class Room {
   }
 
   /** May this connection change this file? */
-  mayWrite (a, rel) {
-    if (!a || a.role === 'viewer') return false
-    return !a.scopes || !a.scopes.length || a.scopes.some((s) => globMatcher(s)(rel))
-  }
+  mayWrite (a, rel) { return mayChange(a, rel) }
 
   /**
    * A restricted member (viewer, or agent limited to folders) changed the doc.
@@ -389,13 +446,13 @@ class Room {
   }
 
   accessMessage (a) {
-    return { state: 'approved', role: a.role, scopes: a.scopes || [], owner: !!a.owner, controlled: this.controlled }
+    return { state: 'approved', role: a.role, scopes: a.scopes || [], scopesExcept: a.scopesExcept || [], talk: a.talk !== false, owner: !!a.owner, controlled: this.controlled }
   }
 
   /** Tracks restricted connections so their file changes are checked. */
   setAccess (ws, a) {
     this.access.set(ws, a)
-    const restricted = a.role === 'viewer' || (a.scopes && a.scopes.length)
+    const restricted = a.role === 'viewer' || (a.scopes && a.scopes.length) || (a.scopesExcept && a.scopesExcept.length) || a.talk === false
     if (restricted) this.guard.trackedOrigins.add(ws)
     else this.guard.trackedOrigins.delete(ws)
   }
@@ -409,7 +466,7 @@ class Room {
       const ownerName = this.meta.ownerName || Object.entries(this.meta.identities).find(([, k]) => k === this.meta.owner)?.[0] || 'owner'
       list.push({ key: this.ownerId, name: ownerName, kind: 'human', role: 'owner', scopes: [], online: online.has(this.ownerId) })
     }
-    for (const [key, m] of Object.entries(this.meta.members)) list.push({ key, name: m.name, kind: m.kind, role: m.role, scopes: m.scopes || [], online: online.has(key) })
+    for (const [key, m] of Object.entries(this.meta.members)) list.push({ key, name: m.name, kind: m.kind, ...memberAccess(m), online: online.has(key) })
     return list
   }
 
@@ -664,6 +721,7 @@ class Room {
       // (MSG_PASS is under 128, so it is the whole first byte.)
       if (ws.pass && buf[0] === MSG_PASS) {
         if (!renewPass(ws, buf)) this.log(`[${this.name}] ignored a pass refresh from ${name} that wasn't theirs`)
+        else this.passRenewed(ws)
         return
       }
       if (joined || this.access.has(ws)) {
@@ -689,7 +747,7 @@ class Room {
         if (!this.keyMatches(name, publicKey)) return ws.close(CLOSE_NAME_TAKEN, nameTaken(name))
         this.bindName(name, publicKey)
       }
-      const acc = this.accessFor(publicKey, name, kind, invitedAs, account)
+      const acc = this.accessFor(publicKey, name, kind, invitedAs, account, ws.pass)
       if (acc.state === 'pending') {
         waiting = true
         this.pending.set(ws, { key: publicKey, id: account || publicKey, name, kind, invitedAs, since: Date.now() })
@@ -700,7 +758,7 @@ class Room {
         return
       }
       joined = true
-      this.enter(ws, { key: publicKey, id: acc.id || account || publicKey, name, kind, role: acc.role, scopes: acc.scopes, owner: acc.owner })
+      this.enter(ws, { key: publicKey, id: acc.id || account || publicKey, name, kind, role: acc.role, scopes: acc.scopes, scopesExcept: acc.scopesExcept || [], talk: acc.talk !== false, owner: acc.owner })
       onJoin()
     })
     ws.on('close', () => {
@@ -714,7 +772,12 @@ class Room {
   enter (ws, a) {
     this.setAccess(ws, a)
     // Presence: an account's visit starts once it's let in (never while it waits for the owner).
-    if (ws.pass && this.presence && !ws.visit) ws.visit = this.presence.visitStart({ room: this.name, account: `${ws.pass.kind}:${ws.pass.sub}`, name: a.name, owner: !!a.owner })
+    if (ws.pass && this.presence && !ws.visit) {
+      ws.visit = this.presence.visitStart({ room: this.name, account: `${ws.pass.kind}:${ws.pass.sub}`, name: a.name, owner: !!a.owner })
+      // The accounts API learns who owns a session from this report, and only the owner may
+      // give people access there: tell it now rather than within the minute.
+      if (a.owner) this.presence.tick().catch(() => {})
+    }
     send(ws, jsonMessage(MSG_ACCESS, this.accessMessage(a)))
     this.join(ws, a.name)
     this.broadcastMembers()
@@ -820,6 +883,9 @@ class Room {
 
 const nameTaken = (name) => `The name "${name}" belongs to someone else in this room; pick another name`
 
+/** A saved member's access, in the relay's shape (members saved before access types may talk and have no exceptions). */
+const memberAccess = (m) => ({ role: m.role, scopes: m.scopes || [], scopesExcept: m.scopesExcept || [], talk: m.talk !== false })
+
 /** Closes the connection when its pass runs out, unless a newer one arrives first. */
 function trackPass (ws, pass) {
   ws.pass = pass
@@ -836,7 +902,7 @@ function renewPass (ws, buf) {
     decoding.readVarUint(dec)
     next = verifyPass(String(JSON.parse(decoding.readVarString(dec)).pass || ''), ws.passKey)
   } catch {}
-  if (!next || next.sub !== ws.pass.sub || next.kind !== ws.pass.kind || next.key !== ws.pass.key) return false
+  if (!next || next.sub !== ws.pass.sub || next.kind !== ws.pass.kind || next.key !== ws.pass.key || next.room !== ws.pass.room) return false
   trackPass(ws, next)
   return true
 }
@@ -850,7 +916,12 @@ export function startServer ({ port = 4321, host = '0.0.0.0', dataDir = null, lo
   const passKey = cfg.passPublicKey ? parsePublicKey(cfg.passPublicKey) : null
   if (cfg.passPublicKey && !passKey) throw new Error('QUILT_PASS_PUBLIC_KEY is not an Ed25519 public key (spki, base64url)')
   /** With sign-in on: the request's valid pass, or null. With it off: an empty pass. */
-  const httpPass = (req) => passKey ? verifyPass(String(req.headers['x-quilt-pass'] || ''), passKey) : {}
+  const httpPass = (req, room = '') => {
+    if (!passKey) return {}
+    const p = verifyPass(String(req.headers['x-quilt-pass'] || ''), passKey)
+    // A room pass is good in its own room only.
+    return p && (!p.room || !room || p.room === room) ? p : null
+  }
   // Who a new session counts against: their account with sign-in on, otherwise their address.
   const starterOf = (pass, req) => pass && pass.sub ? `${pass.kind}:${pass.sub}` : clientIp(req)
   // Without sign-in the limit is per address, and the message says so (as before).
@@ -1052,6 +1123,7 @@ export function startServer ({ port = 4321, host = '0.0.0.0', dataDir = null, lo
         if (err) return text(400, err.message)
         const { token, room: roomName, secret, name, tool } = body || {}
         if (!TOKEN_RE.test(String(token)) || !ROOM_RE.test(String(roomName)) || typeof name !== 'string' || !name.trim()) return text(400, 'bad link')
+        if (pass.room && pass.room !== roomName) return text(401, SIGN_IN)
         if (roomEnded(roomName)) return text(410, ENDED_MESSAGE)
         const room = getRoom(roomName)
         if (!room) return text(...refused(roomName))
@@ -1109,7 +1181,7 @@ export function startServer ({ port = 4321, host = '0.0.0.0', dataDir = null, lo
         return receiveBlob(req, file, Number(n), (err) => err ? text(err.code || 500, err.message) : text(201, 'stored'))
       }
       if (req.method !== 'POST') return text(405, 'method not allowed')
-      const pass = httpPass(req)
+      const pass = httpPass(req, name)
       if (!pass) return text(401, SIGN_IN)
       const starter = starterOf(pass, req)
       const room = getRoom(name)
@@ -1153,7 +1225,7 @@ export function startServer ({ port = 4321, host = '0.0.0.0', dataDir = null, lo
 
     const [, name, id] = m
     if (roomEnded(name)) return text(410, ENDED_MESSAGE)
-    const pass = httpPass(req)
+    const pass = httpPass(req, name)
     if (!pass) return text(401, SIGN_IN)
     const starter = starterOf(pass, req)
     const room = getRoom(name)
@@ -1202,7 +1274,7 @@ export function startServer ({ port = 4321, host = '0.0.0.0', dataDir = null, lo
     if (!ROOM_RE.test(name)) return reject(socket, 400, 'Bad room name')
     // With sign-in on, nobody gets further without a pass, and who they are comes from it.
     const pass = passKey ? verifyPass(header('x-quilt-pass') || url.searchParams.get('pass') || '', passKey) : null
-    if (passKey && (!pass || pass.key !== publicKey)) return reject(socket, 401, SIGN_IN)
+    if (passKey && (!pass || pass.key !== publicKey || (pass.room && pass.room !== name))) return reject(socket, 401, SIGN_IN)
     const person = pass ? pass.name : (url.searchParams.get('name') || '').trim()
     const kind = pass ? (pass.kind === 'agent' ? 'agent' : 'human') : (url.searchParams.get('kind') === 'agent' ? 'agent' : 'human')
     // People and agents come from different id spaces, so the kind is part of who they are.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/relay-grants.test.js test/passes.test.js test/relay-presence.test.js test/relay-passes.test.js test/access.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/passes.js src/server.js test/pass-helpers.js test/passes.test.js test/relay-grants.test.js test/relay-presence.test.js
git commit -m "Access types: the relay lets people in by their room pass's grant, and enforces exceptions"
```

---

### Task 9: No posting means no posting

For someone whose access says `talk: false`, the relay's guard now also covers `chat` and `agentFeed`: their additions are undone before anyone sees them, and they're told `you can't post in this session`. Their chat-file uploads are refused. Fixed on the way: the guard undoes exactly the refused change, so two refused changes that arrive together are both undone.

**Files:**
- Modify: `src/server.js`
- Create: `test/relay-talk.test.js`

**Interfaces:**
- Consumes: `TALK_REFUSED` (Task 1); `passGrant` (Task 8).
- Produces: `Room#httpAccess(pass)`, `Room#forget(item)`, `Room#recorded`; `POST /files/:room` answers 403 `You can't post in this session.` for `talk: false`; refusal access messages carry `refused: ['chat' | 'the feed', ...]` and `why: "you can't post in this session"`.

- [ ] **Step 1: Write the failing test**

Create `test/relay-talk.test.js`:

```js
// "May chat and post to the feed": someone whose access says no can still read and (if
// they may) edit, but the relay undoes their chat messages and feed entries, tells them
// why, and refuses the files they try to send in chat.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'
import { PASS_KEYS, makePass, testPasses } from './pass-helpers.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-rt-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-rt-${n}-`))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 6000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
const QUIET = { files: 'edit', folders: [], foldersExcept: [], talk: false }

let srv, server, owner, quiet, quietDir, quietId
const room = 'rt-1'
before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  server = `ws://127.0.0.1:${srv.port}`
  const oid = generateIdentity()
  const ownerDir = tmp('owner')
  fs.writeFileSync(path.join(ownerDir, 'README.md'), 'hello\n')
  owner = new Session({ dir: ownerDir, server, room, secret: 'e', viewSecret: 'v', name: 'Olive', identity: oid, passes: testPasses(oid, { name: 'Olive', sub: 'olive' }) })
  await owner.start({ waitTimeoutMs: 5000 })
  await waitFor(() => owner.isOwner)
  quietId = generateIdentity()
  quietDir = tmp('quiet')
  quiet = new Session({ dir: quietDir, server, room, secret: 'e', name: 'Quinn', identity: quietId, passes: testPasses(quietId, { name: 'Quinn', sub: 'quinn', room, access: QUIET }) })
  await quiet.start({ waitTimeoutMs: 5000 })
  await waitFor(() => quiet.access?.state === 'approved')
})
after(async () => { await quiet.stop(); await owner.stop(); await srv.close() })

test('their chat messages and feed entries are undone, and they are told why', async () => {
  assert.equal(quiet.access.talk, false)
  quiet.doc.transact(() => quiet.chat.push([{ id: 'm1', by: 'Quinn', to: null, text: 'psst', ts: Date.now() }]))
  quiet.doc.transact(() => quiet.agentFeed.push([{ id: 'f1', by: 'Quinn', kind: 'prompt', text: 'secret plan', ts: Date.now() }]))
  await waitFor(() => quiet.chat.length === 0 && quiet.agentFeed.length === 0)
  await wait(150)
  assert.equal(owner.chat.length, 0, 'the owner never saw the message')
  assert.equal(owner.agentFeed.length, 0)
  const rm = srv.rooms.get(room)
  assert.equal(rm.chat.length, 0)
  assert.deepEqual([quiet.access.why, quiet.access.refused], ["you can't post in this session", ['the feed']])
})

test('they can still change files their access allows', async () => {
  fs.writeFileSync(path.join(quietDir, 'notes.md'), 'from Quinn\n')
  await waitFor(() => owner.files.get('notes.md')?.toString() === 'from Quinn\n')
})

test('everyone else may still post', async () => {
  owner.say('hi Quinn')
  await waitFor(() => quiet.chat.toArray().some((m) => m.text === 'hi Quinn'))
})

test('a file sent in chat is refused', async () => {
  const pass = makePass({ identity: quietId, name: 'Quinn', sub: 'quinn', room, access: QUIET })
  const res = await fetch(`http://127.0.0.1:${srv.port}/files/${room}`, { method: 'POST', headers: { 'x-quilt-secret': 'e', 'x-quilt-pass': pass }, body: 'hi' })
  assert.deepEqual([res.status, await res.text()], [403, "You can't post in this session."])
  const ownerPass = makePass({ identity: owner.identity, name: 'Olive', sub: 'olive' })
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/files/${room}`, { method: 'POST', headers: { 'x-quilt-secret': 'e', 'x-quilt-pass': ownerPass }, body: 'hi' })).status, 201)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/relay-talk.test.js`
Expected: FAIL: the chat message reaches the relay (`timed out` waiting for it to be undone), and the chat file upload answers 201.

- [ ] **Step 3: Implement**

Change `src/server.js`:

```diff
diff --git a/src/server.js b/src/server.js
index 8fa7d53..10b0782 100644
--- a/src/server.js
+++ b/src/server.js
@@ -30,7 +30,7 @@ import {
 } from './protocol.js'
 import { parsePublicKey, verifyChallenge } from './identity.js'
 import { verifyPass, PASS_TTL_MS } from './passes.js'
-import { cleanAccess, narrowAccess, relayAccess, fromRelay, sameAccess, mayChange } from './session-access.js'
+import { cleanAccess, narrowAccess, relayAccess, fromRelay, sameAccess, mayChange, TALK_REFUSED } from './session-access.js'
 import { patternsOverlap } from './fsutil.js'
 import { adoptLegacyEnv } from './legacy.js'
 import { makeStore, DiskStore } from './blobstore.js'
@@ -129,10 +129,15 @@ class Room {
     this.files = this.doc.getMap('files')
     this.blobs = this.doc.getMap('blobs')
     this.fileKeys = this.doc.getMap('fileKeys')
-    // Undoes file changes from people who may not make them (viewers, and
-    // agents outside their folders). Only their connections are tracked.
-    this.guard = new Y.UndoManager([this.files, this.blobs, this.fileKeys], { trackedOrigins: new Set(), captureTimeout: 0 })
+    this.chat = this.doc.getArray('chat')
+    this.feed = this.doc.getArray('agentFeed')
+    // Undoes changes from people who may not make them: file changes from viewers and from
+    // people outside their folders, and posts from people who may not post. Only their
+    // connections are tracked.
+    this.guard = new Y.UndoManager([this.files, this.blobs, this.fileKeys, this.chat, this.feed], { trackedOrigins: new Set(), captureTimeout: 0 })
     this.undoing = null
+    this.recorded = null // the change the guard recorded last, for checkChange
+    this.guard.on('stack-item-added', ({ stackItem, type }) => { if (type === 'undo') this.recorded = stackItem })
     this.full = this.bytes > cfg.maxRoomBytes
     this.saveTimer = null
     this.unloadTimer = null
@@ -312,6 +317,16 @@ class Room {
     return !!(this.meta.members[account] || this.meta.members[pass.key])
   }
 
+  /** With sign-in on: the relay access a pass has here over HTTP (null for the owner, or nobody). */
+  httpAccess (pass) {
+    const account = `${pass.kind}:${pass.sub}`
+    if (!this.controlled || (this.meta.owner && this.isOwner(pass.key, account))) return null
+    const granted = this.passGrant(pass)
+    if (granted) return relayAccess(granted)
+    const m = this.meta.members[account] || this.meta.members[pass.key]
+    return m ? memberAccess(m) : null
+  }
+
   /** The id the member list shows the owner under. */
   get ownerId () { return this.meta.ownerSub || this.meta.owner }
 
@@ -387,7 +402,12 @@ class Room {
     const a = this.access.get(ws)
     const touched = new Set()
     const refused = []
+    const posts = [] // chat and the feed, for people who may not post
     for (const [type, events] of tr.changedParentTypes) {
+      if (type === this.chat || type === this.feed) {
+        if (a?.talk === false) posts.push(type === this.chat ? 'chat' : 'the feed')
+        continue
+      }
       if (type === this.fileKeys) {
         // Keys to stored files: viewers may not touch them, and others may
         // only add new ones, so nobody can lock people out of stored files.
@@ -408,26 +428,40 @@ class Room {
         }
       }
     }
-    refused.push(...[...touched].filter((rel) => !this.mayWrite(a, rel)))
-    if (!refused.length) { queueMicrotask(() => this.guard.clear()); return true }
+    refused.push(...[...touched].filter((rel) => !this.mayWrite(a, rel)), ...posts)
+    // The guard recorded this change just before this 'update' (its stack-item-added): only
+    // that one is kept or undone, never another change that arrived in the same moment.
+    const item = this.recorded
+    this.recorded = null
+    if (!refused.length) { this.forget(item); return true }
     this.log(`[${this.name}] undid ${a ? a.name : 'someone'}'s change to ${refused.slice(0, 3).join(', ')}${refused.length > 3 ? '…' : ''} (not allowed)`)
     queueMicrotask(() => {
       // Send the change and its undo as one update: nobody sees the change,
       // and nobody is left missing part of this person's history.
+      const others = this.guard.undoStack.filter((x) => x !== item)
+      this.guard.undoStack = item ? [item] : []
       this.undoing = []
       try { this.guard.undo() } finally {
+        this.guard.undoStack = others
+        this.guard.redoStack = []
         const merged = Y.mergeUpdates([update, ...this.undoing])
         this.undoing = null
         const msg = updateMessage(merged)
         for (const other of this.conns.keys()) send(other, msg)
       }
-      this.guard.clear()
-      const why = a && a.role === 'viewer' ? 'you can only view this session' : 'that is outside the folders you may change'
+      const why = posts.length === refused.length ? TALK_WHY
+        : a && a.role === 'viewer' ? 'you can only view this session' : 'that is outside the folders you may change'
       send(ws, jsonMessage(MSG_ACCESS, { ...this.accessMessage(a), refused: refused.slice(0, 20), why }))
     })
     return false
   }
 
+  /** An allowed change: the guard never needs to undo it. */
+  forget (item) {
+    const i = item ? this.guard.undoStack.indexOf(item) : -1
+    if (i >= 0) this.guard.undoStack.splice(i, 1)
+  }
+
   /** Can this connection's app handle the session as it is now? */
   supported (ws) {
     return !this.meta.largeFiles || (ws.features || []).includes('large-files')
@@ -881,6 +915,7 @@ class Room {
   }
 }
 
+const TALK_WHY = "you can't post in this session"
 const nameTaken = (name) => `The name "${name}" belongs to someone else in this room; pick another name`
 
 /** A saved member's access, in the relay's shape (members saved before access types may talk and have no exceptions). */
@@ -1244,6 +1279,11 @@ export function startServer ({ port = 4321, host = '0.0.0.0', dataDir = null, lo
     }
     const dir = path.join(filesDir, name)
     if (req.method === 'POST' && !id) {
+      // A chat file is a post: someone who may not post may not send one.
+      if (passKey && room.httpAccess(pass)?.talk === false) {
+        if (!room.conns.size && room.onEmpty) room.onEmpty()
+        return text(403, TALK_REFUSED)
+      }
       // Chat files and stored large files share one quota.
       const used = dirSize(dir) + storedBytes(room)
       const incoming = Number(req.headers['content-length'] || 0)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/relay-talk.test.js test/access.test.js test/relay-grants.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/relay-talk.test.js
git commit -m "Access types: the relay undoes posts from people who may not post, one change at a time"
```

---

### Task 10: The owner's controls: approve as a type, narrow live, remove

The owner's app approves someone as a type (the op carries the access it comes to), changes access with `set` (which, for someone with a grant, only narrows what their pass allows), and removes people so an older pass can't bring them back. After approve and set the relay asks the person's app for a fresh pass.

**Files:**
- Modify: `src/protocol.js` (the two message comments)
- Modify: `src/server.js`
- Create: `test/relay-owner-access.test.js`

**Interfaces:**
- Consumes: `cleanAccess`, `relayAccess`, `fromRelay` (Task 1); `passGrant` (Task 8).
- Produces: admin ops `{ op: 'approve', key, typeId?, access? }` and `{ op: 'set', key, access? }` (older `role`/`scopes` still work; bad `access` is refused with `bad access`); `MSG_ACCESS { ..., refresh: true }` to the person; `meta.members[id].setAt`; `meta.removed[account]` (the newest 200).

- [ ] **Step 1: Write the failing test**

Create `test/relay-owner-access.test.js`:

```js
// The owner's controls with access types: approving someone as a type (the app sends the
// access it comes to), narrowing a person's access live (never past what their pass
// allows), and removing someone so an older pass can't bring them back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { startServer } from '../src/server.js'
import { generateIdentity, signChallenge } from '../src/identity.js'
import { MSG_AUTH, MSG_ACCESS, MSG_ADMIN, MSG_MEMBERS, CLOSE_DENIED, decoding, bytesMessage, jsonMessage } from '../src/protocol.js'
import { PASS_KEYS, makePass } from './pass-helpers.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-roa-home-'))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}
const EDIT_ALL = { files: 'edit', folders: [], foldersExcept: [], talk: true }
let rooms = 0

async function relay (t) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  t.after(() => srv.close())
  return srv
}
function connect (srv, r, { identity = generateIdentity(), pass, viewSecret } = {}) {
  const q = new URLSearchParams({ name: 'x', key: identity.publicKey, kind: 'human', features: 'large-files' })
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/${r}?${q}`, { headers: { 'x-quilt-secret': 's', 'x-quilt-pass': pass, ...(viewSecret ? { 'x-quilt-view-secret': viewSecret } : {}) } })
  ws.binaryType = 'arraybuffer'
  const c = { ws, access: [], members: [] }
  c.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  return new Promise((resolve) => {
    ws.on('error', () => {})
    ws.on('message', (data) => {
      const dec = decoding.createDecoder(new Uint8Array(data))
      const type = decoding.readVarUint(dec)
      if (type === MSG_AUTH) ws.send(bytesMessage(MSG_AUTH, signChallenge(identity, r, decoding.readVarUint8Array(dec))))
      else if (type === MSG_ACCESS) { c.access.push(JSON.parse(decoding.readVarString(dec))); resolve(c) } else if (type === MSG_MEMBERS) c.members.push(JSON.parse(decoding.readVarString(dec)))
    })
  })
}
const last = (c) => c.access[c.access.length - 1]
let adminIds = 0
function admin (c, req) {
  const id = ++adminIds
  c.ws.send(jsonMessage(MSG_ADMIN, { id, ...req }))
  return waitFor(() => c.members.find((m) => m.reply && m.reply.id === id)?.reply)
}
/** A room with its owner connected, and a way to connect as someone with a room pass. */
async function ownedRoom (t) {
  const srv = await relay(t)
  const r = `roa-${++rooms}`
  const oid = generateIdentity()
  const owner = await connect(srv, r, { identity: oid, pass: makePass({ identity: oid, sub: 'olive', name: 'Olive' }), viewSecret: 'v' })
  assert.equal(last(owner).owner, true)
  const as = async (sub, access, extra = {}) => {
    const identity = extra.identity || generateIdentity()
    return connect(srv, r, { identity, pass: makePass({ identity, sub, name: sub, room: r, access, ...extra }) })
  }
  return { srv, r, owner, as }
}

test('approving with a type lets them in with the access it comes to, and asks their app for a fresh pass', async (t) => {
  const { srv, r, owner, as } = await ownedRoom(t)
  const sam = await as('sam', null)
  assert.equal(last(sam).state, 'pending')
  const reply = await admin(owner, { op: 'approve', key: 'person:sam', typeId: 'builtin:edit', access: { files: 'edit', folders: ['src'], foldersExcept: ['src/keys'], talk: false } })
  assert.equal(reply.ok, true)
  await waitFor(() => last(sam).state === 'approved' && last(sam).refresh)
  assert.deepEqual([last(sam).role, last(sam).scopes, last(sam).scopesExcept, last(sam).talk], ['editor', ['src'], ['src/keys'], false])
  const m = srv.rooms.get(r).meta.members['person:sam']
  assert.deepEqual([m.role, m.scopes, m.scopesExcept, m.talk], ['editor', ['src'], ['src/keys'], false])
  assert.equal((await admin(owner, { op: 'approve', key: 'person:nobody', access: { files: 'owner' } })).ok, false, 'bad access is refused')
})

test("the owner can narrow someone's access live, but never past what their pass allows", async (t) => {
  const { owner, as } = await ownedRoom(t)
  const identity = generateIdentity()
  const kim = await as('kim', { ...EDIT_ALL, folders: ['src'] }, { identity })
  assert.deepEqual(last(kim).scopes, ['src'])
  await admin(owner, { op: 'set', key: 'person:kim', access: EDIT_ALL })
  await waitFor(() => last(kim).refresh)
  assert.deepEqual([last(kim).role, last(kim).scopes], ['editor', ['src']], 'all folders asks for more than the pass allows')
  await admin(owner, { op: 'set', key: 'person:kim', access: { ...EDIT_ALL, folders: ['src'], talk: false } })
  await waitFor(() => last(kim).talk === false)
  // An older app's role change narrows the same way.
  await admin(owner, { op: 'set', key: 'person:kim', role: 'viewer' })
  await waitFor(() => last(kim).role === 'viewer')
  kim.ws.close()
  // Coming back with a pass issued before the change doesn't undo it...
  const back = await as('kim', { ...EDIT_ALL, folders: ['src'] }, { identity, iat: Date.now() - 60000 })
  assert.equal(last(back).role, 'viewer')
  back.ws.close()
  // ...but a newer pass from the API, which the owner's app updated, applies.
  const fresh = await as('kim', EDIT_ALL, { identity, iat: Date.now() + 1 })
  assert.deepEqual([last(fresh).role, last(fresh).scopes, last(fresh).talk], ['editor', [], true])
})

test('someone the owner let in before access types can still be given more', async (t) => {
  const { owner, as } = await ownedRoom(t)
  const lee = await as('lee', null)
  await admin(owner, { op: 'approve', key: 'person:lee', role: 'viewer' })
  await waitFor(() => last(lee).state === 'approved')
  await admin(owner, { op: 'set', key: 'person:lee', access: EDIT_ALL })
  await waitFor(() => last(lee).role === 'editor')
})

test('a removed person cannot come back with a pass issued before the removal', async (t) => {
  const { owner, as } = await ownedRoom(t)
  const identity = generateIdentity()
  const old = Date.now() - 1000
  const pat = await as('pat', EDIT_ALL, { identity, iat: old })
  assert.equal(last(pat).state, 'approved')
  await admin(owner, { op: 'remove', key: 'person:pat' })
  assert.equal(await pat.closed, CLOSE_DENIED)
  const again = await as('pat', EDIT_ALL, { identity, iat: old })
  assert.equal(last(again).state, 'pending', 'their old pass still says edit, but they were removed since')
  again.ws.close()
  const invited = await as('pat', EDIT_ALL, { identity, iat: Date.now() + 1 })
  assert.equal(last(invited).state, 'approved', 'the owner gave them a grant again')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/relay-owner-access.test.js`
Expected: FAIL: `approve` ignores `access` (the person is let in as an editor with no exceptions and no `refresh`), `set` widens past the pass, and a removed person comes back with their old pass.

- [ ] **Step 3: Implement**

Change `src/protocol.js` (the two message comments):

```diff
diff --git a/src/protocol.js b/src/protocol.js
index 149b4c6..540ee2f 100644
--- a/src/protocol.js
+++ b/src/protocol.js
@@ -12,8 +12,8 @@ export const MSG_QUERY_AWARENESS = 3
 export const MSG_AUTH = 10 // relay -> client: nonce; client -> relay: signature
 export const MSG_CLAIM = 11 // client -> relay: JSON { id, op: 'claim'|'release', pattern, note }
 export const MSG_CLAIMS = 12 // relay -> client: JSON { claims, reply?: { id, ok, error, released } }
-export const MSG_ACCESS = 13 // relay -> client: JSON { state: 'pending'|'approved', role, scopes, owner }
-export const MSG_ADMIN = 14 // client (owner) -> relay: JSON { id, op: 'approve'|'deny'|'set'|'remove'|'end'|'name', key, role, scopes, name }
+export const MSG_ACCESS = 13 // relay -> client: JSON { state: 'pending'|'approved', role, scopes, scopesExcept, talk, owner, refresh? }: refresh asks for a fresh pass now
+export const MSG_ADMIN = 14 // client (owner) -> relay: JSON { id, op: 'approve'|'deny'|'set'|'remove'|'end'|'name', key, role, scopes, typeId, access, name }
 export const MSG_MEMBERS = 15 // relay -> client: JSON { members, sessionName, pending?, reply?: { id, ok, error } }
 export const MSG_PASS = 16 // client -> relay: JSON { pass }: a fresh session pass, sent at least every 5 minutes
 
```

Change `src/server.js`:

```diff
diff --git a/src/server.js b/src/server.js
index 10b0782..b3afa72 100644
--- a/src/server.js
+++ b/src/server.js
@@ -46,6 +46,8 @@ const HOSTED_ONLINE_MS = 3 * 60 * 1000
 const RENAME_MS = 2000
 const MAX_PATTERN = 500
 const MAX_SCOPES = 20
+// Removed accounts remembered per room, so an older pass's grant can't bring them back.
+const MAX_REMOVED = 200
 const ROLES = ['editor', 'viewer']
 const MB = 1024 * 1024
 const DAY = 24 * 60 * 60 * 1000
@@ -553,20 +555,28 @@ class Room {
       ? req.scopes.map((s) => String(s).trim().replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean).slice(0, MAX_SCOPES)
       : null
     if (scopes && scopes.some((s) => s.length > MAX_PATTERN || s.split('/').includes('..'))) throw new Error('bad folder')
+    // Apps with access types send the access itself ({ files, folders, foldersExcept, talk }),
+    // and the type it came from (typeId), which the relay doesn't need: the API keeps grants.
+    const requested = req.access === undefined ? null : cleanAccess(req.access)
+    if (req.access !== undefined && !requested) throw new Error('bad access')
     if (key === this.meta.owner || key === this.meta.ownerSub) throw new Error('the owner always has full access')
     // `key` is the id from the member or pending list. One account may be waiting on several computers.
     const waiting = [...this.pending].filter(([, p]) => p.id === key)
     if (req.op === 'approve') {
       if (!waiting.length) throw new Error('nobody with that key is waiting')
       const p = waiting[0][1]
-      this.meta.members[key] = { name: p.name, kind: p.kind, role: role || p.invitedAs, scopes: scopes || [], since: Date.now() }
+      const access = requested ? relayAccess(requested) : { role: role || p.invitedAs, scopes: scopes || [], scopesExcept: [], talk: true }
+      this.meta.members[key] = { name: p.name, kind: p.kind, ...access, since: Date.now() }
+      if (this.meta.removed) delete this.meta.removed[key]
       this.saveMeta()
-      this.log(`[${this.name}] ${p.name} approved as ${this.meta.members[key].role}`)
+      this.log(`[${this.name}] ${p.name} approved as ${access.role}`)
       for (const [pws, w] of waiting) {
         this.pending.delete(pws)
         // A hosted agent has no connection to let in: it finds out on its next tool call.
         if (pws.hosted) continue
-        this.enter(pws, { key: w.key, id: key, name: w.name, kind: w.kind, role: this.meta.members[key].role, scopes: this.meta.members[key].scopes, owner: false })
+        this.enter(pws, { key: w.key, id: key, name: w.name, kind: w.kind, ...access, owner: false })
+        // Their app fetches a fresh pass now, so the grant the owner's app just wrote applies.
+        send(pws, jsonMessage(MSG_ACCESS, { ...this.accessMessage(this.access.get(pws)), refresh: true }))
       }
       return { ok: true }
     }
@@ -581,15 +591,17 @@ class Room {
     const m = this.meta.members[key]
     if (!m) throw new Error('no such member')
     if (req.op === 'set') {
-      if (role) m.role = role
-      if (scopes) m.scopes = scopes
+      const want = requested || { ...fromRelay(m), ...(role ? { files: role === 'viewer' ? 'view' : 'edit' } : {}), ...(scopes ? { folders: scopes } : {}) }
+      // Remembered with when, so a pass issued before now can't undo it (see passGrant).
+      Object.assign(m, relayAccess(want), { setAt: Date.now() })
       this.saveMeta()
       for (const [cws, a] of this.access) {
         if (a.id !== key) continue
-        a.role = m.role
-        a.scopes = m.scopes
+        // Someone let in by a grant gets what both their pass and the owner allow: the owner's
+        // app can narrow access at once, but more waits for a pass from the API that allows it.
+        Object.assign(a, relayAccess(this.passGrant(cws.pass) || want))
         this.setAccess(cws, a)
-        send(cws, jsonMessage(MSG_ACCESS, this.accessMessage(a)))
+        send(cws, jsonMessage(MSG_ACCESS, { ...this.accessMessage(a), refresh: true }))
       }
       return { ok: true }
     }
@@ -597,6 +609,9 @@ class Room {
       // An account goes with any older entries for keys it has used here, so it can't get back in by key.
       const gone = [key, ...((this.meta.accountKeys || {})[key] || [])]
       for (const id of gone) delete this.meta.members[id]
+      // A pass issued before now can't bring them back by its grant (see passGrant).
+      const removed = Object.entries({ ...(this.meta.removed || {}), [key]: Date.now() })
+      this.meta.removed = Object.fromEntries(removed.slice(-MAX_REMOVED))
       this.saveMeta()
       for (const [cws, a] of this.access) if (gone.includes(a.id)) cws.close(CLOSE_DENIED, 'The session owner removed you')
       for (const id of gone) this.hostedSeen.delete(id)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/relay-owner-access.test.js test/access.test.js test/relay-grants.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol.js src/server.js test/relay-owner-access.test.js
git commit -m "Access types: the owner approves as a type, narrows access live, and removal holds"
```

---

### Task 11: Hosted agents get their grant

Cloud agents have no WebSocket: the API's `/mcp` proxy signs their passes. It now signs a room pass for the room the agent is joining (from the `quilt_join_session` call) or is in (the relay says which in `x-quilt-room`), so the relay's `/mcp` lets a granted agent straight in and enforces its folders, exceptions and talk permission on the tools.

**Files:**
- Modify: `src/api/server.js`
- Modify: `src/relay-mcp.js`
- Modify: `src/server.js`
- Modify: `test/api-mcp.test.js`
- Modify: `test/relay-hosted-mcp.test.js`

**Interfaces:**
- Consumes: `mintPass` (Task 7); `passGrant`, `noteGranted` (Task 8); `changeRefusal`, `TALK_REFUSED` (Task 1); `parseInvite`.
- Produces: `joiningRoom(body: Buffer): string` exported from `src/api/server.js`; the relay's `/mcp` responses carry `x-quilt-room: <room>` while the agent is in one; `hostedAccess(pass)` approves by grant; `quilt_message` and `quilt_share` fail with `You can't post in this session.`; `quilt_write_file` fails with `You may not change files in <folder>.`

- [ ] **Step 1: Write the failing tests**

Change `test/api-mcp.test.js` (two new tests):

```diff
diff --git a/test/api-mcp.test.js b/test/api-mcp.test.js
index a7e8bef..b1de5bd 100644
--- a/test/api-mcp.test.js
+++ b/test/api-mcp.test.js
@@ -10,8 +10,10 @@ import { Client } from '@modelcontextprotocol/sdk/client/index.js'
 import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
 import { startTestApi, makeAgent } from './api-helpers.js'
 import { startServer } from '../src/server.js'
+import { joiningRoom } from '../src/api/server.js'
 import { Session } from '../src/session.js'
 import { generateIdentity } from '../src/identity.js'
+import crypto from 'node:crypto'
 import { newPassKeys } from '../src/passes.js'
 import { testPasses } from './pass-helpers.js'
 
@@ -73,3 +75,33 @@ test('a revoked agent is turned away at /mcp', async () => {
   await t.store.revokeAgent(agent.id)
   await assert.rejects(client(accessKey), /revoked/)
 })
+
+test('an agent the owner granted joins straight in through /mcp, and its grant holds for its later calls', async () => {
+  // Mo owns a session with an owner (a view secret); heyquilt.com knows he owns it.
+  const id = generateIdentity()
+  const moDir = tmp('mo')
+  const mo = new Session({ dir: moDir, server: `ws://127.0.0.1:${relay.port}`, room: 'am-2', secret: 's', viewSecret: 'v', name: 'Mo', identity: id, passes: testPasses(id, { keys, sub: 'mem', name: 'Mo' }) })
+  await mo.start({ waitTimeoutMs: 5000 })
+  await t.store.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room: 'am-2', account: 'person:mem', name: 'Mo', owner: true, at: Date.now() }], Date.now())
+  const { agent, accessKey } = await makeAgent(t, { name: 'Gem', ownerUserId: 'mem' })
+  const granted = await t.call('PUT', `/v1/sessions/am-2/grants/agent:${agent.id}`, { typeId: 'builtin:edit', tighten: { talk: false } }, 'mem')
+  assert.equal(granted.status, 200)
+  const c = await client(accessKey)
+  try {
+    assert.match(out(await c.callTool({ name: 'quilt_join_session', arguments: { invite: 'https://join.heyquilt.com/am-2#v' } })), /Joined room am-2 as Gem \(editor\)/)
+    assert.equal(mo.waiting.length, 0)
+    // Later calls name no room: the API passes the one the relay said the agent is in (x-quilt-room).
+    assert.equal(out(await c.callTool({ name: 'quilt_message', arguments: { text: 'hi' } })), "You can't post in this session.")
+    await c.callTool({ name: 'quilt_write_file', arguments: { path: 'gem.txt', content: 'from Gem' } })
+    await waitFor(() => { try { return fs.readFileSync(path.join(moDir, 'gem.txt'), 'utf8') === 'from Gem' } catch { return false } })
+  } finally { await c.close(); await mo.stop() }
+})
+
+test('the pass for a quilt_join_session call is for the room it joins', () => {
+  const call = (name, args) => Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }))
+  assert.equal(joiningRoom(call('quilt_join_session', { invite: 'https://join.heyquilt.com/am-9#s' })), 'am-9')
+  assert.equal(joiningRoom(call('quilt_status', {})), '')
+  assert.equal(joiningRoom(call('quilt_join_session', { invite: 'nonsense' })), '')
+  assert.equal(joiningRoom(Buffer.from('not json')), '')
+  assert.equal(joiningRoom(undefined), '')
+})
```

Change `test/relay-hosted-mcp.test.js` (two new tests at the end):

```diff
diff --git a/test/relay-hosted-mcp.test.js b/test/relay-hosted-mcp.test.js
index 82da008..c79c85e 100644
--- a/test/relay-hosted-mcp.test.js
+++ b/test/relay-hosted-mcp.test.js
@@ -150,3 +150,30 @@ test('a hosted agent in an uncontrolled room (no owner) is an editor straight aw
     await waitFor(() => read(dir, 'open.txt') === 'open')
   } finally { await dana.stop() }
 })
+
+test('a hosted agent whose room pass has a grant gets straight in, with that access', async () => {
+  const access = { files: 'edit', folders: [], foldersExcept: ['secrets'], talk: false }
+  const gem = await client(hostedPass({ sub: 'agent-gem', name: 'Gem', room: 'hm-1', access }))
+  const gemCall = (name, args = {}) => gem.callTool({ name, arguments: args })
+  try {
+    assert.match(out(await gemCall('quilt_join_session', { invite: 'https://join.heyquilt.com/hm-1#v' })), /Joined room hm-1 as Gem \(editor\)/)
+    await waitFor(() => carl.members.some((m) => m.key === 'agent:agent-gem' && m.talk === false))
+    assert.ok(!carl.waiting.some((p) => p.key === 'agent:agent-gem'), 'no prompt for the owner')
+    assert.match(out(await gemCall('quilt_session_info')), /an editor, not in secrets, and you may not post/)
+    assert.match(out(await gemCall('quilt_status')), /You may not post in this session/)
+    const said = await gemCall('quilt_message', { text: 'hello' })
+    assert.deepEqual([said.isError, out(said)], [true, "You can't post in this session."])
+    assert.equal(out(await gemCall('quilt_share', { summary: 'plan' })), "You can't post in this session.")
+    assert.equal(out(await gemCall('quilt_write_file', { path: 'secrets/token.txt', content: 'x' })), 'You may not change files in secrets.')
+    assert.match(out(await gemCall('quilt_write_file', { path: 'gem.txt', content: 'from Gem' })), /Created gem.txt/)
+    await waitFor(() => read(carlDir, 'gem.txt') === 'from Gem')
+  } finally { await gem.close() }
+})
+
+test('the relay tells the accounts API which session a hosted agent is in', async () => {
+  const pass = hostedPass({ sub: 'agent-gem', name: 'Gem' })
+  const res = await fetch(`${http}/mcp`, { method: 'POST', headers: { 'x-quilt-pass': pass, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
+  assert.equal(res.headers.get('x-quilt-room'), 'hm-1')
+  const other = await fetch(`${http}/mcp`, { method: 'POST', headers: { 'x-quilt-pass': hostedPass({ sub: 'agent-new', name: 'New' }), 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
+  assert.equal(other.headers.get('x-quilt-room'), null, 'in no session')
+})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/api-mcp.test.js test/relay-hosted-mcp.test.js`
Expected: FAIL: `does not provide an export named 'joiningRoom'`; the granted agent waits for the owner; there's no `x-quilt-room` header.

- [ ] **Step 3: Implement**

Change `src/api/server.js`:

```diff
diff --git a/src/api/server.js b/src/api/server.js
index 22fb333..1440271 100644
--- a/src/api/server.js
+++ b/src/api/server.js
@@ -21,6 +21,7 @@ import { grantRoutes } from './routes/grants.js'
 import { sessionInviteRoutes } from './routes/session-invites.js'
 import { HOSTED_RELAY } from '../settings.js'
 import { roomAccess } from './access.js'
+import { parseInvite } from '../ui/invite.js'
 
 const LINK_TTL_MS = 10 * 60 * 1000
 const ROOM = /^[A-Za-z0-9_-]{1,64}$/
@@ -31,8 +32,9 @@ const MAX_BODY = 16 * 1024
 // A hosted agent's MCP request (a whole file, at most) and how long it may take on the relay.
 const MAX_MCP_BODY = 2 * 1024 * 1024
 const MCP_TIMEOUT_MS = 30 * 1000
-// A pass minted for a hosted agent is reused until this close to its end.
-const PASS_REUSE_MARGIN_MS = 2 * 60 * 1000
+// A pass minted for a hosted agent is reused until this close to its end: 5 minutes, so
+// a change to its grant reaches it as soon as it reaches a connected app.
+const PASS_REUSE_MARGIN_MS = 5 * 60 * 1000
 
 export function startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, siteUrl, apiUrl = 'https://api.heyquilt.com', mailer = { send: async () => { throw new Error('no mailer configured') } }, now = Date.now, log = () => {}, startLimit = 10, inviteLimit = 10, inviteSendLimit = 20, tokenLimit = 30, joinLimit = 20, trustProxy = false, maxStartKeys = 10_000, passKey = '', passLimit = 60, relayUrl = HOSTED_RELAY, mcpLimit = 600, relaySecret = '' }) {
   // PASS_SIGNING_KEY. A bad one should stop the API at start, not fail every pass later.
@@ -301,21 +303,29 @@ export function startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, sit
 
   // Hosted agents' MCP: the agent's access key signs it in here; the relay gets the same
   // request with a pass for the agent, and its answer comes straight back. Stateless on
-  // both sides, so each request stands alone.
-  const mintedPasses = new Map() // agent id -> { pass, exp }
+  // both sides, so each request stands alone. The pass is for the room the agent is joining
+  // (named in quilt_join_session) or is in (the relay says which in x-quilt-room), so it
+  // carries the agent's grant there.
+  const mintedPasses = new Map() // `${agent id}\n${room}` -> { pass, exp }
+  const agentRooms = new Map() // agent id -> the room the relay last said it is in
+  const forget = (map) => { if (map.size > maxStartKeys) map.delete(map.keys().next().value) }
   async function proxyMcp (req, res, send) {
     needPassKey()
     if (!bearer(req).startsWith('qa_')) throw new HttpError(401, 'send your agent access key as "Authorization: Bearer <accessKey>"')
     const { agent } = await agentAuth.agentFromRequest(req)
     limitMcp(agent.id)
-    let minted = mintedPasses.get(agent.id)
+    const body = ['POST', 'PUT'].includes(req.method) ? await readRaw(req, MAX_MCP_BODY) : undefined
+    const room = joiningRoom(body) || agentRooms.get(agent.id) || ''
+    const cacheKey = `${agent.id}\n${room}`
+    let minted = mintedPasses.get(cacheKey)
     if (!minted || minted.exp - now() < PASS_REUSE_MARGIN_MS) {
-      const exp = now() + PASS_TTL_MS
-      minted = { pass: signPass({ v: PASS_VERSION, sub: agent.id, kind: 'agent', name: agent.name.slice(0, 64), key: agent.publicKey || '', exp }, passKey), exp }
-      mintedPasses.set(agent.id, minted)
+      const holder = { sub: agent.id, kind: 'agent', name: agent.name.slice(0, 64), key: agent.publicKey || '' }
+      const { pass, expiresAt } = await mintPass(holder, room)
+      minted = { pass, exp: expiresAt }
+      mintedPasses.set(cacheKey, minted)
       if (mintedPasses.size > maxStartKeys) for (const [k, v] of mintedPasses) if (v.exp <= now()) mintedPasses.delete(k)
+      forget(mintedPasses)
     }
-    const body = ['POST', 'PUT'].includes(req.method) ? await readRaw(req, MAX_MCP_BODY) : undefined
     const headers = { 'x-quilt-pass': minted.pass }
     for (const h of ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id']) if (req.headers[h]) headers[h] = String(req.headers[h])
     let upstream
@@ -325,6 +335,10 @@ export function startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, sit
       log(`mcp relay error: ${err.message}`)
       throw new HttpError(502, 'the session relay did not answer; try again in a moment')
     }
+    if (upstream.ok) {
+      const inRoom = upstream.headers.get('x-quilt-room') || ''
+      if (ROOM.test(inRoom)) { agentRooms.set(agent.id, inRoom); forget(agentRooms) } else agentRooms.delete(agent.id)
+    }
     const type = upstream.headers.get('content-type') || 'application/json'
     const out = Buffer.from(await upstream.arrayBuffer())
     res.writeHead(upstream.status, { 'content-type': type, 'cache-control': 'no-store' })
@@ -342,6 +356,18 @@ export function startApi ({ port = 0, host = '127.0.0.1', store, verifyUser, sit
   }))
 }
 
+/** The room a quilt_join_session call in this MCP request joins, or '' (any other request). */
+export function joiningRoom (body) {
+  if (!body || !body.length) return ''
+  try {
+    const msg = JSON.parse(body.toString('utf8'))
+    for (const m of Array.isArray(msg) ? msg : [msg]) {
+      if (m?.method === 'tools/call' && m.params?.name === 'quilt_join_session') return parseInvite(String(m.params.arguments?.invite || ''), { allowRelay: () => true }).room
+    }
+  } catch {}
+  return ''
+}
+
 function decodePart (s) {
   try { return decodeURIComponent(s) } catch { throw new HttpError(400, 'bad path') }
 }
```

Change `src/relay-mcp.js`:

```diff
diff --git a/src/relay-mcp.js b/src/relay-mcp.js
index 3941519..3203e3b 100644
--- a/src/relay-mcp.js
+++ b/src/relay-mcp.js
@@ -18,6 +18,7 @@ import { globMatcher, isSafeRelPath } from './pathrules.js'
 import { readTasks, addTask, updateTask, deleteTask, taskMarkdown, formatTasks, columnName } from './tasks.js'
 import { applyTextDiff } from './textdiff.js'
 import { parseInvite } from './ui/invite.js'
+import { changeRefusal, TALK_REFUSED } from './session-access.js'
 
 const FEED_CAP = 300
 const ACTIVITY_CAP = 300
@@ -94,6 +95,8 @@ function sessionTools (server, ctx) {
     const lines = [`You are ${me} in a live quilt session (room ${room.name}).`]
     if (a && a.role === 'viewer') lines.push('You may only view this session: reading, chat and claims work, file changes are refused.')
     else if (a && a.scopes && a.scopes.length) lines.push(`You may change files only in: ${a.scopes.join(', ')}.`)
+    if (a && a.scopesExcept && a.scopesExcept.length && a.role !== 'viewer') lines.push(`You may not change files in: ${a.scopesExcept.join(', ')}.`)
+    if (a && a.talk === false) lines.push("You may not post in this session: quilt_message and quilt_share are refused.")
     lines.push('', '## People online')
     const ps = peers(room)
     if (!ps.length) lines.push('- Nobody else right now.')
@@ -124,6 +127,7 @@ function sessionTools (server, ctx) {
   }, ({ request, summary, files: changed }, { room, doc, feed }) => {
     const err = writable(room)
     if (err) return fail(err)
+    if (ctx.access(room)?.talk === false) return fail(TALK_REFUSED)
     const t = ctx.tool()
     const now = Date.now()
     const entries = []
@@ -176,6 +180,7 @@ function sessionTools (server, ctx) {
   }, ({ text: t, to }, { room, doc, chat }) => {
     const err = writable(room)
     if (err) return fail(err)
+    if (ctx.access(room)?.talk === false) return fail(TALK_REFUSED)
     const msg = { id: id(), by: me, to: to || null, text: t, ts: Date.now() }
     doc.transact(() => {
       chat.push([msg])
@@ -238,6 +243,8 @@ function sessionTools (server, ctx) {
     const a = ctx.access(room)
     if (a && a.role === 'viewer') return fail('You can only view this session; file changes are refused.')
     if (a && a.scopes && a.scopes.length && !a.scopes.some((s) => globMatcher(s)(rel))) return fail(`You may only change files in ${a.scopes.join(', ')}.`)
+    const refusal = a && changeRefusal(a, rel)
+    if (refusal) return fail(`${refusal[0].toUpperCase()}${refusal.slice(1)}.`)
     const claim = claimsOf(room).find((c) => c.by !== me && globMatcher(c.pattern)(rel))
     if (claim) return fail(`${rel} is claimed by ${claim.by}${claim.note ? ` (${claim.note})` : ''}. Message them instead of editing it.`)
     if (blobs.get(rel)?.stored) return fail(`${rel} is a large file kept in storage; it can't be changed here.`)
@@ -306,6 +313,15 @@ export async function handleHostedMcp ({ req, res, pass, relay }) {
   const touched = new Set()
   const done = () => { for (const room of touched) if (room && !room.conns.size && room.onEmpty) room.onEmpty() }
   res.on('close', done)
+  // Which session the agent is in, for the accounts API: its next pass is for that room,
+  // and so carries the agent's grant there. Absent: in no session.
+  const tellRoom = () => {
+    if (res.headersSent) return
+    const h = relay.hosted.get(account)
+    if (h) res.setHeader('x-quilt-room', h.room)
+    else res.removeHeader('x-quilt-room')
+  }
+  tellRoom()
 
   /** The room this agent is in, with its standing there, or why it has none: { room, access } | { error }. */
   const current = () => {
@@ -351,6 +367,7 @@ export async function handleHostedMcp ({ req, res, pass, relay }) {
     const a = room.hostedRequest(pass, auth)
     relay.hosted.set(account, { room: inv.room, since: Date.now(), seenAt: Date.now(), pending: a.state === 'pending' })
     relay.saveHosted()
+    tellRoom()
     if (a.state === 'pending') return text(`Asked to join room ${inv.room} as ${auth === 'viewer' ? 'a viewer' : 'an editor'}. ${WAITING}`)
     room.hostedActive(account)
     return text(`Joined room ${inv.room} as ${me} (${a.owner ? 'owner' : a.role}${a.scopes && a.scopes.length ? `, folders ${a.scopes.join(', ')}` : ''}). Call quilt_status to see who is here.`)
@@ -366,7 +383,7 @@ export async function handleHostedMcp ({ req, res, pass, relay }) {
     if (c.error && !c.room) return fail(c.error)
     if (c.error) return text(`Room ${h.room}: ${c.error}`)
     const a = c.access
-    return text(`Room ${h.room}: you are ${me}, ${a.owner ? 'the owner' : a.role === 'viewer' ? 'a viewer (no file changes)' : 'an editor'}${a.scopes && a.scopes.length ? `, limited to ${a.scopes.join(', ')}` : ''}.`)
+    return text(`Room ${h.room}: you are ${me}, ${a.owner ? 'the owner' : a.role === 'viewer' ? 'a viewer (no file changes)' : 'an editor'}${a.scopes && a.scopes.length ? `, limited to ${a.scopes.join(', ')}` : ''}${a.scopesExcept && a.scopesExcept.length ? `, not in ${a.scopesExcept.join(', ')}` : ''}${a.talk === false ? ', and you may not post' : ''}.`)
   })
 
   mcp.registerTool('quilt_leave_session', {
@@ -377,6 +394,7 @@ export async function handleHostedMcp ({ req, res, pass, relay }) {
     if (!h) return text('You are not in a session.')
     relay.hosted.delete(account)
     relay.saveHosted()
+    tellRoom()
     const room = relay.getRoom(h.room)
     if (room) {
       touched.add(room)
```

Change `src/server.js`:

```diff
diff --git a/src/server.js b/src/server.js
index b3afa72..52dbf5b 100644
--- a/src/server.js
+++ b/src/server.js
@@ -350,11 +350,19 @@ class Room {
     return { state: 'pending', invitedAs }
   }
 
-  /** A hosted agent's current standing, changing nothing: approved (role, scopes) or pending. */
+  /**
+   * A hosted agent's current standing: approved (with its access) or pending. A room pass
+   * with a grant approves it, and puts it on the member list.
+   */
   hostedAccess (pass) {
     const id = `${pass.kind}:${pass.sub}`
     if (!this.controlled) return { state: 'approved', role: 'editor', scopes: [], owner: false, id }
     if (this.meta.owner && this.isOwner(pass.key || '', id)) return { state: 'approved', role: 'editor', scopes: [], owner: true, id }
+    const granted = this.passGrant(pass)
+    if (granted) {
+      this.noteGranted(id, pass.name, pass.kind === 'agent' ? 'agent' : 'human', granted)
+      return { state: 'approved', ...relayAccess(granted), owner: false, id }
+    }
     const m = this.meta.members[id]
     if (m) {
       if (m.name !== pass.name) { m.name = pass.name; this.saveMeta() }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/api-mcp.test.js test/relay-hosted-mcp.test.js test/relay-presence.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.js src/relay-mcp.js src/server.js test/api-mcp.test.js test/relay-hosted-mcp.test.js
git commit -m "Access types: hosted agents get their grant through room passes, and the relay enforces it on /mcp"
```

---

### Task 12: The app asks for room passes and keeps to its access

A session asks for passes for its own room (they carry its access there), fetches a fresh one when the relay says the owner changed its access, refuses to post when it may not (and shares no AI chat), and puts back a change in a folder it may not change.

**Files:**
- Modify: `src/connection.js`
- Modify: `src/pass-source.js`
- Modify: `src/session.js`
- Create: `test/session-room-passes.test.js`

**Interfaces:**
- Consumes: `POST /v1/passes { room }` (Task 7); `MSG_ACCESS.refresh` (Task 10); `changeRefusal`, `TALK_REFUSED` (Task 1).
- Produces: `new PassSource({ fetchPass(room), room })`, `PassSource#forRoom(room): PassSource` (one per room); `personPasses` and `agentPasses` send `{ room }`; `Session#passes` is the room's source; `Session#mayTalk(): boolean`; `say` and `sendFile` throw `You can't post in this session.`; `shareAgentEntries` shares nothing then.

- [ ] **Step 1: Write the failing test**

Create `test/session-room-passes.test.js`:

```js
// The app's side of access types: a session asks for passes for its own room, fetches a
// fresh one when the owner changes its access, and keeps to what it may do (no posts when
// it may not post, no changes in folders it may not change).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { startServer } from '../src/server.js'
import { Session } from '../src/session.js'
import { generateIdentity } from '../src/identity.js'
import { PassSource, personPasses } from '../src/pass-source.js'
import { newPassKeys, verifyPass, PASS_TTL_MS } from '../src/passes.js'
import { PASS_KEYS, makePass, testPasses } from './pass-helpers.js'
import { startTestApi, linkDevice } from './api-helpers.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-srp-home-'))
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `quilt-srp-${n}-`))
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (fn, ms = 6000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await wait(25) }
  throw new Error('timed out')
}

test('forRoom gives one source per room, fetching with that room', async () => {
  const asked = []
  const base = new PassSource({ fetchPass: async (room) => { asked.push(room); return { pass: `p-${room || 'none'}`, expiresAt: Date.now() + PASS_TTL_MS } } })
  const a = base.forRoom('room-a')
  assert.equal(base.forRoom('room-a'), a)
  assert.equal(base.forRoom(''), base)
  assert.equal(a.forRoom('room-a'), a)
  assert.equal(await a.get(), 'p-room-a')
  assert.equal(await base.get(), 'p-none')
  assert.deepEqual(asked, ['room-a', ''])
})

test("a computer's room passes come from the API with the room in the body", async () => {
  const keys = newPassKeys()
  const t = await startTestApi({ passKey: keys.privateKey })
  try {
    await t.store.ingestPresence([{ id: crypto.randomUUID(), type: 'start', room: 'srp-api', account: 'person:mem', name: 'Mo', owner: true, at: Date.now() }], Date.now())
    const { token } = await linkDevice(t, 'mem')
    const p = verifyPass(await personPasses({ token, api: t.api.url }).forRoom('srp-api').get(), keys.publicKey)
    assert.deepEqual([p.room, p.access.owner], ['srp-api', true])
  } finally { await t.close() }
})

let srv, server
const sessions = []
before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmp('relay'), log: () => {}, passPublicKey: PASS_KEYS.publicKey })
  server = `ws://127.0.0.1:${srv.port}`
})
after(async () => {
  for (const s of sessions) await s.stop().catch(() => {})
  await srv.close()
})

/** A session with an owner, and someone whose passes (for the room it asks for) carry `access`. */
async function withMember (room, access) {
  const ownerDir = tmp('owner')
  fs.writeFileSync(path.join(ownerDir, 'README.md'), 'hello\n')
  fs.mkdirSync(path.join(ownerDir, 'secrets'))
  fs.writeFileSync(path.join(ownerDir, 'secrets/key.txt'), 'k\n')
  const oid = generateIdentity()
  const owner = new Session({ dir: ownerDir, server, room, secret: 'e', viewSecret: 'v', name: 'Olive', identity: oid, passes: testPasses(oid, { name: 'Olive', sub: 'olive' }) })
  sessions.push(owner)
  await owner.start({ waitTimeoutMs: 5000 })
  await waitFor(() => owner.isOwner)
  const mid = generateIdentity()
  const asked = []
  const passes = new PassSource({
    fetchPass: async (forRoom) => {
      asked.push(forRoom)
      const exp = Date.now() + PASS_TTL_MS
      return { pass: makePass({ identity: mid, name: 'Sam', sub: 'sam', room: forRoom, access: passes.access, exp }), expiresAt: exp }
    }
  })
  passes.access = access
  const dir = tmp('sam')
  const sam = new Session({ dir, server, room, secret: 'e', name: 'Sam', identity: mid, passes })
  sessions.push(sam)
  await sam.start({ waitTimeoutMs: 5000 })
  await waitFor(() => sam.access?.state === 'approved' && read(dir, 'README.md') === 'hello\n')
  return { owner, ownerDir, sam, dir, asked, passes }
}

test('a session asks for passes for its own room', async () => {
  const { asked } = await withMember('srp-1', { files: 'edit', folders: [], foldersExcept: [], talk: true })
  assert.deepEqual([...new Set(asked)], ['srp-1'])
})

test('without posting rights, the app refuses to post, and shares no AI chat', async () => {
  const { owner, sam } = await withMember('srp-2', { files: 'edit', folders: [], foldersExcept: [], talk: false })
  assert.equal(sam.mayTalk(), false)
  assert.throws(() => sam.say('hi'), { message: "You can't post in this session." })
  await assert.rejects(sam.sendFile('README.md'), { message: "You can't post in this session." })
  assert.equal(sam.pushAgentEntries([{ id: 'e1', kind: 'prompt', text: 'plan', ts: Date.now() }]), 0)
  sam.setAgentSharing(false)
  await wait(150)
  assert.deepEqual([sam.chat.length, sam.agentFeed.length, owner.agentFeed.length], [0, 0, 0])
})

test('a change in a folder it may not change is put back on its own disk', async () => {
  const { ownerDir, sam, dir } = await withMember('srp-3', { files: 'edit', folders: [], foldersExcept: ['secrets'], talk: true })
  assert.equal(sam.writeRefusal('secrets/key.txt'), 'you may not change files in secrets')
  assert.equal(sam.writeRefusal('README.md'), null)
  await waitFor(() => read(dir, 'secrets/key.txt') === 'k\n')
  fs.writeFileSync(path.join(dir, 'secrets/key.txt'), 'leaked\n')
  await waitFor(() => read(dir, 'secrets/key.txt') === 'k\n')
  assert.equal(read(ownerDir, 'secrets/key.txt'), 'k\n')
})

test('when the owner changes its access, the app fetches a fresh pass at once', async () => {
  const { owner, sam, asked, passes } = await withMember('srp-4', { files: 'edit', folders: [], foldersExcept: [], talk: true })
  const before = asked.length
  // The owner's app wrote a narrower grant to the API, then tells the relay.
  passes.access = { files: 'view', folders: [], foldersExcept: [], talk: true }
  await owner.conn.adminRequest({ op: 'set', key: 'person:sam', access: passes.access })
  await waitFor(() => asked.length > before)
  await waitFor(() => sam.access.role === 'viewer')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/session-room-passes.test.js`
Expected: FAIL: `base.forRoom is not a function`, and the session asks for passes with no room.

- [ ] **Step 3: Implement**

Change `src/connection.js`:

```diff
diff --git a/src/connection.js b/src/connection.js
index 6f49c75..d0cab1f 100644
--- a/src/connection.js
+++ b/src/connection.js
@@ -333,6 +333,8 @@ export class Connection extends EventEmitter {
       this.access = JSON.parse(decoding.readVarString(dec))
       if (was && was.state === 'pending' && this.access.state === 'approved') this.startSync()
       this.emit('access', this.access)
+      // The owner just changed what we may do: a fresh pass carries what the API now says.
+      if (this.access.refresh && this.passes) this.refreshPass()
     } else if (type === MSG_MEMBERS) {
       const msg = JSON.parse(decoding.readVarString(dec))
       this.emit('members', msg)
```

Change `src/pass-source.js`:

```diff
diff --git a/src/pass-source.js b/src/pass-source.js
index c4d7b3b..ba1d001 100644
--- a/src/pass-source.js
+++ b/src/pass-source.js
@@ -1,6 +1,7 @@
 // Session passes from the accounts API. A pass proves who you are to the relay
 // for 10 minutes. Clients keep one until 2 minutes before it runs out, and while
-// connected they fetch a fresh one every 5 minutes (see connection.js).
+// connected they fetch a fresh one every 5 minutes (see connection.js). A session
+// asks for passes for its own room: those carry what you may do there.
 import { readPass } from './passes.js'
 import { apiUrl, readAccount, NOT_SIGNED_IN, SIGNED_OUT } from './account.js'
 import { agentAccess, readAgent } from './agent-join.js'
@@ -18,15 +19,24 @@ export class SignedOutError extends Error {
 }
 
 export class PassSource {
-  /** `fetchPass` resolves to { pass, expiresAt }. */
-  constructor ({ fetchPass, now = Date.now, earlyMs = PASS_EARLY_MS }) {
+  /** `fetchPass(room)` resolves to { pass, expiresAt }; `room` is '' for a pass that isn't for one room. */
+  constructor ({ fetchPass, now = Date.now, earlyMs = PASS_EARLY_MS, room = '' }) {
     this.fetchPass = fetchPass
     this.now = now
     this.earlyMs = earlyMs
+    this.room = room
+    this.rooms = new Map() // room -> PassSource, for forRoom
     this.current = null // { pass, expiresAt, payload }
     this.pending = null
   }
 
+  /** The same account's passes for one room (kept, one per room). They carry its access there. */
+  forRoom (room) {
+    if (!room || room === this.room) return this
+    if (!this.rooms.has(room)) this.rooms.set(room, new PassSource({ fetchPass: this.fetchPass, now: this.now, earlyMs: this.earlyMs, room }))
+    return this.rooms.get(room)
+  }
+
   /** A pass with at least `earlyMs` left, fetching one when needed. */
   get () {
     if (this.current && this.now() < this.current.expiresAt - this.earlyMs) return Promise.resolve(this.current.pass)
@@ -37,7 +47,7 @@ export class PassSource {
   fresh () {
     if (!this.pending) {
       this.pending = Promise.resolve()
-        .then(() => this.fetchPass())
+        .then(() => this.fetchPass(this.room))
         .then(({ pass, expiresAt }) => {
           this.current = { pass, expiresAt, payload: readPass(pass) }
           return pass
@@ -58,10 +68,11 @@ export class PassSource {
   }
 }
 
-async function requestPass (fetchImpl, api, bearer, signedOutMessage) {
+async function requestPass (fetchImpl, api, bearer, signedOutMessage, room = '') {
   let res
   try {
-    res = await fetchImpl(`${String(api).replace(/\/+$/, '')}/v1/passes`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` } })
+    const body = room ? { headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ room }) } : { headers: { authorization: `Bearer ${bearer}` } }
+    res = await fetchImpl(`${String(api).replace(/\/+$/, '')}/v1/passes`, { method: 'POST', ...body })
   } catch (err) {
     throw new Error(`Couldn't reach Quilt (${err.cause?.code || err.message}).`)
   }
@@ -73,14 +84,14 @@ async function requestPass (fetchImpl, api, bearer, signedOutMessage) {
 
 /** Passes for this computer's account, from its qd_ token. */
 export function personPasses ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch, now } = {}) {
-  return new PassSource({ now, fetchPass: () => requestPass(fetchImpl, api, token, SIGNED_OUT) })
+  return new PassSource({ now, fetchPass: (room) => requestPass(fetchImpl, api, token, SIGNED_OUT, room) })
 }
 
 /** Passes for a saved agent, from its access key (refreshed with its refresh key when it runs out). */
 export function agentPasses ({ name, dir, fetch: fetchImpl = globalThis.fetch, now } = {}) {
   return new PassSource({
     now,
-    fetchPass: async () => {
+    fetchPass: async (room) => {
       let saved
       try {
         saved = await agentAccess({ name, dir, fetch: fetchImpl, now })
@@ -88,7 +99,7 @@ export function agentPasses ({ name, dir, fetch: fetchImpl = globalThis.fetch, n
         if (err.status === 401) throw new SignedOutError(err.message)
         throw err
       }
-      return requestPass(fetchImpl, saved.api, saved.accessKey, AGENT_SIGNED_OUT)
+      return requestPass(fetchImpl, saved.api, saved.accessKey, AGENT_SIGNED_OUT, room)
     }
   })
 }
```

Change `src/session.js`:

```diff
diff --git a/src/session.js b/src/session.js
index 51fdf8f..ee6d74b 100644
--- a/src/session.js
+++ b/src/session.js
@@ -20,6 +20,7 @@ import {
 import { deriveWrapKey, newFileKey, wrapKey, unwrapKey, encryptBlob, decryptBlob, blobId } from './largefiles.js'
 import { applyTextDiff } from './textdiff.js'
 import { migrateDir } from './legacy.js'
+import { changeRefusal, TALK_REFUSED } from './session-access.js'
 
 export { applyTextDiff }
 
@@ -51,7 +52,8 @@ export class Session extends EventEmitter {
     this.viewSecret = viewSecret
     this.name = name
     this.identity = identity
-    this.passes = passes // signs in to a relay that requires it (see pass-source.js)
+    // Signs in to a relay that requires it (see pass-source.js), with passes for this room.
+    this.passes = passes && passes.forRoom ? passes.forRoom(room) : passes
     this.tool = tool
     this.color = color
     this.prefer = prefer
@@ -216,9 +218,12 @@ export class Session extends EventEmitter {
     this.access = a
     if (a.state === 'approved' && a.owner) this.sendStartName()
     if (a.state === 'pending' && (!was || was.state !== 'pending')) this.log(`⏳ waiting for the session owner to let you in (you were invited to ${a.invitedAs === 'viewer' ? 'view' : 'edit'})`)
-    if (a.state === 'approved' && was && (was.role !== a.role || String(was.scopes) !== String(a.scopes))) {
-      this.log(`🔑 you can now ${a.role === 'viewer' ? 'only view this session' : a.scopes.length ? `change files in ${a.scopes.join(', ')}` : 'change any file'}`)
+    if (a.state === 'approved' && was && (was.role !== a.role || String(was.scopes) !== String(a.scopes) || String(was.scopesExcept || []) !== String(a.scopesExcept || []))) {
+      const except = a.role !== 'viewer' && a.scopesExcept && a.scopesExcept.length ? `, except ${a.scopesExcept.join(', ')}` : ''
+      this.log(`🔑 you can now ${a.role === 'viewer' ? 'only view this session' : a.scopes.length ? `change files in ${a.scopes.join(', ')}` : 'change any file'}${except}`)
     }
+    if (a.state === 'approved' && (was ? was.talk !== false : true) && a.talk === false) this.log(`🔇 ${TALK_REFUSED}`)
+    if (a.state === 'approved' && was && was.talk === false && a.talk !== false) this.log('💬 you can post in this session again')
     if (a.refused) this.log(`🔒 the relay undid your change to ${a.refused.join(', ')}: ${a.why}`)
     this.emit('access', a)
     this.scheduleStatusWrite()
@@ -240,9 +245,12 @@ export class Session extends EventEmitter {
   writeRefusal (rel) {
     const a = this.access
     if (!a || a.state !== 'approved') return null
-    if (a.role === 'viewer') return 'you can only view this session'
-    if (a.scopes && a.scopes.length && !a.scopes.some((sc) => globMatcher(sc)(rel))) return `you may only change files in ${a.scopes.join(', ')}`
-    return null
+    return changeRefusal(a, rel)
+  }
+
+  /** May we post to chat and the feed? (The session's owner can say no; the relay undoes posts then.) */
+  mayTalk () {
+    return !(this.access && this.access.state === 'approved' && this.access.talk === false)
   }
 
   get isOwner () { return !!(this.access && this.access.owner) }
@@ -1223,6 +1231,7 @@ export class Session extends EventEmitter {
    * from the relay or a modified client).
    */
   say (text, { to = null, file = null } = {}) {
+    if (!this.mayTalk()) throw new Error(TALK_REFUSED)
     text = String(text || '').slice(0, 4000)
     if (!text && !file) throw new Error('message is empty')
     to = to ? String(to).trim() : null
@@ -1241,6 +1250,7 @@ export class Session extends EventEmitter {
 
   /** Uploads a file to the relay and posts it as a message. */
   async sendFile (filePath, { to = null, text = '' } = {}) {
+    if (!this.mayTalk()) throw new Error(TALK_REFUSED)
     const abs = path.resolve(this.root, filePath)
     const st = fs.statSync(abs)
     if (!st.isFile()) throw new Error(`${filePath} is not a file`)
@@ -1421,6 +1431,7 @@ export class Session extends EventEmitter {
   }
 
   shareAgentEntries (entries) {
+    if (!this.mayTalk()) return 0
     const indexById = new Map()
     this.agentFeed.forEach((e, i) => { if (e && e.by === this.name && e.id) indexById.set(e.id, i) })
     const fresh = []
@@ -1466,10 +1477,12 @@ export class Session extends EventEmitter {
     on = !!on
     if (on === this.agentSharing) return on
     const marker = { id: `${on ? 'resumed' : 'paused'}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, by: this.name, tool: null, conv: null, kind: on ? 'resumed' : 'paused', text: '', ts: Date.now() }
-    this.doc.transact(() => {
-      this.agentFeed.push([marker])
-      this.trimAgentFeed()
-    }, LOCAL)
+    if (this.mayTalk()) {
+      this.doc.transact(() => {
+        this.agentFeed.push([marker])
+        this.trimAgentFeed()
+      }, LOCAL)
+    }
     this.agentSharing = on
     this.publishAgentState()
     this.saveConfig({ shareAgent: on })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/session-room-passes.test.js test/session-passes.test.js test/pass-source.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connection.js src/pass-source.js src/session.js test/session-room-passes.test.js
git commit -m "Access types: sessions ask for passes for their room, refresh when the owner changes their access, and keep to it"
```

---

### Task 13: The app's server: let in as a type, change access, invite, remove

The app's local server talks to the accounts API with this computer's token and to the relay through the session: approving as a type writes the grant and then approves; changing access writes the grant and then narrows on the relay; removing deletes the grant too; invites go to the API with the right link.

**Files:**
- Modify: `src/account.js`
- Modify: `src/session.js`
- Modify: `src/ui-server.js`
- Create: `test/ui-access.test.js`

**Interfaces:**
- Consumes: the API routes (Tasks 4 to 6); `effectiveAccess` (Task 1); admin ops (Task 10).
- Produces:
  - `src/account.js`: `listAccessTypes`, `listCollaborators`, `listGrants`, `putGrant`, `deleteGrant`, `inviteToSession`, `listSessionInvites`, `cancelSessionInvite` (each `({ token, ..., api, fetch })`).
  - `Session#approve(key, { role, scopes, typeId, access })`, `Session#setMember(key, { role, scopes, access })`.
  - App routes: `GET /api/access-types`, `GET /api/collaborators`, `GET /api/sessions/:id/grants`, `POST /api/sessions/:id/members/approve` (`{ key, typeId }` → `{ ok, warning? }`, or the old `{ key, role, scopes }`), `POST /api/sessions/:id/members/access` (`{ key, typeId, tighten }` → `{ grant }`), `POST /api/sessions/:id/members/remove`, `GET|POST /api/sessions/:id/invites`, `POST /api/sessions/:id/invites/cancel` (`{ inviteId }`). Owner only (403 `Only the session owner can do that.`).

- [ ] **Step 1: Write the failing test**

Create `test/ui-access.test.js`:

```js
// Access types in the app: the owner lets someone in as a type, changes and narrows it,
// invites people, and removes them. The grant goes to the API, the relay applies it, and
// the person's app follows.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-ui-access-'))
process.env.HOME = home

const { startUi } = await import('../src/ui-server.js')
const { startServer } = await import('../src/server.js')
const { Session } = await import('../src/session.js')
const { personPasses } = await import('../src/pass-source.js')
const { startTestApi, linkDevice } = await import('./api-helpers.js')
const { newPassKeys } = await import('../src/passes.js')

const SECRET = 'relay-secret-for-ui-access-tests'
let ui, accounts, relay, lin
before(async () => {
  const keys = newPassKeys()
  accounts = await startTestApi({ passKey: keys.privateKey, relaySecret: SECRET })
  relay = await startServer({ port: 0, host: '127.0.0.1', log: () => {}, passPublicKey: keys.publicKey, apiUrl: accounts.api.url, relayApiSecret: SECRET })
  process.env.QUILT_API_URL = accounts.api.url
  process.env.QUILT_SERVER = `ws://127.0.0.1:${relay.port}`
  ui = await startUi({ port: 0 })
})
after(async () => { await lin?.stop(); await ui.close(); await relay.close(); await accounts.close() })

const api = (method, p, body) => fetch(`http://127.0.0.1:${ui.port}${p}`, {
  method,
  headers: { 'x-quilt-token': ui.token, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then(async (r) => ({ status: r.status, body: await r.json() }))
async function waitFor (fn, ms = 10000) {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = await fn(); if (v) return v; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error('timed out')
}
const grants = async (room) => (await accounts.call('GET', `/v1/sessions/${room}/grants`, null, 'mem')).body.grants

test('the owner lets someone in as a type, narrows it, invites people, and removes someone', async () => {
  const started = await api('POST', '/api/account/start')
  await accounts.call('POST', '/v1/device/approve', { userCode: started.body.link.userCode, approve: true }, 'mem')
  await waitFor(async () => (await api('GET', '/api/account')).body.signedIn)
  const s = await api('POST', '/api/sessions', { mode: 'create', dir: path.join(home, 'site') })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  const { id } = s.body
  const room = s.body.status.room
  // The relay tells heyquilt.com who owns the session as soon as Mo is in.
  await waitFor(async () => (await accounts.store.sessionByRoom(room))?.ownerAccount === 'person:mem')

  const types = await api('GET', '/api/access-types')
  assert.deepEqual(types.body.types.map((x) => x.id), ['builtin:edit', 'builtin:view'])

  // Lin joins from her own computer and waits: she has no grant yet.
  const device = await linkDevice(accounts, 'lim')
  lin = new Session({ dir: fs.mkdtempSync(path.join(home, 'lin-')), server: process.env.QUILT_SERVER, room, secret: s.body.invite.split('#')[1], name: 'Lin', identity: device.identity, passes: personPasses({ token: device.token, api: accounts.api.url }) })
  await lin.start({ waitTimeoutMs: 5000 })
  await waitFor(() => lin.access?.state === 'pending')

  const approved = await api('POST', `/api/sessions/${id}/members/approve`, { key: 'person:lim', typeId: 'builtin:view' })
  assert.deepEqual([approved.status, approved.body], [200, { ok: true }])
  await waitFor(() => lin.access?.state === 'approved' && lin.access.role === 'viewer')
  assert.deepEqual((await grants(room)).map((g) => [g.account, g.typeName]), [['person:lim', 'View only']])

  // Can edit, but no posting: the relay narrows at once, and Lin's fresh pass brings the rest.
  const changed = await api('POST', `/api/sessions/${id}/members/access`, { key: 'person:lim', typeId: 'builtin:edit', tighten: { talk: false } })
  assert.equal(changed.status, 200, JSON.stringify(changed.body))
  assert.deepEqual(changed.body.grant.access, { files: 'edit', folders: [], foldersExcept: [], talk: false })
  await waitFor(() => lin.access.role === 'editor' && lin.access.talk === false)
  assert.equal((await api('POST', `/api/sessions/${id}/members/access`, { key: 'b3f1c0ffee', typeId: 'builtin:edit' })).status, 400, 'an older member has no account')

  // Lin is someone Mo has worked with now.
  await relay.presence.flush()
  const people = await api('GET', '/api/collaborators')
  assert.deepEqual(people.body.collaborators.map((c) => c.account), ['person:lim'])

  // An email invite carries the view link for a view-only type.
  accounts.sent.length = 0
  const invited = await api('POST', `/api/sessions/${id}/invites`, { typeId: 'builtin:view', to: { email: 'pat@example.com' } })
  assert.equal(invited.status, 200, JSON.stringify(invited.body))
  assert.ok(accounts.sent[0].text.includes(s.body.viewInvite), 'the view link')
  const list = await api('GET', `/api/sessions/${id}/invites`)
  assert.deepEqual(list.body.invites.map((i) => [i.email, i.status]), [['pat@example.com', 'waiting']])
  assert.deepEqual((await api('POST', `/api/sessions/${id}/invites/cancel`, { inviteId: invited.body.invite.id })).body, { ok: true })
  assert.equal((await api('GET', `/api/sessions/${id}/invites`)).body.invites[0].status, 'cancelled')

  // Removing Lin takes her grant away too.
  const fatal = new Promise((resolve) => lin.once('fatal', resolve))
  assert.equal((await api('POST', `/api/sessions/${id}/members/remove`, { key: 'person:lim' })).status, 200)
  assert.match((await fatal).message, /removed you/)
  assert.deepEqual(await grants(room), [])
  await api('POST', `/api/sessions/${id}/stop`)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/ui-access.test.js`
Expected: FAIL: the app's server has no `/api/access-types` yet, so the test stops at `Cannot read properties of undefined (reading 'map')`.

- [ ] **Step 3: Implement**

Change `src/account.js`:

```diff
diff --git a/src/account.js b/src/account.js
index 3da9853..51fe3b2 100644
--- a/src/account.js
+++ b/src/account.js
@@ -141,6 +141,60 @@ export async function listAgents ({ token, api = apiUrl(), fetch: fetchImpl = gl
   return r.agents
 }
 
+// Access types, grants and session invites, as this computer's account (see
+// docs/superpowers/specs/2026-10-02-access-types-and-invites-design.md). Each throws with
+// .status when the API says no (401 once the token is revoked).
+const room$ = (room) => `/v1/sessions/${encodeURIComponent(room)}`
+
+/** The built-in access types, then this account's own. */
+export async function listAccessTypes ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
+  const r = await call(fetchImpl, api, 'GET', '/v1/access-types', null, token)
+  if (!Array.isArray(r.types)) throw new Error(BAD_REPLY)
+  return r.types
+}
+
+/** People and agents this account has worked with: [{ account, name, kind, lastTogetherAt }]. */
+export async function listCollaborators ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
+  const r = await call(fetchImpl, api, 'GET', '/v1/me/collaborators', null, token)
+  if (!Array.isArray(r.collaborators)) throw new Error(BAD_REPLY)
+  return r.collaborators
+}
+
+/** The owner's grants in a session: [{ account, typeId, typeName, tighten, access }]. */
+export async function listGrants ({ token, room, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
+  const r = await call(fetchImpl, api, 'GET', `${room$(room)}/grants`, null, token)
+  if (!Array.isArray(r.grants)) throw new Error(BAD_REPLY)
+  return r.grants
+}
+
+/** Gives `account` an access type in the owner's session, narrowed by `tighten`: the grant, with the access it comes to. */
+export async function putGrant ({ token, room, account, typeId, tighten = {}, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
+  const r = await call(fetchImpl, api, 'PUT', `${room$(room)}/grants/${encodeURIComponent(account)}`, { typeId, tighten }, token)
+  if (!r.grant || !r.grant.access) throw new Error(BAD_REPLY)
+  return r.grant
+}
+
+export async function deleteGrant ({ token, room, account, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
+  await call(fetchImpl, api, 'DELETE', `${room$(room)}/grants/${encodeURIComponent(account)}`, null, token)
+}
+
+/** Invites `to` ({ email } or { account }) to the owner's session as `typeId`. `link` is the session's invite link, for the email. */
+export async function inviteToSession ({ token, room, typeId, to, link, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
+  const r = await call(fetchImpl, api, 'POST', `${room$(room)}/invites`, { typeId, to, link }, token)
+  if (!r.invite) throw new Error(BAD_REPLY)
+  return r.invite
+}
+
+export async function listSessionInvites ({ token, room, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
+  const r = await call(fetchImpl, api, 'GET', `${room$(room)}/invites`, null, token)
+  if (!Array.isArray(r.invites)) throw new Error(BAD_REPLY)
+  return r.invites
+}
+
+export async function cancelSessionInvite ({ token, room, id, api = apiUrl(), fetch: fetchImpl = globalThis.fetch }) {
+  await call(fetchImpl, api, 'DELETE', `${room$(room)}/invites/${encodeURIComponent(id)}`, null, token)
+}
+
 /** Revokes a token on the server, best effort, without touching account.json. */
 export async function revokeToken ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
   if (token) await call(fetchImpl, api, 'POST', '/v1/me/signout', {}, token, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => {})
```

Change `src/session.js`:

```diff
diff --git a/src/session.js b/src/session.js
index ee6d74b..259284a 100644
--- a/src/session.js
+++ b/src/session.js
@@ -255,10 +255,14 @@ export class Session extends EventEmitter {
 
   get isOwner () { return !!(this.access && this.access.owner) }
 
-  /** Owner only: let someone in, with a role and (for agents) the folders they may change. */
-  approve (key, { role, scopes } = {}) { return this.conn.adminRequest({ op: 'approve', key, role, scopes }) }
+  /**
+   * Owner only: let someone in, as an access type (`typeId`, with the `access` it comes to:
+   * { files, folders, foldersExcept, talk }), or, as before access types, with a role and
+   * the folders they may change.
+   */
+  approve (key, { role, scopes, typeId, access } = {}) { return this.conn.adminRequest({ op: 'approve', key, role, scopes, typeId, access }) }
   deny (key) { return this.conn.adminRequest({ op: 'deny', key }) }
-  setMember (key, { role, scopes } = {}) { return this.conn.adminRequest({ op: 'set', key, role, scopes }) }
+  setMember (key, { role, scopes, access } = {}) { return this.conn.adminRequest({ op: 'set', key, role, scopes, access }) }
   removeMember (key) { return this.conn.adminRequest({ op: 'remove', key }) }
 
   /** Owner only: names the session for everyone in it (1 to 80 characters). */
```

Change `src/ui-server.js`:

```diff
diff --git a/src/ui-server.js b/src/ui-server.js
index bb8043d..5f62a6c 100644
--- a/src/ui-server.js
+++ b/src/ui-server.js
@@ -14,7 +14,8 @@ import { getSettings, saveSettings, unsupportedRelay, relayUrl } from './setting
 import * as gitops from './git.js'
 import { installedEditors, openIn } from './editors.js'
 import { migrateDir } from './legacy.js'
-import { readAccount, saveAccount, clearAccount, startLink, waitForLink, fetchMe, signOut, revokeToken, accountFromProfile, renameSession, createAgentInvite, listAgents } from './account.js'
+import { readAccount, saveAccount, clearAccount, startLink, waitForLink, fetchMe, signOut, revokeToken, accountFromProfile, renameSession, createAgentInvite, listAgents, listAccessTypes, listCollaborators, listGrants, putGrant, deleteGrant, inviteToSession, listSessionInvites, cancelSessionInvite } from './account.js'
+import { effectiveAccess } from './session-access.js'
 import { cleanSessionName, BAD_SESSION_NAME, SESSION_NAME_MAX } from './session-name.js'
 import { personPasses } from './pass-source.js'
 import { INVALID_INVITE } from './ui/invite.js'
@@ -382,8 +383,82 @@ export async function startUi ({ port = 7420, onShutdown, preview = false } = {}
     }
   }
 
+  // Access types and invites (the owner's): the API keeps grants, the relay applies them.
+  const ACCOUNT = /^(person|agent):[A-Za-z0-9_-]{1,64}$/
+  const owned = (id) => {
+    const s = get(id)
+    if (!s.isOwner) throw httpError(403, 'Only the session owner can do that.')
+    return s
+  }
+  const typeById = async (token, typeId) => {
+    const type = (await listAccessTypes({ token })).find((t) => t.id === typeId)
+    if (!type) throw httpError(400, 'Pick an access type.')
+    return type
+  }
+  /** Runs `fn` against the API; anything but a 401 (which signs out) becomes a warning instead of an error. */
+  const tryApi = async (fn) => {
+    try { await fn(); return '' } catch (err) {
+      if (err.status === 401) throw err
+      return err.message
+    }
+  }
+
+  /**
+   * Lets someone in as an access type: the grant goes to the API first (so their next pass
+   * carries it), then the relay lets them in with the access it comes to. Someone who isn't
+   * an account (an older app) is still let in, with a warning that nothing was saved.
+   */
+  async function approveAs (id, { key, typeId }) {
+    const s = owned(id)
+    return asAccount(async (token) => {
+      const type = await typeById(token, typeId)
+      let access = effectiveAccess(type, {})
+      let warning = ''
+      if (ACCOUNT.test(String(key))) warning = await tryApi(async () => { access = (await putGrant({ token, room: s.room, account: key, typeId })).access })
+      await s.approve(key, { typeId, access })
+      return warning ? { ok: true, warning: `Let in, but their access wasn't saved on heyquilt.com: ${warning}` } : { ok: true }
+    })
+  }
+
+  /** Changes someone's access type and how it's narrowed: the API, then the relay at once. */
+  async function setAccess (id, { key, typeId, tighten }) {
+    const s = owned(id)
+    if (!ACCOUNT.test(String(key))) throw httpError(400, 'They joined before access types. Change their role instead.')
+    return asAccount(async (token) => {
+      const grant = await putGrant({ token, room: s.room, account: key, typeId, tighten })
+      await s.setMember(key, { access: grant.access })
+      return { grant }
+    })
+  }
+
+  /** Removes someone, and their grant, so they wait for the owner if they come back. */
+  async function removeMember (id, key) {
+    const s = owned(id)
+    if (ACCOUNT.test(String(key))) await asAccount((token) => tryApi(() => deleteGrant({ token, room: s.room, account: key })))
+    await s.removeMember(key)
+    return { ok: true }
+  }
+
+  /** Invites someone by email or account. The email carries the session's link: the view link for a view-only type. */
+  async function invite (id, { typeId, to }) {
+    const s = owned(id)
+    const run = runs.get(id).run
+    return asAccount(async (token) => {
+      const type = await typeById(token, typeId)
+      const link = type.files === 'view' && run.viewInvite ? run.viewInvite : run.invite
+      return { invite: await inviteToSession({ token, room: s.room, typeId, to, link }) }
+    })
+  }
+
   const api = {
     'GET /api/account': () => accountState(),
+    'GET /api/access-types': () => asAccount(async (token) => ({ types: await listAccessTypes({ token }) })),
+    'GET /api/collaborators': () => asAccount(async (token) => ({ collaborators: await listCollaborators({ token }) })),
+    'GET /api/sessions/:id/grants': (b, id) => { const s = owned(id); return asAccount(async (token) => ({ grants: await listGrants({ token, room: s.room }) })) },
+    'POST /api/sessions/:id/members/access': (b, id) => setAccess(id, b),
+    'GET /api/sessions/:id/invites': (b, id) => { const s = owned(id); return asAccount(async (token) => ({ invites: await listSessionInvites({ token, room: s.room }) })) },
+    'POST /api/sessions/:id/invites': (b, id) => invite(id, b),
+    'POST /api/sessions/:id/invites/cancel': (b, id) => { const s = owned(id); return asAccount(async (token) => { await cancelSessionInvite({ token, room: s.room, id: String(b.inviteId || '') }); return { ok: true } }) },
     'GET /api/agents': () => asAccount(async (token) => ({ agents: await listAgents({ token }) })),
     'POST /api/agent-invites': () => asAccount((token) => createAgentInvite({ token })),
     'POST /api/account/start': () => beginLink(),
@@ -425,10 +500,10 @@ export async function startUi ({ port = 7420, onShutdown, preview = false } = {}
       if (!f) throw httpError(404, 'That file is not in this session.')
       return f
     },
-    'POST /api/sessions/:id/members/approve': async (b, id) => (await get(id).approve(b.key, { role: b.role, scopes: b.scopes }), { ok: true }),
+    'POST /api/sessions/:id/members/approve': async (b, id) => b.typeId ? approveAs(id, b) : (await get(id).approve(b.key, { role: b.role, scopes: b.scopes }), { ok: true }),
     'POST /api/sessions/:id/members/deny': async (b, id) => (await get(id).deny(b.key), { ok: true }),
     'POST /api/sessions/:id/members/set': async (b, id) => (await get(id).setMember(b.key, { role: b.role, scopes: b.scopes }), { ok: true }),
-    'POST /api/sessions/:id/members/remove': async (b, id) => (await get(id).removeMember(b.key), { ok: true }),
+    'POST /api/sessions/:id/members/remove': (b, id) => removeMember(id, b.key),
     'POST /api/sessions/:id/rename': (b, id) => rename(id, b.name),
     'POST /api/sessions/:id/end': async (b, id) => { await get(id).endForEveryone(); await stop(id); return { ok: true } },
     'POST /api/sessions/:id/summarize': (b, id) => {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/ui-access.test.js test/ui-session-name.test.js test/ui-agents.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/account.js src/session.js src/ui-server.js test/ui-access.test.js
git commit -m "Access types: the app's server lets people in as a type, changes access, invites and removes, through the API and the relay"
```

---

### Task 14: The app: type picker, Access section, invite panel, no posting; release notes

The screens: the approve bar picks an access type (default Can edit); the people menu has an Access section per person (type, view only, folders taken away, no posting); the invite dialog invites as a type, from people you've worked with or by email, and lists pending invites with Cancel; chat is disabled with `You can't post in this session.` when you may not post. Plus the release notes and the version, 0.3.4.

**Files:**
- Modify: `RELEASES.md` (a new section at the top)
- Modify: `package.json`
- Modify: `src/ui/app.css` (new rules at the end)
- Modify: `src/ui/app.js`
- Modify: `src/ui/common.js`
- Modify: `src/ui/session.js`
- Create: `test/ui-access-screens.test.js`

**Interfaces:**
- Consumes: the app routes (Task 13).
- Produces: `src/ui/common.js`: `NO_POSTING`, `ACCOUNT_KEY`, `loadAccessTypes()`, `typeOptions(selected)`, `accessLine(member)`, `state.accessTypes`. Version `0.3.4` with its `RELEASES.md` section.

- [ ] **Step 1: Write the failing test**

Create `test/ui-access-screens.test.js`:

```js
// The app's screens for access types: the approve picker, the people menu's Access
// section, the invite panel, and a chat you can't post to. (There's no browser here:
// these check the code the app serves; ui-access.test.js checks what it calls.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const ui = (f) => fs.readFileSync(new URL(`../src/ui/${f}`, import.meta.url), 'utf8')
const EM_DASH = String.fromCharCode(0x2014)

test('the approve control picks an access type, defaulting to Can edit', () => {
  const s = ui('session.js')
  assert.ok(s.includes('name="typeId" aria-label="Let $' + '{esc(p.name)} in as"'))
  assert.ok(s.includes('{ key: f.dataset.key, typeId: f.typeId.value }'))
  assert.ok(s.includes("toast(r.warning || 'Let in')"))
  // The picker is a button (startDropdowns): the bar must not redraw under it while it's open.
  assert.ok(s.includes("if (bar.contains(active) && !active.closest('[type=submit],[data-deny]')) return"))
  assert.ok(ui('common.js').includes("export function typeOptions (selected = 'builtin:edit')"))
  assert.ok(ui('common.js').includes("api('GET', '/api/access-types')"))
})

test("the owner's Access section changes the type and narrows it", () => {
  const s = ui('session.js')
  for (const bit of ['class="pm-member edit pm-access"', 'name="viewOnly"', 'View only', 'name="noTalk"', 'No posting', 'name="foldersRemove"', '/members/access', '/grants']) assert.ok(s.includes(bit), bit)
})

test('the invite panel invites as a type, from people you have worked with or by email, and lists pending invites', () => {
  const a = ui('app.js')
  for (const bit of ['Invite as', "People you've worked with", 'data-invite-account', 'Invite by email', 'Send invite', 'Pending invites', 'data-cancel-invite', '/api/collaborators', '/invites/cancel']) assert.ok(a.includes(bit), bit)
})

test('without posting rights the chat input is disabled and says why', () => {
  const s = ui('session.js')
  assert.ok(ui('common.js').includes('export const NO_POSTING = "You can\'t post in this session."'))
  for (const bit of ['input.disabled = muted', "$('#attach-btn').disabled = muted", 'input.placeholder = NO_POSTING', 'if (mayNotPost()) return toast(NO_POSTING)']) assert.ok(s.includes(bit), bit)
})

test('no em dashes in the app', () => {
  for (const f of ['app.js', 'session.js', 'common.js', 'app.css']) assert.ok(!ui(f).includes(EM_DASH), f)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/ui-access-screens.test.js test/releases.test.js`
Expected: FAIL: the app has no type picker, Access section, invite panel or disabled composer yet.

- [ ] **Step 3: Implement**

Change `RELEASES.md` (a new section at the top):

```diff
diff --git a/RELEASES.md b/RELEASES.md
index b845b2f..9812742 100644
--- a/RELEASES.md
+++ b/RELEASES.md
@@ -9,6 +9,16 @@ Format: `## <version> — <YYYY-MM-DD>`, an optional one-line summary, then bull
 Lead each bullet with a short bold phrase. Inline `code` and **bold** are rendered;
 nothing else is.
 
+## 0.3.4 - 2026-10-02
+
+Access types, and invites that let people straight in.
+
+- **Access types.** Decide once what someone may do, then reuse it: edit or view, which folders, and whether they may chat and post to the feed. Every account has **Can edit** and **View only**; make your own on heyquilt.com under **Access types**.
+- **Let people in as a type.** When someone asks to join, pick their access type and click **Let in**. Later, the people menu's **Access** section changes their type, or narrows it for this session only: view only, folders taken away, or no posting. It never gives more than the type.
+- **Invite people straight in.** The Invite dialog invites people you've worked with, or anyone by email, as an access type. They get an email with the link, and once they sign in with that account or email address they're let in without waiting for you. Pending invites can be cancelled there too.
+- **No posting means no posting.** Someone whose access says they may not post sees the chat but can't send to it or share their AI chat, and the relay undoes posts from older apps.
+- **For agents too.** Agents you invite, including cloud agents on `api.heyquilt.com/mcp`, get the same access types, and the relay holds them to it.
+
 ## 0.3.3 — 2026-10-02
 
 Named sessions, your sessions on heyquilt.com, and Settings from inside a session.
```

Bump the version: `npm version 0.3.4 --no-git-tag-version` (changes `package.json` and `package-lock.json`).

Change `src/ui/app.css` (new rules at the end):

```diff
diff --git a/src/ui/app.css b/src/ui/app.css
index c92bfcf..2b068f7 100644
--- a/src/ui/app.css
+++ b/src/ui/app.css
@@ -907,3 +907,18 @@ body.has-update #app { padding-top: var(--update-bar); } /* padding, not margin:
   .rn-head { padding: 24px 48px 14px; }
   #update-bar .ub-text { font-size: 12px; }
 }
+
+/* access types: the invite panel, the people menu's Access section, and a chat you can't post to */
+.inv-sub { margin: 14px 0 6px; }
+.inv-section #inv-type { width: 100%; }
+.inv-section .hint { margin: 6px 0 0; }
+.inv-list { display: flex; flex-direction: column; gap: 4px; }
+.inv-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; }
+.inv-row .avatar { width: 24px; height: 24px; font-size: 11px; }
+.inv-row .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
+.inv-section .error:empty { display: none; }
+.pm-access .pm-now { flex-basis: 100%; }
+.pm-access select.input { flex: 1; }
+.pm-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); }
+.composer.muted .box { opacity: .6; }
+.composer.muted textarea { cursor: not-allowed; }
```

Change `src/ui/app.js`:

```diff
diff --git a/src/ui/app.js b/src/ui/app.js
index e39924f..129e96a 100644
--- a/src/ui/app.js
+++ b/src/ui/app.js
@@ -1,6 +1,6 @@
 // Quilt app: boot, live events, home screen, folder picker and invites.
 // The session workspace lives in session.js. Plain ES modules, no build step.
-import { TOKEN, I, state, $, esc, basename, toast, api, ask, decodeInvite, remember, recall, startDropdowns } from './common.js'
+import { TOKEN, I, state, $, esc, basename, toast, api, ask, decodeInvite, remember, recall, startDropdowns, avatar, loadAccessTypes, typeOptions } from './common.js'
 import { renderShell, joinSessionDialog } from './home.js'
 import { mountSession, sessionUpdated, sessionMessage, sessionFeed, sessionFileChanged, sessionLog, sessionUnmount } from './session.js'
 import { quiltMark } from './mark.js'
@@ -305,6 +305,8 @@ export function openInvite (id) {
   const s = state.sessions.get(id)
   if (!s) return
   const d = decodeInvite(s.invite)
+  // The owner of a session with approvals can invite people as an access type.
+  const owner = !!(s.viewInvite && s.status.access?.owner)
   const back = document.createElement('div')
   back.className = 'modal-back'
   back.innerHTML = `<div class="card modal" role="dialog" aria-modal="true" aria-labelledby="inv-title">
@@ -316,6 +318,21 @@ export function openInvite (id) {
     <div class="codebox"><code id="inv-view">${esc(s.viewInvite)}</code><button class="btn icon" data-copy="inv-view" title="Copy" aria-label="Copy view-only link">${I.copy}</button></div>` : ''}
     ${d ? `<p class="hint">Room <code>${esc(d.room)}</code> via <code>${esc(d.server)}</code></p>` : ''}
     <p class="hint">${s.viewInvite ? 'Everyone who uses a link waits until you let them in, and you can change what they may do later from the people menu.' : 'Anyone with this link can edit the project. Only share it with people you trust.'}</p>
+    ${owner ? `<div class="inv-section" id="inv-access">
+      <div class="label inv-agent-label">Invite as</div>
+      <select class="input" id="inv-type" aria-label="Invite as"></select>
+      <p class="hint">People you invite here get straight in with this access once they sign in. No waiting for you.</p>
+      <div class="label inv-sub">People you've worked with</div>
+      <div class="inv-list" id="inv-people"><p class="hint">Loading…</p></div>
+      <div class="label inv-sub">Invite by email</div>
+      <form class="row" id="inv-email-form">
+        <input class="input grow" type="email" id="inv-email" placeholder="name@example.com" aria-label="Email address" required>
+        <button class="btn primary" type="submit">Send invite</button>
+      </form>
+      <div class="label inv-sub">Pending invites</div>
+      <div class="inv-list" id="inv-pending"></div>
+      <p class="error" id="inv-error"></p>
+    </div>` : ''}
     <div class="label inv-agent-label">Your AI</div>
     <div id="inv-agent" class="inv-agent">
       <p class="hint">An AI that already has the Quilt command just needs the link above: tell it "Join my Quilt session: &lt;link&gt;". To add an AI that isn't registered with Quilt yet, make it an agent invite and paste the text into it. It joins as your own agent, listed in Settings.</p>
@@ -348,6 +365,60 @@ export function openInvite (id) {
   }
   $('#inv-done', back).onclick = close
   back.onclick = (e) => { if (e.target === back) close() }
+  if (owner) bindInviteAs(id, back)
+}
+
+/** The owner's invite panel: "Invite as" a type, people you've worked with, by email, and pending invites. */
+function bindInviteAs (id, back) {
+  const error = (msg) => { $('#inv-error', back).textContent = msg || '' }
+  const typeId = () => $('#inv-type', back).value
+  const invite = async (to, done) => {
+    error('')
+    try {
+      await api('POST', `/api/sessions/${id}/invites`, { typeId: typeId(), to })
+      toast(done)
+      await pending()
+    } catch (err) { error(err.message) }
+  }
+  async function pending () {
+    const el = $('#inv-pending', back)
+    try {
+      const open = (await api('GET', `/api/sessions/${id}/invites`)).invites.filter((i) => i.status === 'waiting')
+      el.innerHTML = open.length
+        ? open.map((i) => `<div class="inv-row"><span class="grow">${esc(i.email || i.name)}<span class="hint"> · ${esc(i.typeName)}</span></span><button class="btn sm ghost" type="button" data-cancel-invite="${esc(i.id)}">Cancel</button></div>`).join('')
+        : '<p class="hint">No pending invites.</p>'
+    } catch (err) { el.innerHTML = `<p class="hint">${esc(err.message)}</p>` }
+  }
+  async function people () {
+    const el = $('#inv-people', back)
+    try {
+      const list = (await api('GET', '/api/collaborators')).collaborators
+      el.innerHTML = list.length
+        ? list.map((c) => `<div class="inv-row">${avatar(c.name, null)}<span class="grow">${esc(c.name)}${c.kind === 'agent' ? `<span class="tag bot">${I.bot}agent</span>` : ''}</span><button class="btn sm" type="button" data-invite-account="${esc(c.account)}" data-name="${esc(c.name)}">Invite</button></div>`).join('')
+        : "<p class=\"hint\">Nobody yet. People and agents you've been in a session with show up here.</p>"
+    } catch (err) { el.innerHTML = `<p class="hint">${esc(err.message)}</p>` }
+  }
+  ;(state.accessTypes ? Promise.resolve(state.accessTypes) : loadAccessTypes()).then((types) => {
+    const sel = $('#inv-type', back)
+    if (types) sel.innerHTML = typeOptions()
+    else { sel.innerHTML = '<option value="builtin:edit">Can edit</option><option value="builtin:view">View only</option>' }
+  })
+  people()
+  pending()
+  back.addEventListener('click', async (e) => {
+    const inv = e.target.closest('[data-invite-account]')
+    if (inv) { inv.disabled = true; await invite({ account: inv.dataset.inviteAccount }, `Invited ${inv.dataset.name}`); inv.disabled = false; return }
+    const cancel = e.target.closest('[data-cancel-invite]')
+    if (cancel) {
+      try { await api('POST', `/api/sessions/${id}/invites/cancel`, { inviteId: cancel.dataset.cancelInvite }); toast('Invite cancelled'); await pending() } catch (err) { error(err.message) }
+    }
+  })
+  $('#inv-email-form', back).onsubmit = async (e) => {
+    e.preventDefault()
+    const input = $('#inv-email', back)
+    await invite({ email: input.value.trim() }, 'Invite sent')
+    if (!$('#inv-error', back).textContent) input.value = ''
+  }
 }
 
 /** A fresh agent invite, as the text to paste into an AI, with Copy. */
```

Change `src/ui/common.js`:

```diff
diff --git a/src/ui/common.js b/src/ui/common.js
index f5bd7d8..272a6ae 100644
--- a/src/ui/common.js
+++ b/src/ui/common.js
@@ -68,7 +68,8 @@ export const state = {
   feeds: new Map(), // session id -> Map(person -> entries[])
   trees: new Map(), // session id -> { files, claims }
   files: new Map(), // `${id}\n${path}` -> file contents from /file
-  ws: new Map() // session id -> workspace layout (mode, tabs, expanded folders)
+  ws: new Map(), // session id -> workspace layout (mode, tabs, expanded folders)
+  accessTypes: null // the account's access types (built-ins first), once loaded; null if the API can't be reached
 }
 
 // -------------------------------------------------------------- helpers --
@@ -150,6 +151,30 @@ export async function api (method, path, body, headers = {}) {
   return data
 }
 
+// ------------------------------------------------------------ access types --
+export const NO_POSTING = "You can't post in this session."
+export const ACCOUNT_KEY = /^(person|agent):[A-Za-z0-9_-]{1,64}$/
+
+/** Loads this account's access types into state.accessTypes (null when the accounts API can't be reached). */
+export async function loadAccessTypes () {
+  try { state.accessTypes = (await api('GET', '/api/access-types')).types } catch { state.accessTypes = null }
+  return state.accessTypes
+}
+
+/** <option>s for an access type picker, "Can edit" selected unless `selected` says otherwise. */
+export function typeOptions (selected = 'builtin:edit') {
+  return (state.accessTypes || []).map((t) => `<option value="${esc(t.id)}" ${t.id === selected ? 'selected' : ''}>${esc(t.name)}</option>`).join('')
+}
+
+/** "Can edit · src · except src/keys · no posting": what someone's access comes to, from the relay's member list. */
+export function accessLine (m) {
+  if (m.role === 'viewer') return m.talk === false ? 'View only · no posting' : 'View only'
+  const parts = ['Can edit', m.scopes && m.scopes.length ? m.scopes.join(', ') : 'all folders']
+  if (m.scopesExcept && m.scopesExcept.length) parts.push(`except ${m.scopesExcept.join(', ')}`)
+  if (m.talk === false) parts.push('no posting')
+  return parts.join(' · ')
+}
+
 /**
  * Same as decodeInvite in runner.js (room and relay only): an invite link, or an older base64 code.
  * A link naming its own relay must name Quilt's relay or the one this app uses (state.defaults.relay).
```

Change `src/ui/session.js`:

```diff
diff --git a/src/ui/session.js b/src/ui/session.js
index 5c3afa7..7e50206 100644
--- a/src/ui/session.js
+++ b/src/ui/session.js
@@ -1,6 +1,6 @@
 // The session workspace: file tree on the left, a partner's live AI chat or a
 // shared file in the middle, and the team chat on the right.
-import { TOKEN, I, state, $, esc, basename, bytes, clock, avatar, toast, api, ask, remember, recall, toolsOf, busyPeople } from './common.js'
+import { TOKEN, I, state, $, esc, basename, bytes, clock, avatar, toast, api, ask, remember, recall, toolsOf, busyPeople, NO_POSTING, ACCOUNT_KEY, loadAccessTypes, typeOptions, accessLine } from './common.js'
 import { openInvite, renderTabs, markRead } from './app.js'
 import { renderFeed } from './feed.js'
 import { renderTree, openTreeMenu, closeTreeMenu, claimFolder } from './tree.js'
@@ -12,6 +12,7 @@ import { fileCardHref, renderable } from './chat.js'
 
 let current = null // session id being shown
 let timers = []
+let grants = new Map() // account -> its grant in this session (the owner's view, from the API)
 let mounted = null // AbortController for document-level listeners of this mount
 
 // ------------------------------------------------------------ layout state --
@@ -127,6 +128,10 @@ export function mountSession (id) {
   renderTreePane()
   renderMessages(false, true)
   renderRecipients()
+  renderComposer()
+  grants = new Map()
+  // The approve control and the people menu offer access types once they're here.
+  loadAccessTypes().then(() => { if (current === id) { renderAccess(); if (!$('#people-menu').hidden) renderPeopleMenu() } })
   loadTree()
   loadFeeds()
   autoOpenNewPeople(id) // everyone already here gets a tab on first visit
@@ -154,6 +159,7 @@ export function sessionUpdated (id) {
   renderTop()
   renderMainBar()
   renderRecipients()
+  renderComposer()
   if (ws(id).mode === 'ai') renderMain()
   scheduleTree()
 }
@@ -283,7 +289,12 @@ function bindTop () {
   const menu = $('#people-menu')
   let hoverTimer
   let openedAt = 0
-  const open = () => { clearTimeout(hoverTimer); if (menu.hidden) { menu.hidden = false; openedAt = Date.now(); btn.setAttribute('aria-expanded', 'true'); renderPeopleMenu() } }
+  const open = () => {
+    clearTimeout(hoverTimer)
+    if (!menu.hidden) return
+    menu.hidden = false; openedAt = Date.now(); btn.setAttribute('aria-expanded', 'true'); renderPeopleMenu()
+    if (sum().status.access?.owner) loadGrants()
+  }
   const close = () => { clearTimeout(hoverTimer); menu.hidden = true; btn.setAttribute('aria-expanded', 'false') }
   // A click also focuses (and may hover) the button, which already opened the menu; don't toggle it shut.
   btn.onclick = () => (menu.hidden ? open() : Date.now() - openedAt > 400 && close())
@@ -337,7 +348,8 @@ function bindTop () {
   })
   menu.addEventListener('change', async (e) => {
     const f = e.target.closest('.pm-member.edit')
-    if (!f) return
+    // Access types are saved with Save (below), not on every change.
+    if (!f || f.classList.contains('pm-access')) return
     try {
       await api('POST', `/api/sessions/${current}/members/set`, { key: f.dataset.key, role: f.role.value, ...(f.scopes ? { scopes: parseScopes(f.scopes.value) } : {}) })
       toast('Access updated')
@@ -357,6 +369,22 @@ function bindTop () {
       return
     }
   })
+  menu.addEventListener('submit', async (e) => {
+    const f = e.target.closest('.pm-access')
+    if (!f) return
+    e.preventDefault()
+    const tighten = { ...(f.viewOnly.checked ? { files: 'view' } : {}), ...(f.noTalk.checked ? { talk: false } : {}), foldersRemove: parseScopes(f.foldersRemove.value) }
+    const save = f.querySelector('[type=submit]')
+    save.disabled = true
+    try {
+      const r = await api('POST', `/api/sessions/${current}/members/access`, { key: f.dataset.key, typeId: f.typeId.value, tighten })
+      grants.set(f.dataset.key, r.grant)
+      toast('Access updated')
+      // The relay's member list may have redrawn the form meanwhile, from the old grant.
+      save.blur()
+      renderPeopleMenu()
+    } catch (err) { toast(err.message) } finally { save.disabled = false }
+  })
   menu.addEventListener('submit', async (e) => {
     e.preventDefault()
     if (e.target.closest('.pm-member')) return
@@ -446,9 +474,12 @@ function renderAccess () {
   const acc = st.access || {}
   const pill = $('#access-pill')
   if (pill) {
-    const text = acc.state === 'pending' ? 'Waiting to be let in'
-      : acc.controlled && acc.role === 'viewer' ? 'View only'
-        : acc.controlled && acc.scopes && acc.scopes.length ? `Can change ${scopesText(acc.scopes)}` : ''
+    const parts = acc.state === 'pending' ? ['Waiting to be let in'] : !acc.controlled ? [] : [
+      ...(acc.role === 'viewer' ? ['View only'] : acc.scopes && acc.scopes.length ? [`Can change ${scopesText(acc.scopes)}`] : []),
+      ...(acc.role !== 'viewer' && acc.scopesExcept && acc.scopesExcept.length ? [`Not ${scopesText(acc.scopesExcept)}`] : []),
+      ...(acc.talk === false ? ["Can't post"] : [])
+    ]
+    const text = parts.join(' · ')
     pill.hidden = !text
     pill.textContent = text
     pill.className = `access-pill${acc.state === 'pending' ? ' wait' : ''}`
@@ -456,19 +487,23 @@ function renderAccess () {
   const bar = $('#requests')
   if (!bar) return
   const waiting = st.waiting || []
-  // Don't redraw while the owner is filling in a request.
-  if (bar.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return
+  // Don't redraw while the owner is filling in a request (the type picker is a button, see
+  // startDropdowns), only once they've let someone in or denied them.
+  const active = document.activeElement
+  if (bar.contains(active) && !active.closest('[type=submit],[data-deny]')) return
   bar.hidden = !waiting.length
   bar.innerHTML = waiting.map((p) => `
     <form class="request" data-key="${esc(p.key)}">
       ${avatar(p.name, null)}
       <div class="rq-main"><b>${esc(p.name)}</b>${p.kind === 'agent' ? `<span class="tag bot">${I.bot}agent</span>` : ''}
         <span class="hint">wants to join · invited to ${p.invitedAs === 'viewer' ? 'view' : 'edit'}</span></div>
-      <select class="input" name="role" aria-label="Role for ${esc(p.name)}">
+      ${state.accessTypes
+        ? `<select class="input" name="typeId" aria-label="Let ${esc(p.name)} in as" title="What they may do: an access type">${typeOptions()}</select>`
+        : `<select class="input" name="role" aria-label="Role for ${esc(p.name)}">
         <option value="editor" ${p.invitedAs !== 'viewer' ? 'selected' : ''}>Can edit</option>
         <option value="viewer" ${p.invitedAs === 'viewer' ? 'selected' : ''}>View only</option>
       </select>
-      ${p.kind === 'agent' ? `<input class="input" name="scopes" placeholder="All folders (or e.g. src, docs)" aria-label="Folders ${esc(p.name)} may change" title="Folders this agent may change, separated by commas">` : ''}
+      ${p.kind === 'agent' ? `<input class="input" name="scopes" placeholder="All folders (or e.g. src, docs)" aria-label="Folders ${esc(p.name)} may change" title="Folders this agent may change, separated by commas">` : ''}`}
       <button type="button" class="btn sm ghost" data-deny>Deny</button>
       <button type="submit" class="btn sm primary">Let in</button>
     </form>`).join('')
@@ -482,8 +517,9 @@ function bindAccess () {
     const btn = f.querySelector('[type=submit]')
     btn.disabled = true
     try {
-      await api('POST', `/api/sessions/${current}/members/approve`, { key: f.dataset.key, role: f.role.value, scopes: f.scopes ? parseScopes(f.scopes.value) : [] })
-      toast('Let in')
+      const body = f.typeId ? { key: f.dataset.key, typeId: f.typeId.value } : { key: f.dataset.key, role: f.role.value, scopes: f.scopes ? parseScopes(f.scopes.value) : [] }
+      const r = await api('POST', `/api/sessions/${current}/members/approve`, body)
+      toast(r.warning || 'Let in')
     } catch (err) { toast(err.message); btn.disabled = false }
   })
   bar.addEventListener('click', async (e) => {
@@ -511,7 +547,7 @@ function membersHtml (st) {
       ${(st.members || []).map((m) => `<div class="pm-member"><span class="nm">${esc(m.name)}${m.kind === 'agent' ? ' (agent)' : ''}</span><span class="tag">${roleLabel(m.role)}</span>${m.scopes && m.scopes.length ? `<span class="hint">${esc(scopesText(m.scopes))}</span>` : ''}</div>`).join('')}</div>` : ''
   }
   return `<div class="pm-section"><div class="pm-title">Who can get in</div>
-    ${list.length ? list.map((m) => `
+    ${list.length ? list.map((m) => state.accessTypes && ACCOUNT_KEY.test(m.key) ? accessForm(m) : `
       <form class="pm-member edit" data-key="${esc(m.key)}">
         <span class="nm" title="${m.online ? 'Online' : 'Offline'}"><span class="dot" style="background:${m.online ? 'var(--ok)' : 'var(--faint)'}"></span>${esc(m.name)}${m.kind === 'agent' ? ' (agent)' : ''}</span>
         <select class="input" name="role" aria-label="Role for ${esc(m.name)}">
@@ -525,6 +561,39 @@ function membersHtml (st) {
     <div class="pm-foot"><button type="button" class="btn sm ghost danger" data-end-session>End session for everyone</button></div>`
 }
 
+/**
+ * The owner's "Access" section for one person: their access type, and how it's narrowed
+ * for them here (view only, folders taken away, no posting). It never widens the type.
+ */
+function accessForm (m) {
+  const g = grants.get(m.key)
+  const t = g?.tighten || {}
+  const typeId = g?.typeId || (m.role === 'viewer' ? 'builtin:view' : 'builtin:edit')
+  const name = esc(m.name)
+  return `
+      <form class="pm-member edit pm-access" data-key="${esc(m.key)}">
+        <span class="nm" title="${m.online ? 'Online' : 'Offline'}"><span class="dot" style="background:${m.online ? 'var(--ok)' : 'var(--faint)'}"></span>${name}${m.kind === 'agent' ? ' (agent)' : ''}</span>
+        <span class="hint pm-now">${esc(accessLine(m))}</span>
+        <select class="input" name="typeId" aria-label="Access type for ${name}">${typeOptions(typeId)}</select>
+        <label class="pm-check"><input type="checkbox" name="viewOnly" ${t.files === 'view' ? 'checked' : ''}> View only</label>
+        <label class="pm-check"><input type="checkbox" name="noTalk" ${t.talk === false ? 'checked' : ''}> No posting</label>
+        <input class="input" name="foldersRemove" value="${esc(scopesText(t.foldersRemove))}" placeholder="Take away folders, e.g. secrets" aria-label="Folders ${name} may not change" title="Folders taken away from this person, separated by commas">
+        <button type="submit" class="btn sm">Save</button>
+        <button type="button" class="btn sm ghost icon" data-remove title="Remove ${name}" aria-label="Remove ${name}">${I.x}</button>
+      </form>`
+}
+
+/** The owner's grants in this session, from the API, for the Access sections. */
+async function loadGrants () {
+  const id = current
+  try {
+    const r = await api('GET', `/api/sessions/${id}/grants`)
+    if (id !== current) return
+    grants = new Map(r.grants.map((g) => [g.account, g]))
+    if (!$('#people-menu').hidden) renderPeopleMenu()
+  } catch {}
+}
+
 function renderPeopleMenu () {
   const st = sum().status
   const menu = $('#people-menu')
@@ -929,7 +998,7 @@ function bindChat () {
     } catch (err) {
       toast(err.message)
     } finally {
-      $('#send-btn').disabled = false
+      $('#send-btn').disabled = mayNotPost()
       input.focus()
     }
   }
@@ -952,6 +1021,7 @@ function bindChat () {
 }
 
 function addFiles (list) {
+  if (mayNotPost()) return toast(NO_POSTING)
   for (const f of list) {
     if (state.maxFileBytes && f.size > state.maxFileBytes) { toast(`${f.name} is larger than ${bytes(state.maxFileBytes)}`); continue }
     state.pending.push(f)
@@ -967,9 +1037,28 @@ function renderAttachments () {
   updatePlaceholder()
 }
 
+/** Someone who may not post sees the chat, but not a way to post to it. */
+function renderComposer () {
+  const input = $('#msg-input')
+  const s = sum()
+  if (!input || !s) return
+  const muted = mayNotPost()
+  input.disabled = muted
+  $('#attach-btn').disabled = muted
+  $('#send-btn').disabled = muted
+  $('#composer').classList.toggle('muted', muted)
+  updatePlaceholder()
+}
+
+function mayNotPost () {
+  const acc = sum()?.status.access
+  return !!(acc && acc.state === 'approved' && acc.talk === false)
+}
+
 function updatePlaceholder () {
   const input = $('#msg-input')
   if (!input) return
+  if (mayNotPost()) { input.placeholder = NO_POSTING; return }
   const who = state.to ? state.to : 'everyone'
   input.placeholder = state.pending.length ? `Add a note for ${who} (optional)…` : `Message ${who}…`
 }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/ui-access-screens.test.js test/releases.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

Then look at it: run the app against a local API and relay (as `test/ui-access.test.js` sets them up), let someone in as a type, open the people menu's Access section, and open Invite. The type picker must stay open while you choose (it is a button, so the bar must not redraw under it).

- [ ] **Step 5: Commit**

```bash
git add RELEASES.md package-lock.json package.json src/ui/app.css src/ui/app.js src/ui/common.js src/ui/session.js test/ui-access-screens.test.js
git commit -m "Access types in the app: pick a type to let people in, an Access section, invites, and no posting; release notes for 0.3.4"
```

---

### Task 15: Access types on heyquilt.com

Dashboard, Access types (`/dashboard/access`): the built-ins, your own types with inline edit and an in-page delete confirmation, and a form for a new one.

**Files:**
- Create: `web/app/dashboard/access/actions.js`
- Create: `web/app/dashboard/access/page.js`
- Modify: `web/app/globals.css` (new rules at the end)
- Create: `web/components/ConfirmDelete.js`
- Create: `web/lib/access-form.js`
- Modify: `web/lib/nav.js`
- Create: `web/test/access-form.test.js`
- Modify: `web/test/nav.test.js`
- Modify: `web/test/routes.test.js`

**Interfaces:**
- Consumes: `/v1/access-types` (Task 4) through `apiCall`; `requireUser`; `Notice`.
- Produces: `web/lib/access-form.js` (`typeFromForm(formData)`, `foldersText(folders)`, `describeType(type)`); server actions `createAccessType`, `saveAccessType`, `deleteAccessType`; `web/components/ConfirmDelete.js` (`{ action, what, note }`); the personal tab "Access types".

- [ ] **Step 1: Write the failing tests**

Create `web/test/access-form.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { typeFromForm, foldersText, describeType } from '../lib/access-form.js'

const form = (fields) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); return f }

test('a type from its form: folders one per line, posting from the switch', () => {
  assert.deepEqual(typeFromForm(form({ name: ' Docs writer ', files: 'edit', folders: 'docs\n\n  web/app  \n', talk: 'on' })), { name: 'Docs writer', files: 'edit', folders: ['docs', 'web/app'], talk: true })
  assert.deepEqual(typeFromForm(form({ name: 'Reviewer', files: 'view' })), { name: 'Reviewer', files: 'view', folders: [], talk: false }, 'an unticked switch sends nothing')
  assert.equal(typeFromForm(form({ name: 'x', files: 'admin' })).files, 'edit', 'only edit or view')
})

test('folders back into the form, and a type at a glance', () => {
  assert.equal(foldersText(['docs', 'web']), 'docs\nweb')
  assert.equal(foldersText(undefined), '')
  assert.equal(describeType({ files: 'edit', folders: [], talk: true }), 'Can edit · all folders · may post')
  assert.equal(describeType({ files: 'edit', folders: ['docs'], talk: false }), 'Can edit · docs · no posting')
  assert.equal(describeType({ files: 'view', folders: [], talk: true }), 'View only · may post')
})
```

Change `web/test/nav.test.js` (these hunks):

```diff
diff --git a/web/test/nav.test.js b/web/test/nav.test.js
index 173f5f1..3044262 100644
--- a/web/test/nav.test.js
+++ b/web/test/nav.test.js
@@ -8,6 +8,7 @@ test('exactly one personal tab is on for each personal page', () => {
   assert.deepEqual(active('/dashboard'), ['Dashboard'])
   assert.deepEqual(active('/dashboard/computers'), ['Computers'])
   assert.deepEqual(active('/dashboard/agents'), ['Agents'])
+  assert.deepEqual(active('/dashboard/access'), ['Access types'])
   assert.deepEqual(active('/settings'), [])
 })
 
```

Change `web/test/routes.test.js` (these hunks):

```diff
diff --git a/web/test/routes.test.js b/web/test/routes.test.js
index f9e212f..6edc3ca 100644
--- a/web/test/routes.test.js
+++ b/web/test/routes.test.js
@@ -51,9 +51,9 @@ test('the homepage serves sized WebP screenshots, lazily below the fold, and bot
 })
 
 // The proxy redirects signed-out people before routing, so check the pages really exist too.
-test('Computers, Agents and each session have their own pages under the dashboard', () => {
+test('Computers, Agents, Access types and each session have their own pages under the dashboard', () => {
   const pages = Object.keys(JSON.parse(readFileSync(new URL('../.next/server/app-paths-manifest.json', import.meta.url))))
-  for (const page of ['/dashboard/page', '/dashboard/computers/page', '/dashboard/agents/page', '/dashboard/sessions/[room]/page']) assert.ok(pages.includes(page), page)
+  for (const page of ['/dashboard/page', '/dashboard/computers/page', '/dashboard/agents/page', '/dashboard/access/page', '/dashboard/sessions/[room]/page']) assert.ok(pages.includes(page), page)
 })
 
 // Static images skip the proxy: it would run getClaims() and could add Set-Cookie, which stops CDN caching.
@@ -64,7 +64,7 @@ test('screenshots are served without running the proxy (no Set-Cookie)', async (
 })
 
 test('private pages send signed-out people to sign in, and come back after', async () => {
-  for (const path of ['/dashboard', '/dashboard/computers', '/dashboard/agents', '/dashboard/sessions/room-abc', '/settings', '/link?code=AAAA-BBBB', '/reset', '/org/acme', '/org/acme/people', '/org/acme/roles', '/org/acme/teams', '/org/acme/invites', '/org/acme/settings', '/invite/qi_test']) {
+  for (const path of ['/dashboard', '/dashboard/computers', '/dashboard/agents', '/dashboard/access', '/dashboard/sessions/room-abc', '/settings', '/link?code=AAAA-BBBB', '/reset', '/org/acme', '/org/acme/people', '/org/acme/roles', '/org/acme/teams', '/org/acme/invites', '/org/acme/settings', '/invite/qi_test']) {
     const res = await get(path)
     assert.equal(res.status, 307, path)
     const to = new URL(res.headers.get('location'), base)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && npm test`
Expected: FAIL: `Cannot find module '../lib/access-form.js'`, the nav has no Access types tab, and the build has no `/dashboard/access/page`.

- [ ] **Step 3: Implement**

Create `web/app/dashboard/access/actions.js`:

```js
'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { typeFromForm } from '@/lib/access-form.js'

// Access types: each action goes to the accounts API, then back to the page with
// "Saved." or the API's reason.
const PAGE = '/dashboard/access'
const back = (r, fallback) => {
  revalidatePath(PAGE)
  redirect(r.ok ? `${PAGE}?saved=1` : `${PAGE}?error=${encodeURIComponent(r.data?.error || fallback)}`)
}
const idOf = (formData) => encodeURIComponent(String(formData.get('id') || ''))

export async function createAccessType (formData) {
  const user = await requireUser(PAGE)
  back(await apiCall(user, 'POST', '/v1/access-types', typeFromForm(formData)), 'Couldn’t create the access type. Try again.')
}

export async function saveAccessType (formData) {
  const user = await requireUser(PAGE)
  back(await apiCall(user, 'PUT', `/v1/access-types/${idOf(formData)}`, typeFromForm(formData)), 'Couldn’t save the access type. Try again.')
}

// Grants that used it become View only (the API does that).
export async function deleteAccessType (formData) {
  const user = await requireUser(PAGE)
  back(await apiCall(user, 'DELETE', `/v1/access-types/${idOf(formData)}`), 'Couldn’t delete the access type. Try again.')
}
```

Create `web/app/dashboard/access/page.js`:

```js
import AppHeader from '@/components/AppHeader.js'
import Notice from '@/components/Notice.js'
import ConfirmDelete from '@/components/ConfirmDelete.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { describeType, foldersText } from '@/lib/access-form.js'
import { createAccessType, saveAccessType, deleteAccessType } from './actions.js'

export const metadata = { title: 'Access types' }

/** The fields of a type's form, filled in from `t` (empty for a new one). */
function Fields ({ t = {}, id }) {
  return (
    <>
      <div className='field'>
        <label htmlFor={`${id}-name`}>Name</label>
        <input className='input' id={`${id}-name`} name='name' defaultValue={t.name || ''} maxLength={40} required />
      </div>
      <div className='field'>
        <label htmlFor={`${id}-files`}>Files</label>
        <select className='input' id={`${id}-files`} name='files' defaultValue={t.files || 'edit'}>
          <option value='edit'>Can edit</option>
          <option value='view'>View only</option>
        </select>
      </div>
      <div className='field'>
        <label htmlFor={`${id}-folders`}>Folders</label>
        <textarea className='input textarea' id={`${id}-folders`} name='folders' rows={3} defaultValue={foldersText(t.folders)} placeholder='All folders' />
        <span className='muted small'>One per line, like src or docs. Leave empty for every folder.</span>
      </div>
      <label className='row switch'>
        <input type='checkbox' role='switch' name='talk' defaultChecked={t.talk !== false} /> May chat and post to the feed
      </label>
    </>
  )
}

export default async function AccessTypes ({ searchParams }) {
  const q = await searchParams
  const user = await requireUser('/dashboard/access')
  const r = await apiCall(user, 'GET', '/v1/access-types')
  const types = r.data?.types || []
  const own = types.filter((t) => !t.builtin)
  return (
    <>
      <AppHeader user={user} space='personal' />
      <main className='wrap page stack'>
        <h1 style={{ fontSize: 32 }}>Access types</h1>
        <p className='muted'>What someone may do in a session: edit or only view, which folders, and whether they may chat and post to the feed. In the Quilt app, you let people in and invite them as one of these. In a session you can narrow someone's access further, but never past their type.</p>
        <Notice q={q} />
        {!r.ok && <p className='notice bad'>Couldn't load your access types right now.</p>}
        <section className='card stack'>
          <h2>Your access types</h2>
          {types.filter((t) => t.builtin).map((t) => (
            <div key={t.id} className='list-row'>
              <span><b>{t.name}</b> <span className='pill'>Built in</span><br /><span className='muted'>{describeType(t)}</span></span>
            </div>))}
          {own.map((t) => (
            <details key={t.id} className='list-row access-type'>
              <summary><span><b>{t.name}</b><br /><span className='muted'>{describeType(t)}</span></span><span className='btn ghost'>Edit</span></summary>
              <form action={saveAccessType} className='stack fields-narrow'>
                <input type='hidden' name='id' value={t.id} />
                <Fields t={t} id={t.id} />
                <div className='row'>
                  <button className='btn primary'>Save</button>
                  <ConfirmDelete action={deleteAccessType} what={t.name} note='People who have it get View only.' />
                </div>
              </form>
            </details>))}
          {r.ok && !own.length && <p className='muted'>No access types of your own yet. Make one below.</p>}
        </section>
        <form action={createAccessType} className='card stack fields-narrow'>
          <h2>New access type</h2>
          <Fields id='new' />
          <div><button className='btn primary'>Create access type</button></div>
        </form>
      </main>
    </>
  )
}
```

Change `web/app/globals.css` (new rules at the end):

```diff
diff --git a/web/app/globals.css b/web/app/globals.css
index e2846ab..015e30f 100644
--- a/web/app/globals.css
+++ b/web/app/globals.css
@@ -396,3 +396,13 @@ code, .mono { font-family: var(--mono); font-size: 13px; }
 @media (max-width: 420px) {
   .agent-caps { grid-template-columns: 1fr; }
 }
+
+/* access types */
+.textarea { height: auto; padding: 10px 12px; resize: vertical; font: inherit; }
+.small { font-size: 13px; }
+.switch { gap: 8px; font-size: 15px; }
+details.access-type { display: block; }
+details.access-type > summary { display: flex; justify-content: space-between; align-items: center; gap: 12px; cursor: pointer; list-style: none; }
+details.access-type > summary::-webkit-details-marker { display: none; }
+details.access-type[open] > summary .btn { visibility: hidden; }
+details.access-type > form { margin-top: 14px; }
```

Create `web/components/ConfirmDelete.js`:

```js
'use client'
import { useState } from 'react'

// Delete, then a second, in-page step: "Delete it" or "Keep it". `action` is the server
// action the confirming button submits the surrounding form to.
export default function ConfirmDelete ({ action, what, note }) {
  const [asking, setAsking] = useState(false)
  if (!asking) return <button type='button' className='btn ghost danger' onClick={() => setAsking(true)}>Delete</button>
  return (
    <span className='row' role='group' aria-label={`Delete ${what}?`}>
      <span className='muted'>Delete {what}?{note ? ` ${note}` : ''}</span>
      <button className='btn danger' formAction={action}>Delete it</button>
      <button type='button' className='btn ghost' onClick={() => setAsking(false)}>Keep it</button>
    </span>
  )
}
```

Create `web/lib/access-form.js`:

```js
// Pure helpers for the Access types page, no Next imports, so they're unit-tested directly.

/** A type's fields from its form: folders one per line ("All folders" when empty), the switch for posting. */
export function typeFromForm (formData) {
  const folders = String(formData.get('folders') || '').split('\n').map((f) => f.trim()).filter(Boolean)
  return {
    name: String(formData.get('name') || '').trim(),
    files: formData.get('files') === 'view' ? 'view' : 'edit',
    folders,
    talk: formData.get('talk') === 'on'
  }
}

/** Folders as the form's text: one per line. */
export const foldersText = (folders) => (folders || []).join('\n')

/** "Can edit · src, docs · may post": a type at a glance. */
export function describeType (t) {
  const parts = [t.files === 'view' ? 'View only' : 'Can edit']
  if (t.files !== 'view') parts.push(t.folders && t.folders.length ? t.folders.join(', ') : 'all folders')
  parts.push(t.talk === false ? 'no posting' : 'may post')
  return parts.join(' · ')
}
```

Change `web/lib/nav.js`:

```diff
diff --git a/web/lib/nav.js b/web/lib/nav.js
index cf8a0b8..8bcc83f 100644
--- a/web/lib/nav.js
+++ b/web/lib/nav.js
@@ -1,11 +1,12 @@
 // Pure, no Next imports, so it can be unit-tested directly.
 
-// The personal space's tabs. Dashboard is exact: Computers and Agents sit under it but have
+// The personal space's tabs. Dashboard is exact: Computers, Agents and Access types sit under it but have
 // their own tabs.
 export const PERSONAL_NAV = [
   { href: '/dashboard', label: 'Dashboard', exact: true },
   { href: '/dashboard/computers', label: 'Computers' },
-  { href: '/dashboard/agents', label: 'Agents' }
+  { href: '/dashboard/agents', label: 'Agents' },
+  { href: '/dashboard/access', label: 'Access types' }
 ]
 
 /** Whether a nav item is the current page: an exact match, or a page under it unless the item says exact. In-page (#) links never are. */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npm test`
Expected: PASS (75 tests).

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/app/dashboard/access/actions.js web/app/dashboard/access/page.js web/app/globals.css web/components/ConfirmDelete.js web/lib/access-form.js web/lib/nav.js web/test/access-form.test.js web/test/nav.test.js web/test/routes.test.js
git commit -m "Access types on heyquilt.com: list, create, edit and delete them under Dashboard"
```

---

## Deploy

For the controller, once every task above is merged to `main`. Steps marked **(user)** need Daniel. Never print, log or paste a secret.

0. **A clean clone of `main`, never a worktree or the shared main checkout.** Fly uploads the working tree, and Netlify needs a real clone to package the proxy edge function.

   ```bash
   D="$(mktemp -d)/deploy-clone"
   git clone -b main https://github.com/DanielCarmichaelGit/heyquilt.git "$D" && cd "$D" && git log -1 --oneline
   npm ci
   ```

   Check `git log -1` is the merge with these tasks, and that `npm test` passes in the clone.

1. **The migration, on Supabase `pwebomewzuezaxoowykk` (the controller, with the Supabase MCP).**
   - `apply_migration` with `project_id: pwebomewzuezaxoowykk`, `name: access_types_and_invites`, and `query` = the full contents of `supabase/migrations/20261002010000_access_types_and_invites.sql`. It needs `relay_sessions` (session activity), which is already there.
   - `list_tables` (schema `public`): `access_types`, `session_grants` and `session_invites` exist with RLS enabled.
   - `execute_sql`: `select proname from pg_proc where proname in ('delete_access_type','claim_email_invites','delete_account_access');` returns three rows, and `select has_table_privilege('authenticated', 'public.session_grants', 'select');` is `false`.
   - `get_advisors` (type `security`): the only new notices are "RLS enabled, no policy" for the three tables, which is intended (only the API's service role uses them).

2. **The API.** From the clone:

   ```bash
   fly deploy --config fly.api.toml --app quilt-api --remote-only --ha=false
   ```

   Check:
   - `curl -s https://api.heyquilt.com/healthz` is `{"ok":true}`.
   - `curl -s -o /dev/null -w '%{http_code}\n' https://api.heyquilt.com/v1/access-types` prints `401`.
   - `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.heyquilt.com/v1/passes -H 'content-type: application/json' -d '{"room":"x"}'` prints `401`.
   - `QUILT_API=https://api.heyquilt.com node scripts/api-smoke.mjs` passes.

   The deployed relay ignores the new pass fields until step 3, so apps keep working in between.

3. **The relay.** From the clone:

   ```bash
   fly deploy --app cowove-relay --remote-only --ha=false
   ```

   Check `curl -s https://relay.heyquilt.com/healthz` is OK, `fly logs --app cowove-relay --no-tail | grep 'dashboard:'` still shows presence reporting, and open sessions reconnect on their own.

4. **The website.** From the clone's `web/`:

   ```bash
   cd "$D/web" && npm ci && NETLIFY_SITE_ID=b9131760-8605-44f7-b9e1-3b347fc212b0 netlify deploy --build --prod
   ```

   Check the output says `Packaging Edge Functions`, and `curl -sI https://heyquilt.com/dashboard/access` is `307` to `/signin?next=%2Fdashboard%2Faccess`.

5. **The desktop release 0.3.4.** **(user: publishing a release is public; confirm before it goes out.)** From the clean clone on `main`: `npm run release` (it builds, tags `v0.3.4`, pushes and publishes the GitHub release with the `RELEASES.md` section). Check `curl -sIL https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/quilt-mac-arm64.dmg` ends in `200`.

6. **Live check.**
   - **(user)** On heyquilt.com as account A: Dashboard, **Access types**: create "Docs only" (Can edit, folder `docs`, posting off). It lists as `Can edit · docs · no posting`; edit it, then check Delete asks first ("Delete it" / "Keep it") and keep it.
   - **(user)** In Quilt 0.3.4 as A, start a session on a new folder `access-check` with a `docs/` folder and a `README.md`.
   - With the Supabase MCP `execute_sql`: `select room, owner_account from relay_sessions order by created_at desc limit 1;` shows the room with A as owner within seconds.
   - **(user)** Join as account B (another computer, or `export HOME="$(mktemp -d)"; node bin/quilt.js login; node bin/quilt.js join <invite link>`). A sees B waiting with a type picker: choose **Docs only**, **Let in**. B can change `docs/` but an edit to `README.md` is put back, and B's chat box says `You can't post in this session.`
   - **(user)** A opens the people menu: B's Access section shows Docs only. Switch it to **Can edit**, tick **No posting**, and Save: B can now edit `README.md` (within a few seconds, after B's fresh pass) and still can't post.
   - **(user)** A opens **Invite**: B is under "People you've worked with" (after a minute). Invite a third address C by email as **View only**: C gets the email from `hello@hq.heyquilt.com`, signs up with that address, opens the link, and is let in straight away as a viewer, with no prompt for A.
   - With `execute_sql`: `select account, type_id from session_grants where room = '<room>';` lists B and C by account (`person:...`), no `email:` row left; `select email, used_at is not null as used from session_invites where room = '<room>';` shows C's invite used.
   - **(user)** A removes B: B's app stops with "removed you"; B's grant is gone from `session_grants`; B joining again waits for A.
   - A hosted agent (optional): give one of A's agents a grant with posting off from the app's Access section; through `api.heyquilt.com/mcp`, `quilt_join_session` with the link lets it straight in and `quilt_message` answers `You can't post in this session.`

### Older apps (before 0.3.4)

The relay keeps working for them; what changes:
- They ask for passes without a room, so the relay treats them as before: stored members keep their role and folders, newcomers wait for the owner, the owner's approve and set work as before.
- Someone let in as a type (by a grant or an invite, or by an owner approving them as a type) has their access in the API, and only a room pass speaks for it: on an older app, which never sends one, they wait for the owner each time they connect. An invitee on an older app who was let in as a type must update to 0.3.4.
- An older app whose stored access (or whose grant, once they update) says no posting has its chat messages and feed entries undone by the relay, and its log says `the relay undid your change to chat: you can't post in this session`. Its chat files are refused with 403.
- An older owner's app sees people let in by an invite or a grant appear on its member list without having approved them, and can still remove them; its `set` for such a person can't give more than their grant allows.
- Room passes carry new fields (`room`, `iat`, `access`, `email`); `verifyPass` on older relays ignores them, so deploying the API before the relay is safe.

## Self-review notes

Spec coverage, section by section:

- Access types (fields, built-ins, CRUD, at most 50, plain messages, fallback to View only on delete): Tasks 1, 2, 3, 4; `test/api-access-types.test.js`, `test/api-grants.test.js` (delete falls back). Website page: Task 15.
- Session grants (table, tighten never widens, effective access including `foldersExcept`, owner has no grant, only the owner sets them, the three routes): Tasks 1, 2, 5; `test/session-access.test.js`, `test/api-grants.test.js`.
- Access in passes (`{ room }`, `access` / `null` / owner, `room`, `email`, without room as today, clients ask for room passes, refreshes carry access, changes within 5 minutes or at once from the app): Tasks 7, 8, 10, 12; `test/api-room-passes.test.js`, `test/relay-grants.test.js`, `test/session-room-passes.test.js`.
- Relay enforcement (owner unchanged, grant admits without a prompt, no grant waits, approve with `typeId`, view/folders/exceptions, talk undoes chat and feed and refuses chat files, owner `set` narrows only, legacy members, pass wins): Tasks 8, 9, 10; `test/relay-grants.test.js`, `test/relay-talk.test.js`, `test/relay-owner-access.test.js`.
- Hosted agents (grant, role, folders, talk on `/mcp`): Task 11; `test/relay-hosted-mcp.test.js`, `test/api-mcp.test.js`.
- Invites (Invite as, people you've worked with, by email, pending with Cancel, the API route, the table, grants up front, the email and its sender, subject and body, agents get no email, collaborator emails never returned, expiry and cancel, auto let-in, the link never stored): Tasks 6, 7, 13, 14; `test/api-session-invites.test.js`, `test/api-room-passes.test.js`, `test/ui-access.test.js`.
- App changes (approve picker, Access section, invite panel, disabled inputs): Tasks 13 and 14; `test/ui-access.test.js`, `test/ui-access-screens.test.js`, and a check by hand.
- Security (access only from signed passes, `set` only narrows, grants keyed by account, invites bound to confirmed email): Tasks 7 to 10; `iat` (Decision 5) closes the gap where a still-valid older pass could undo a removal.
- Testing section: each listed case maps to a test named above.
