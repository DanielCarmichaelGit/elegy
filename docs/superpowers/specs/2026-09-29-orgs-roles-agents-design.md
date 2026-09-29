# Quilt orgs, roles, teams and agent sign-in — design

Date: 2026-09-29. Builds on `2026-09-29-website-and-agent-api-design.md` (accounts API, website, device linking)
and the in-session access controls already on the relay (owner, editor/viewer, agent folders).

## Goal

Quilt works like a standard SaaS product for both people and teams:

- Anyone signs up with email + password as **just me** (a personal account) or as **a team** (creates an org).
- Orgs have **custom roles**: a grid of permissions with Create / Read / Update / Delete per thing.
- Orgs contain **teams**. You reach a team's sessions only if you're in that team, as editor or viewer.
- **AI agents sign themselves up**: an agent registers, a person approves it (choosing where it goes and what
  it can do), and the agent gets a short-lived access key plus a rotating refresh key.
- The relay admits team members automatically using a **signed session pass** from the API.

## Decisions (from the conversation)

| Topic | Decision |
|---|---|
| Sign-in | Email + password first; email link kept as a fallback; Google/GitHub when configured. Done and deployed. |
| Account types | One login per person. At sign-up: "Just me" or "A team" (asks for the org name; you become its owner). A person can be in several orgs and keep a personal space. |
| Org structure | Org → flat teams (no nesting). Teams are made of org members. Being in team A gives nothing in team B. |
| Org roles | Custom roles, unlimited. Each role = a grid of rows × C/R/U/D checkboxes. Built-in Owner (fixed), Admin and Member (editable). |
| Team access | Per team membership: **editor** or **viewer**; agents may also be limited to folders. Separate from org roles. |
| Joining an org | Email invites; and domain requests — admins may let people with a confirmed email on the org's custom domain ask to join; an admin approves. Public mail domains are never allowed. |
| Agents | Agents are org members (or belong to a person's personal space). Agents register themselves and show an approval link; the approver picks the destination and permissions. |
| Agent keys | Access key: 1 hour. Refresh key: 30 days, rotated on every use; reuse of an old refresh key revokes the agent's keys. |
| Session admission | Signed session pass from the API (option A). Pass lifetime 10 minutes, re-requested while connected. |

## Accounts and sign-up

- `/signup` asks "Just me" or "A team". A team sign-up also asks for the **org name** and creates the org with
  the new person as **Owner**.
- The dashboard gets a **space switcher**: "Personal" plus each org the person belongs to. The chosen space is
  remembered in a cookie; URLs carry it too (`/org/<slug>/…`).
- Email confirmation must be **on** before orgs launch (domain joining trusts confirmed emails; invites need
  delivery). Prerequisite: a custom SMTP provider (Resend or Postmark) connected in Supabase Auth.

## Orgs, roles and permissions

### Permission grid

Rows (resources) and the meaning of each checkbox:

| Row | Create | Read | Update | Delete |
|---|---|---|---|---|
| Org settings | — | see name, domain rule | change name, domain rule | — (deleting the org is Owner-only) |
| Members | — (people join via invites/requests) | see the member list | change a member's org role | remove a member |
| Agents | approve agents into the org | see org agents | change an agent's role/teams/folders | revoke an agent |
| Teams | create teams | see all teams (members always see their own) | rename a team | delete a team |
| Team membership | add people/agents to teams | see who's in each team | change editor/viewer and folders | remove from a team |
| User invites | send email invites; approve domain requests | see pending invites/requests | resend | cancel invites; deny requests |
| Roles | create roles | see roles | edit a role's grid; assign roles (with Members: Update) | delete a role (not while assigned) |
| Billing | reserved for per-seat plans (later) | | | |

Unchecked "—" cells are not shown as checkboxes.

### Built-in roles

- **Owner** — every permission, plus transfer ownership and delete the org. Exactly one per org; not editable,
  not assignable except through "transfer ownership".
- **Admin** — every checkbox. Editable (by someone who holds those checkboxes).
- **Member** — Teams: Read (own teams only). Editable.
- New people default to **Member**; new agents default to **no role** (team access only).

### Rules the API enforces on every change

1. You need the checkbox for what you're doing.
2. **No self-promotion:** you can only create/edit a role whose checkboxes are a subset of your own, and only
   assign roles that are a subset of your own. You can't change your own role. Nobody can edit or assign Owner.
3. An org always has exactly one owner; ownership transfer is an explicit Owner-only action.
4. Deleting a role that is assigned is refused.

Row-level security lets members read their own org's non-secret rows (the website reads through it, naming
columns). All writes go through the accounts API, which checks the rules above with the service role.

## Teams

