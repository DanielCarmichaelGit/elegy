# Quilt website and agent API — design

**Date:** 2026-09-29 · **Status:** approved in conversation, awaiting spec review

## Goal

Give Quilt accounts. People sign in on a website, link the desktop app on each of their computers to that
account, and create agents that can join Quilt sessions on their own through an API. This is the foundation
the paid plans (`plans/pricing.md`) and "agents are members" (`issues/unlocks.md`) build on.

## Decisions (from the conversation)

- Quilt is used through the **desktop app**. The website is for signing in, accounts and downloads, **not**
  for using the app (the browser version of the app stays shelved).
- **Supabase** for sign-in and data: a **new project, "Quilt", in the existing Firetower organization**
  (its cost is shown and confirmed before it is created).
- **Website:** Next.js on **Netlify**, temporary address `quilt.netlify.app` (or `heyquilt.netlify.app` if
  taken) until there is a domain.
- **Agent API:** its own **Fly app**, separate from the relay: `quilt-api` → `quilt-api.fly.dev`
  (or `heyquilt-api` if taken).
- Agents work over **MCP** (option B). A plain REST API for agents is a future feature (in `issues/unlocks.md`).
- Sign-in: **Google, GitHub, or an email link** (no passwords).

## Architecture

```
  Website (Netlify, Next.js)  ──Supabase Auth──►  Supabase (Postgres + Auth, row-level security)
        │  signed-in user's JWT                          ▲ service role
        ▼                                                │
  Agent API (Fly: quilt-api)  ───────────────────────────┘
        │  ▲ device token (desktop app)      ▲ agent key (agents, over MCP)
        │  │                                 │
        ▼  │                                 │
  Relay (Fly: cowove-relay) ◄── agents connect as their own members, with signed identities
```

- The **website** reads and edits the signed-in person's own rows directly in Supabase (row-level security).
  Anything involving secrets (approving a device, creating an agent key) goes through the **API**.
- The **API** holds the Supabase service role key and an encryption key for agents' private keys. It is the
  only thing that writes tokens, key hashes and encrypted keys.
- The **relay** is unchanged. Agents connect to it like any member, each with its own Ed25519 identity.

## Data model (Supabase)

All tables have row-level security on. "Owner" means `auth.uid()` matches the row's user column.

