# 029: Repo, CI and deploy hygiene

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** main (98eb68b), Fly, Netlify

1. **CI never runs the website's tests or build** (`.github/workflows/ci.yml`
   runs only the root `npm test`; `web/test/` has 17 files). The site is
   deployed from the CLI, so nothing gates a website release. Add a `web` job.
2. **`.dockerignore` sends ~970 MB into every Fly build context**:
   `node_modules` (no `**/`) only matches the root, and `web/` is not listed,
   so `web/node_modules` (341 MB), `web/.next` (546 MB) and `web/.netlify`
   (79 MB) upload on each `fly deploy` of both apps. Use an allow-list
   (`*` then `!bin`, `!src`, `!assets`, `!deploy`, `!package*.json`).
3. **Stale Fly secrets**: `quilt-api` still has `AGENT_KEY_SECRET`, which no
   code reads (`grep -rn AGENT_KEY_SECRET src bin` → nothing). Unset it.
4. **Untracked `deno.lock` and `web/deno.lock`** are Netlify edge-runtime
   by-products (no `deno.json` exists). The root one shows `netlify` was run
   from the repo root, which netlify.toml warns ships the site without
   `proxy.js`. Ignore both, delete the root one.
5. **Stray files**: `cowove-data/` (empty, not ignored; only `quilt-data/`
   is); `.quilt/state.bin` at the root is 100 MB (from syncing this repo
   itself, the issue-007 scenario); `.claude/launch.json` "serve" entry says
   port 3000 while `quilt serve` listens on 4321; `dist/latest-mac.yml` is
   produced but there is no auto-updater.
6. **issues/ and plans/ statuses are stale**: 002 is "Blocked on a public
   relay" but the relay is live; 007 says "uncommitted" but landed as
   `1ab736c`; 005 cites `src/web/`, which no longer exists; 007/008 name
   `cowove-relay.fly.dev`; plans/README and unlocks.md list "agents as
   members" as Proposed/Idea although `quilt agent join` and
   `quilt_join_session` shipped.
7. **Dependencies slightly behind, no vulnerabilities**: `npm audit --omit=dev`
   is clean in both folders; `@modelcontextprotocol/sdk`, `electron`,
   `ignore`, `lib0`, `nodemailer`, `next`, `@netlify/plugin-nextjs` each have
   a patch release available.

## Log
- 2026-10-01: found by the audit.
