# 023: Chat messages and DMs can be sent under anyone's name

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** app, CLI and relay from main, reproduced live

## What happens
The relay binds presence names to identity keys (README "Security"), but chat
messages are plain Yjs objects with a `by` field set by the sender
(`src/session.js:1089`) and never verified. A peer the relay knows as
"Local user" pushed `by: 'Mallory'`: the UI showed "Mallory" with a Mallory
avatar, the CLI printed `💬 Mallory: …`, and "Mallory (direct, offline)"
appeared in the To dropdown. `to` can be faked the same way, so a DM can be
made to look like it came from, or went to, someone else.

## What should happen
A message's author is the connection that wrote it. Spoofed names are dropped
or clearly marked.

## Next steps
1. Simplest: have the relay validate chat updates before broadcasting (the
   writer's bound name must equal `by`), the same way it drops presence
   updates under someone else's name.
2. Or sign messages with the identity key (like presence) and verify on receipt.

## Log
- 2026-10-01: found by the audit.