| Table | Columns | Access |
|---|---|---|
| `profiles` | `id` (= auth user id), `name`, `color`, `tool`, `created_at`, `updated_at` | owner: read, update. Created by a trigger on sign-up (name from the sign-in provider or the email's local part). |
| `devices` | `id`, `user_id`, `name`, `platform`, `public_key` (the app's identity key, unique), `token_hash`, `created_at`, `last_seen_at`, `revoked_at` | owner: read; update only `revoked_at` (unlink) and `name`. `token_hash` not readable by clients (column privileges). Inserted by the API. |
| `device_links` | `id`, `device_code_hash`, `user_code` (unique), `public_key`, `device_name`, `platform`, `status` (`pending`/`approved`/`denied`), `user_id`, `device_id`, `expires_at`, `created_at` | API only (no client policies). |
| `agents` | `id`, `owner_id`, `name`, `key_prefix` (first 8 chars, for display), `key_hash` (unique), `public_key`, `private_key_enc`, `created_at`, `last_used_at`, `revoked_at` | owner: read `id, name, key_prefix, public_key, created_at, last_used_at, revoked_at`; update only `revoked_at`. Secrets not readable by clients. Inserted by the API. |
| `agent_rooms` | `agent_id`, `server`, `room`, `secret_enc`, `joined_at`, `last_active_at` | API only. Remembers which sessions an agent is in, so it can rejoin after being idle. |

Orgs, seats and subscriptions come later as new tables; nothing here needs to change for them.

## Linking the desktop app (device flow)

1. **App → API** `POST /v1/device/start` `{ publicKey, deviceName, platform }` →
   `{ deviceCode, userCode, verificationUrl, interval: 3, expiresIn: 600 }`.
   `userCode` is 8 characters from an unambiguous alphabet (no 0/O, 1/I/L), shown as `7F3K-9QXM`.
   `deviceCode` is a 32-byte random secret; only its hash is stored.
2. The app opens `verificationUrl` (`https://<site>/link?code=<userCode>`) and shows the code.
3. **Website** `/link`: requires sign-in (returns here after), calls `GET /v1/device/link/:userCode` (with the
   user's JWT) to show the computer's name, and **Approve** / **Deny** → `POST /v1/device/approve`
   `{ userCode, approve }`.
   On approve the API creates the `devices` row (owner = the user, `public_key` from the request) and a device
   token (`qd_` + 32 random bytes, stored hashed).
4. **App → API** `POST /v1/device/poll` `{ deviceCode }` every `interval` seconds:
   `202 { status: 'pending' }` · `200 { token, profile }` (the token is returned **once**) ·
   `403 { status: 'denied' }` · `410 { status: 'expired' }`.
5. The app stores `{ token, profile, api }` in `~/.quilt/account.json` (mode 600) and shows the person as signed in.
6. The app uses the token for `GET /v1/me` (profile, and the token's validity) and `PUT /v1/me/profile` (profile
   edits made in the app sync to the account). A revoked or unknown token → `401`; the app then shows
   "signed out" and keeps working locally.

Unlinking a computer on the dashboard sets `revoked_at`; that computer's next API call gets `401`.

## Agents

**Creating one (website → API):** `POST /v1/agents { name }` (user JWT) → the API generates:
- an agent key `qa_` + 32 random bytes (returned **once**; only its hash and an 8-char prefix are stored);
- an Ed25519 identity key pair for the agent (private key encrypted with AES-256-GCM using the API's
  `AGENT_KEY_SECRET`; the public key stored in the clear).

`DELETE /v1/agents/:id` (user JWT) revokes it: the key stops working and its open sessions are closed.

**Using one (agent → API):** MCP over Streamable HTTP at `POST/GET/DELETE /mcp` with
`Authorization: Bearer qa_…`. Tools:

| Tool | Does |
|---|---|
| `quilt_join_session` `{ invite }` | Joins a session from an invite link, as the agent (name = agent's name, kind = agent, owner = the person). |
| `quilt_leave_session` `{ session }` | Leaves it. |
| `quilt_sessions` | Lists the sessions it is in, with who is online in each. |
| `quilt_status` `{ session }` | Who's online, what they're focused on, claims, recent activity. |
| `quilt_list_files` / `quilt_read_file` / `quilt_write_file` `{ session, path, … }` | Files in the shared project; writes are live CRDT edits that merge with everyone else's. |
| `quilt_message` / `quilt_read_messages` | Session chat. |
| `quilt_share` `{ session, request?, summary, files? }` | Posts to the feed, so people see what the agent is doing. |
| `quilt_partner_feed` `{ session, who }` | Reads a person's AI feed. |
| `quilt_claim` / `quilt_release` | Claims files, like a person (claims are enforced). |

`session` may be omitted when the agent is in exactly one session.

**How an agent is in a session:** the API keeps one headless session per (agent, room): a `Connection` to the
relay with the agent's own identity and an in-memory `Y.Doc` — no folder on disk. It reuses `src/connection.js`
and the document layout of `src/session.js`; the tool logic comes from `src/relay-mcp.js`, refactored to work on
any document (and `relay-mcp.js` itself is then retired from the relay). If the session's owner controls access,
the agent waits to be approved like a person, and its tools say so meanwhile. Idle sessions close after
10 minutes and reopen on the agent's next call (from `agent_rooms`).

**Limits:** 20 sessions per agent, 60 tool calls per minute per agent, the relay's file size limits.

## Website pages

Same look as the app: Poppins, cream background, the fabric palette, the pieced-Q mark (sewing in on the
landing page). No gradients or generic "AI startup" styling.

| Page | Contents |
|---|---|
| `/` Landing | Header (logo · Pricing · Sign in / Dashboard). Hero: the mark sewing in, a one-line pitch, **Download for Mac / Windows** (detects the system; links to the latest GitHub release). Three steps (start a session, send the link, build together); "works with every AI" strip (Claude Code, Cursor, Codex, …) as text; a short section on agents joining sessions; footer. |
| `/signin` | Continue with Google · GitHub · email link. Also the sign-up. Returns to where the person came from. |
| `/auth/callback` | Supabase sign-in callback. |
| `/pricing` | "Pricing is coming soon" with the three plans named (Free — local, Paid — cloud sessions, Team — per seat), no prices. |
| `/link?code=` | Approve or deny a computer (see the device flow). |
| `/dashboard` | **Your computers** (name, platform, last seen, Unlink) · **Your agents** (create by name → key shown once with copy-paste setup for Claude Code and Cursor; list with last used; Revoke) · Download the app. |
| `/settings` | **Profile** (name, colour, default AI tool — the same profile the app uses) · **Account** (email, connected sign-ins, sign out everywhere = revoke all devices and sessions, delete account). |

Implementation: Next.js App Router with `@supabase/ssr` (cookie sessions, middleware to protect `/dashboard`,
`/settings`, `/link`). Server actions call the API with the user's access token for approve / create agent.

## Desktop app changes

- **Sign in** in Settings (and a quiet "Sign in" in the sidebar's profile card when signed out). Runs the device
  flow: shows the code, opens the browser, waits, then shows the account.
- Signed in: the profile card shows the account; profile edits sync through `PUT /v1/me/profile`.
- **Sign out** removes `~/.quilt/account.json` (and asks the API to revoke that device).
- Everything keeps working without an account (local use stays free, per the pricing plan).

## Security

- Tokens (`qd_…`, `qa_…`) are 32 random bytes, stored as SHA-256 hashes, compared in constant time.
- Agents' private keys: AES-256-GCM with `AGENT_KEY_SECRET` (Fly secret); never sent to clients.
- Supabase service role key only in the API (Fly secret); the website uses the anon key and the user's session.
- JWTs verified against Supabase's JWKS. CORS on the API's JWT endpoints allows only the website's origin.
- Rate limits: `device/start` per IP (10/min), `device/poll` per device code (the `interval`), MCP per agent.
- Link codes expire after 10 minutes and can only be approved by a signed-in person.

## Deployment

- **Supabase:** project "Quilt" (Firetower org, `us-east-1`); schema as SQL migrations in `supabase/migrations/`,
  applied with the Supabase tools; Google and GitHub sign-in configured in the Supabase dashboard (needs OAuth
  apps: the person creates those, since that means signing in to Google/GitHub).
- **API:** `fly.api.toml`, same Docker image as the relay with `CMD ["node", "bin/quilt.js", "api"]`. Secrets:
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AGENT_KEY_SECRET`, `QUILT_SITE_URL`. Deployed by Claude like the relay.
- **Website:** `web/` (Next.js), Netlify site with env `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `QUILT_API_URL`.

## Testing

- **API:** the data layer behind a small interface with an in-memory implementation, so the device flow, agent
  creation/revocation, token checks and the MCP tools run in `npm test` without Supabase. Agent sessions are
  tested against a local relay (`startServer`) like the existing sync tests, including approval-controlled rooms.
- **Website:** `next build` plus a few Playwright checks of sign-in-protected routes and the link page against a
  mocked API; a manual end-to-end pass on the deployed site (sign in, link the app, create an agent, have it join
  a session).
- **App:** the device flow client tested against the API's in-memory mode.

## Out of scope (later)

Billing and plan checks on the relay; orgs and seats; the REST API for agents; the browser version of the app;
a custom domain (and renaming `cowove-relay`); signing the Mac app.

## Open items

- Final domain (all addresses are temporary until then).
- Google and GitHub OAuth apps must be created by the person (they involve signing in to those services).