- Flat list per org. A team has members (people and agents from the org), each with **access** (`editor` or
  `viewer`) and, for agents, optional **folders** (up to 20 path prefixes — the relay's existing scope rules).
- A session started "in" a team is bound to that team for life.

## Joining an org

- **Email invite:** someone with User invites: Create enters an address and a role. Quilt emails a link
  (`/invite/<token>`, token stored hashed, expires in 7 days). The invitee signs up or signs in **with that
  confirmed email** and joins with the chosen role.
- **Domain requests:** someone with Org settings: Update may set the org's domain, but only to the domain of
  their own confirmed email, and never a public mail domain (a blocklist: gmail.com, googlemail.com, yahoo.*,
  outlook.com, hotmail.com, live.com, msn.com, icloud.com, me.com, aol.com, proton.me, protonmail.com, gmx.*,
  mail.com, yandex.*, zoho.com, fastmail.com, hey.com, qq.com, 163.com and similar). When on, signed-in people
  with a confirmed email on that domain see "Ask to join <org>"; someone with User invites: Create approves
  (choosing a role) or denies.

## Agent sign-in

### Registration and approval

1. The agent generates an Ed25519 identity (same format as the desktop app's) and calls
   `POST /v1/agents/register { name, publicKey }` (no account needed; rate-limited per IP like device start).
   Response: `{ requestId, userCode, approveUrl, interval, expiresIn }`. `approveUrl` =
   `<site>/agents/approve?code=<userCode>`. Requests expire after **15 minutes**.
2. The agent shows the person the link. The person opens it signed in and sees the agent's name and code, then
   chooses:
   - **Where:** "Me (personal)" or an org where they hold Agents: Create.
   - **For an org:** teams (each editor/viewer, optional folders; limited to what they hold Team membership:
     Create on) and optionally an org role (subset rule applies).
   - **For personal:** nothing more — the agent joins that person's sessions like a person does today (invite
     link + the session owner's approval), and is marked as theirs.
   Then Approve or Deny.
3. The agent polls `POST /v1/agents/register/poll { requestId, signature }`, signing the request id with its
   identity key under its own context string (`quilt-agent-register-v1`). On approval it receives its first
   key pair once: `{ agentId, accessKey, accessExpiresAt, refreshKey, refreshExpiresAt }`.

### Keys

- Access key `qa_…` — valid **1 hour**. Sent as `Authorization: Bearer` to the API (MCP and REST).
- Refresh key `qr_…` — valid **30 days**, single use. `POST /v1/agents/token { refreshKey }` returns a fresh
  pair and retires the old refresh key.
- **Reuse detection:** keys belong to a family. Presenting an already-used refresh key revokes the whole family
  (both keys); the agent must be re-approved, and the dashboard shows why.
- Only SHA-256 hashes are stored. Revoking an agent revokes every family immediately.

### Replaces

The dashboard's "Create agent / copy key" flow and the `agents.key_hash` column from plan 1 are removed (no
real agents exist yet). Agents keep their Ed25519 identity (`public_key`); the API no longer holds agents'
private keys, since agents now hold their own.

## Session passes and the relay

- Starting a team session: the signed-in desktop app calls `POST /v1/sessions { teamId }`. The API checks the
  caller is an **editor** in that team, records `team_sessions (server, room, team_id, created_by)` and returns
  the room id plus a pass.
- Joining: the desktop app (device token) or agent (access key) calls `POST /v1/sessions/pass { server, room }`.
  The API looks up the room's team and the caller's membership and returns a pass, or 403.
- **Pass** = `base64url(JSON payload) + "." + base64url(Ed25519 signature)` signed with the API's pass key
  (Fly secret `PASS_SIGNING_KEY`). Payload: `{ v: 1, key: <caller's identity public key>, server, room, team,
  access: 'editor'|'viewer', scopes: [...], name, kind: 'person'|'agent', exp }` with `exp` = now + 10 minutes.
- **Relay:** configured with the API's public key (`QUILT_PASS_PUBLIC_KEY`). A room created through
  `/v1/sessions` is marked with its team on first join (the creator's pass). On join, a valid pass whose
  `key` matches the identity the client proved, whose `room`/`server` match, and whose `team` matches the
  room's team admits the client immediately with `access` and `scopes` — the existing relay enforcement does
  the rest. Clients send a fresh pass before `exp`; the relay disconnects a member whose pass lapses, and
  applies role/folder changes from the new pass live.
- Non-team people still use the existing owner-approval flow. Personal sessions are unchanged.

## Desktop app

- Sign in via the device flow (plan 1's API). Before shipping it, give device linking its own signature
  context (`quilt-device-link-v1`, `signDeviceLink`/`verifyDeviceLink`) instead of the relay's, and make the
  relay client refuse room `device-link` (both carried from plan 1).
- "Start a session" offers **Personal** or any team the person is an editor in.
- The app fetches and refreshes passes for team sessions.

## Website

- `/signup`: Just me / A team.
- Space switcher on the dashboard.
- **Org area** (`/org/<slug>/…`, shown per the viewer's Read permissions): People & agents (one list, agent
  badge, role, teams, remove/revoke), Teams (create/rename/delete, members with editor/viewer and folders),
  Roles (list + the C/R/U/D grid editor), Invites & requests, Settings (name, domain rule, transfer ownership,
  delete org — Owner only).
- `/agents/approve?code=…`: agent approval with destination and permissions.
- Personal **Agents** page: agents you approved into your personal space; revoke.
- `/invite/<token>`: accept an org invite.

## Data model (new and changed tables)

| Table | Columns (key ones) |
|---|---|
| `orgs` | `id`, `name`, `slug` (unique), `owner_id`, `domain` (nullable), `domain_requests` (bool), `created_at` |
| `roles` | `id`, `org_id`, `name`, `builtin` (`owner`/`admin`/`member`/null), `grants` (jsonb `{ resource: { c, r, u, d } }`), `created_at` |
| `org_members` | `id`, `org_id`, `user_id` or `agent_id` (exactly one), `role_id` (nullable for agents), `joined_at`; unique per org+principal |
| `teams` | `id`, `org_id`, `name`, `created_at` |
| `team_members` | `team_id`, `member_id` (→ org_members), `access` (`editor`/`viewer`), `scopes` (text[], ≤ 20), `added_at` |
| `org_invites` | `id`, `org_id`, `email`, `role_id`, `token_hash`, `invited_by`, `expires_at`, `accepted_at`, `cancelled_at` |
| `join_requests` | `id`, `org_id`, `user_id`, `status` (`pending`/`approved`/`denied`), `decided_by`, `created_at` |
| `agents` (changed) | `id`, `name`, `public_key` (unique), `owner_user_id` (personal) or `org_id`, `approved_by`, `created_at`, `last_used_at`, `revoked_at`; drop `key_prefix`, `key_hash`, `private_key_enc`, `owner_id`. `agent_rooms` stays (personal sessions joined by invite link still need the room secret to rejoin) |
| `agent_registrations` | `id`, `request_hash`, `user_code`, `public_key`, `name`, `status` (`pending`/`approving`/`approved`/`denied`/`consumed`), `agent_id`, `expires_at`, `created_at` |
| `agent_keys` | `id`, `agent_id`, `family_id`, `access_hash`, `refresh_hash`, `access_expires_at`, `refresh_expires_at`, `refreshed_at` (set when its refresh key is used), `revoked_at` |
| `team_sessions` | `server`, `room`, `team_id`, `created_by`, `created_at`; primary key `(server, room)` |

RLS: members read their org's `orgs`, `roles`, `org_members`, `teams`, `team_members` rows (non-secret
columns); people read their own `join_requests` and agents they approved; no client reads `org_invites.token_hash`,
`agent_registrations.request_hash` or any `agent_keys` column. All writes go through the API.

## Security

- Every write is checked by the API against the caller's grid; the no-self-promotion subset rule is enforced
  server-side and unit-tested.
- Invite tokens, registration request ids, access and refresh keys are stored only as SHA-256 hashes.
- Agent registration polling proves possession of the agent's key (own signature context), so a leaked
  approval code can't hand keys to someone else.
- Session passes are short-lived, bound to one identity key, one room and one team, and signed with a key only
  the API holds.
- Domain rules only trust confirmed emails and never public mail domains.
- Rate limits on register, token refresh and invite acceptance, keyed on `fly-client-ip` like device linking.

## Build order (one plan each)

1. **Orgs, roles and teams** — Supabase migration, API routes, permission checker, website sign-up choice,
   space switcher, Org area, invites and domain requests. Needs SMTP + email confirmation first.
2. **Agent sign-in** — registration, approval page, key pairs and rotation, personal Agents page; removes the
   old create-agent flow.
3. **Desktop sign-in and team sessions** — device-link signature fix, desktop sign-in, Personal/Team session
   start, `/v1/sessions` and passes, relay pass verification.
4. **Agents in sessions** — the MCP endpoint and tools (the earlier "plan 2"), using access keys and passes.

## Testing

- Unit: permission checks per row/op, subset rule, owner invariants, public-domain blocklist, key rotation and
  reuse detection, pass signing/verification and expiry.
- API route tests against the in-memory store (as today).
- Relay tests: a team-A pass can't enter a team-B room; an expired pass disconnects; a viewer pass can't edit.
- Website route smoke tests; end-to-end checks with the user after each deploy.

## Out of scope (later)

Per-seat billing (the Billing row is reserved), SSO/SAML, nested teams, audit log, email notifications beyond
invites, custom-role templates across orgs.
