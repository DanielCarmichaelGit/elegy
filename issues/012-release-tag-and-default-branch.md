# 012: GitHub's default branch is a stale `claude/*` branch; v0.3.1 is tagged on September 27 code and the relay image never updates

**Status:** **Fixed** (GitHub, 2026-10-02) · **Reported:** 2026-10-01 (audit) · **Seen on:** github.com/DanielCarmichaelGit/heyquilt

## What happens
- The repository's default branch is `claude/loving-keller-z1okjr` at `f69b5bd`
  (2026-09-27, package.json 0.1.0), 228 commits behind `main`.
- The `v0.3.1` tag and the "Quilt 0.3.1" release point at that commit, not at
  `98eb68b` "Release 0.3.1". The release's source archives are 0.1.0 code. The
  three binary assets are fine (their sizes match today's `dist/` builds from main).
- The tag push ran the September workflow, which published the relay image
  under the old name `ghcr.io/danielcarmichaelgit/elegy-relay:0.3.1` and
  `:latest` with 0.1.0 relay code.
- `.github/workflows/relay-image.yml` only tags `:latest` on the default
  branch, so pushes to `main` produce `sha-*` tags only. `quilt-relay:latest`
  still equals `0.3.0`; docs/hosting.md says `:latest` is built from main.
- New pull requests default to the stale branch.

## What should happen
`main` is the default branch, every tag `vX.Y.Z` points at the release commit
on main, and `quilt-relay:latest` tracks main.

## What we know
- `gh api repos/DanielCarmichaelGit/heyquilt -q .default_branch` → `claude/loving-keller-z1okjr`.
- `git rev-parse v0.3.1` → `f69b5bd…`; `git rev-parse v0.3.0` → `21aabe0` (correct).
- `gh run view 36904316841 --log | grep ghcr` → `elegy-relay:0.3.1`, `:latest`, `:sha-f69b5bd`.
- ghcr `quilt-relay` tags: `0.2.1 latest 0.3.0`; `latest` digest == `0.3.0` digest.

## Next steps
1. GitHub → Settings → Branches: default branch `main`.
2. `git tag -f v0.3.1 98eb68b && git push -f origin v0.3.1`; edit the release so its target is main.
3. Re-run "Relay image" on main and for the tag; delete the `elegy-relay` package (or at least its `0.3.1`/`latest` tags).
4. Delete `claude/loving-keller-z1okjr`, `claude/loving-boyd-2dd130`, `claude/deflake-sync-tests` on origin.

## Log
- 2026-10-01: found by the audit.
- 2026-10-02: default branch set to `main`; `v0.3.1` moved to 98eb68b (Release 0.3.1) and force-pushed; Relay image workflow re-run on main so `quilt-relay:latest` tracks main; stale `claude/loving-keller-z1okjr` and `claude/deflake-sync-tests` deleted on origin (`claude/loving-boyd-2dd130` kept: it is checked out locally). The old `elegy-relay` package on ghcr still needs deleting by hand (the token here lacks the packages scope).
