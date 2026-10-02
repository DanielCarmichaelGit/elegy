# 034: A crafted chat message id makes the auto-downloaded attachment land in the project root, where it syncs to everyone

**Status:** **Fixed** (53c067d) · **Reported:** 2026-10-01 (audit) · **Seen on:** sync client from main, reproduced locally

## What happens
`inboxPath` (`src/session.js:1143-1145`) builds the inbox file name from
`msg.id.slice(0, 6)` without sanitising it (`safeName` is applied to
`file.name` only). Attachments are fetched automatically on arrival
(`:273-279`), and `fetchFile` writes wherever `inboxPath` points. A message
with `id: "../../"` resolves to `<project>/-<name>`: the file is written into
the project root instead of `.quilt/inbox/`, becomes a normal project file,
and is ingested and pushed to every member. `msg.file.id` is also
interpolated into the relay URL unencoded (`:1123`).

A message with a non-string `id` and a `file` is worse for availability:
`msg.id.slice` throws inside the chat observer, the other messages in that
update are dropped, and every later `status()` / `messages()` call (CLI
`quilt status`, STATUS.md, the MCP status and message tools) throws for every
member until the message is trimmed 500 messages later
(`scratchpad/sync/t9-msgid.mjs`).

## What should happen
README "Messaging": sent files "are *not* added to the shared project folder".
A malformed message is skipped, never fatal.

## What we know
Reproduced (`scratchpad/sync/t4-inbox-id.mjs`): `bob root listing: [ '-evil.txt', '.quilt', 'note.txt' ]`.

## Next steps
1. Validate `msg.id` and `msg.file.id` (`/^[0-9a-f]{16}$/`, else fall back to a hash); `encodeURIComponent` in the URL; assert `path.relative(inboxDir, finalPath)` does not start with `..` unless an explicit `dest` was given.
2. A `validMessage(m)` guard used by `canSee`, `messages`, `unreadCount` and the observer; try/catch per message.
3. Same guard on the UI side (see 021).

## Log
- 2026-10-01: found by the audit.
- 2026-10-02: fixed in 53c067d. `validMessage(m)` (hex `id` and `file.id`) sits inside `canSee`, so `messages()`, `unreadCount()`, `status()`, `fetchFile` and the chat observer skip a malformed message; the observer catches per message, so the rest of the update is still delivered. The file id is URL-encoded and the inbox path is asserted to stay under `.quilt/inbox` unless a `dest` was given. The UI-side guard (step 3) stays with 021. Two tests in test/sync.test.js.
