# 031: A partner can edit the shared `.gitignore` to un-ignore `.env`, and your secrets are pushed into the session

**Status:** **Fixed** (4637800) · **Reported:** 2026-10-01 (audit) · **Seen on:** sync client from main (98eb68b), reproduced with two clients on a local relay

## What happens
`.gitignore` and `.quiltignore` are ordinary synced files. Bob writes
`!.env\n!.env.*\n` into `.gitignore`. Alice's `writeOut` applies the remote
change and reloads her ignore matcher (`src/session.js:645`). `makeIgnore`
(`src/pathrules.js:44-48`) adds project patterns after `ALWAYS_IGNORED`, and
the `ignore` library lets a later `!` negate an earlier rule, so `.env` stops
being ignored. Alice's next one-second `scanDisk` sees `.env` as new,
`ingest` shares it, and Bob receives Alice's `.env`. The same trick removes
anything a person keeps private with `.quiltignore`, and un-ignores
`node_modules`, `.claude/worktrees`, build caches and so on.

## What should happen
README "What syncs": `.env` / `.env.*` "secrets stay local". README
"Security": nothing can be written "into files you ignore locally". Built-in
exclusions must be impossible to negate, and a person's `.quiltignore` must
not be editable from the room.

## What we know
Reproduced (`scratchpad/sync/t1-env-unignore.mjs`, re-run by the coordinator):
```
bob has .env before: null
alice shared paths: [ 'README.md', '.gitignore', '.env' ]
bob has .env after: "SECRET=alice-only\n"
```

## Next steps
1. Two matchers: a built-in `ignore().add(ALWAYS_IGNORED)` consulted first and never extended by project files, then the project matcher; a path is ignored if either says so.
2. Make `.quiltignore` local-only (never synced), or refuse remote writes to `IGNORE_FILES`.
3. Test: a remote `!.env` must not change `syncable('.env')`.

## Log
- 2026-10-01: found by the audit.
- 2026-10-01: fixed in 4637800: built-ins live in their own matcher that project ignore files cannot override, and .quiltignore is never synced (tests in test/ignore.test.js). The end-to-end script now shows `alice shared paths: [ 'README.md', '.gitignore' ]`, `.env` stays local.
