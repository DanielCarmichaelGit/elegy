# Quilt releases

Every version has a section here, newest first. The app shows the newest section as
"What's new" the first time it runs after an update, and `npm run release` publishes
the matching section as the GitHub release notes. A test fails if the top section's
version does not match package.json, so bump both together.

Format: `## <version> — <YYYY-MM-DD>`, an optional one-line summary, then bullets.
Lead each bullet with a short bold phrase. Inline `code` and **bold** are rendered;
nothing else is.

## 0.3.3 — 2026-10-02

Sessions have names, and heyquilt.com shows where you've been.

- **Sessions are named.** A new session takes its folder's name. Its owner can rename it with **Rename session…** in the session menu, and everyone sees the new name, in the app and on heyquilt.com.
- **Your sessions on heyquilt.com.** The dashboard lists the sessions you've been in, your time in each, and the people and agents you worked with, with your time together.

## 0.3.2 — 2026-10-02

Invite links open the app in one click, and you can invite your AI from the app.

- **Invite links just work.** Clicking a join.heyquilt.com link takes you to heyquilt.com, asks you to sign in (or create an account) if you aren't, remembers the invite while you do, and then opens the session in Quilt. No more copying the link into Join a session. People without the app see where to download it.
- **Invite your AI from the app.** The session's Invite dialog has an **Invite an AI agent** button: it makes a one-time agent invite and gives you one block of text to paste into your AI, with this session's link included. Settings has a new **Agents** card that lists your agents and makes invites too, so you never need the website for it.
- **Cloud AIs can join sessions now.** An agent with no computer of its own (ChatGPT, Grok, claude.ai, or anything that can use an MCP server over HTTP) connects to `api.heyquilt.com/mcp` with its access key, joins a session from an invite link with `quilt_join_session`, waits for you to let it in like anyone else, and then reads and writes the shared files, claims them, messages and shares what it is doing. Its edits land on everyone's disk within moments. Agents that were "registered only" now show as **Hosted**.
- **Update from inside the app.** When a newer Quilt is out, the bar and "What's new" show **Update Quilt**: it downloads the new build, installs it and restarts. A release that lands while Quilt is open pops up its notes within about ten minutes.
- **Partners stay in view through dropped connections.** A laptop that slept or a network that quietly dropped could make a partner vanish from the session for good while files kept syncing. Quilt now notices a silent connection within about a minute, reconnects, and brings everyone's presence back right away. Starting a session on a folder another Quilt process is already syncing now says which process, so you can stop it instead of guessing.
- **Recent is right after you leave.** A session you just left shows up under Recent straight away instead of after the next refresh.

## 0.3.1 — 2026-10-01

Sign in once, and invites open straight into the app.

- **Sign in to use Quilt.** The app signs in to your heyquilt.com account before anything else, and sessions on the hosted relay need that sign-in. Sign out from Settings. Your name in sessions comes from your account.
- **Invites are join.heyquilt.com links.** Open one in a browser and click **Open in Quilt**; it opens the app straight into the join screen. Older relay invite links redirect there.
- **Command line:** `quilt login`, `quilt logout` and `quilt whoami`.
- **Open Quilt from the website.** After linking a computer on heyquilt.com, an Open Quilt button brings the app forward.
- **Agent invites tidy up.** Invites on the website close themselves once the agent has joined.

## 0.3.0 — 2026-10-01

Agents join as members, large files sync encrypted, and the app gets its Sherbet look.

- **AI agents can join.** Paste a one-time invite link from heyquilt.com into your AI, or run `quilt agent join <link>`. Agents show up as their own members with roles and folder limits. `quilt agent whoami` shows who an agent is signed in as.
- **Large files** are stored encrypted outside the session, so big assets sync without slowing everything else down.
- **End a session for everyone** (owners only).
- **Easier-to-read people menu:** a card for you, plain switches for sharing your AI chat, and sections for everyone else.
- **Styled dropdowns** replace the system menus throughout the app.
- **Fewer settings:** relay settings are hidden, since everyone uses the hosted relay at relay.heyquilt.com.
- **In-app dialogs.** Leave, remove, end session and shut down are now in-app and work everywhere.
- **New Sherbet look** for the app icon and logo, and a proper installer window.

## 0.2.1 — 2026-09-30

Sessions that stopped syncing after a partner joined are fixed.

- **Sync works again** in sessions where nothing synced (files, chat, presence) after a partner joined. Build caches like `.next/` were being shared, which made the session too big for the relay.
- **Nested ignore files.** `.gitignore` and `.quiltignore` files in subfolders now apply to their subfolder, like git.
- **Build caches are never shared:** `.next`, `.turbo`, `.nuxt`, `.svelte-kit`, `.parcel-cache` and `.vercel`.
- **`.quiltignore`** (same syntax as `.gitignore`) keeps any other files out of a session.

## 0.2.0 — 2026-09-30

- **Quilt** is the new name. Real-time, tool-agnostic pair vibe coding: a project folder stays live-synced between collaborators and their AI coding agents, whatever editor or AI tool each of them uses.

## 0.1.0 — 2026-09-28

First desktop release.

- **Download, open, and click an invite link** to join a session.
- **Mac:** the app isn't signed by Apple yet. The first time, open System Settings → Privacy & Security and click Open Anyway.
- **Windows:** SmartScreen may warn about an unknown publisher; choose More info → Run anyway.
