# 028: README, docs/hosting.md and `--help` disagree with the code

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** main (98eb68b)

1. **Shared-file limit**: README:241 and docs/hosting.md:104,112 say 100 MB;
   production sets `QUILT_MAX_STORED_FILE_MB = "50"` (fly.toml:18, the
   Supabase free-plan cap), so people get "files over 50 MB can't be shared".
2. **`QUILT_MAX_ROOM_MB` default**: hosting.md:103 says 256, `src/server.js:62` says 32.
3. **Node version**: README:69 "Requires Node.js 20+"; package.json `engines`,
   Dockerfile, CI and README:218 all say 22 (22.13+ for the Cursor reader).
4. **`PORT`**: hosting.md says Fly sets it; it does not, fly.toml does.
5. **Self-hosting sections** (Fly with your own name, Render, VPS, plain
   Docker) read as a user path, but the app refuses any relay other than
   relay.heyquilt.com (`unsupportedRelay`), as README:256 admits; render.yaml
   and docker-compose.yml do not know `QUILT_PASS_PUBLIC_KEY`. Mark them
   "development only" or describe the real deploy.
6. **README "Commands" table vs `bin/quilt.js`**: `quilt join` listed twice;
   missing `quilt stop`, `quilt api [--port] [--memory]`, `quilt agent join
   <link> --name` / `agent whoami`, `quilt inbox`, `quilt login --no-browser`,
   `quilt doctor [folder]`, `messages -n`, join `--dir`/`--room`/`--secret`
   (`--prefer local` only in prose), `serve --host/--key`, `ui --port/--no-open/--preview`;
   `release` shows a required argument in `--help` but defaults to `*`.
7. **README MCP table** omits five registered tools: `quilt_commit`,
   `quilt_commit_status`, `quilt_request_commit`, `quilt_set_work`, `quilt_wait_until_idle`.
8. **`quilt <sub> --help` crashes** for serve, join, api, ui, login, messages
   (`ERR_PARSE_ARGS_UNKNOWN_OPTION` with a stack trace); `doctor --help`
   silently runs the doctor; only `agent --help` works. The top-level `--help`
   table is misaligned (serve one column short, api one column long).
9. **Relay secret name**: production uses `COWOVE_RELAY_KEY` (works only via
   `adoptLegacyEnv`), docs say `QUILT_RELAY_KEY`. Moot once 010 is done.
10. **`package.json` still exposes a `cowove` bin alias**, has no
    `"private": true`, and `main` points at a file `files` excludes, so an
    accidental `npm publish` ships a broken package under the product name.

## Next steps
Generate the commands table from the HELP text in `bin/quilt.js` (one source
of truth), handle `-h/--help` before `parseArgs` in each subcommand, and fix
the numbers.

## Log
- 2026-10-01: found by the audit.
