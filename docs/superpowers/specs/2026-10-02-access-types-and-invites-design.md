# Access Types, Session Access in Passes, and Invites

Date: 2026-10-02. Builds on:
- `2026-10-01-required-sign-in-design.md` (passes, identity = account `kind:sub`, owner approval);
- `2026-10-01-session-activity-dashboard-design.md` (presence, sessions, collaborators).

Teams-based access is out of scope; it comes when teams are built.

## Goal

People define reusable **access types** and invite anyone, person or agent, to a session **as** one of them. Inside a session the owner can tighten one person's access but never widen it beyond their type. The relay enforces it all. From the app, the owner can also invite **people they've worked with** and **anyone by email**. Invitees get in automatically, with the chosen access, once they sign in with the invited account or email.

## Access types

- **An access type** belongs to an account (`owner_account`) and has:
  - `id`;
  - `name` (1–40 characters);
  - `files`: `'edit' | 'view'`;
  - `folders`: an array of relative folder prefixes, at most 20, the same normalisation as today's agent scopes; empty means all;
  - `talk`: boolean, may post to chat and the feed;
  - `created_at`, `updated_at`.
- **Built-in types** every account has, which can't be edited or deleted, with fixed ids:
  - `builtin:edit`: "Can edit" (edit, all folders, talk);
  - `builtin:view`: "View only" (view, talk).
- **API** (user auth: website JWT or computer token):
  - `GET /v1/access-types` lists built-ins plus your own;
  - `POST /v1/access-types` creates one;
  - `PUT /v1/access-types/:id` updates one;
  - `DELETE /v1/access-types/:id` deletes one. Any session grants that used it fall back to `builtin:view`, the safe default.
  - At most 50 types per account. Validation messages are plain; no em dashes.
- **Website:** Dashboard → **Access types** (`/dashboard/access`) lists them, with create, edit (inline form) and delete (in-page confirmation). Fields:
  - Name;
  - Files: Can edit or View only;
  - Folders: one per line, placeholder "All folders";
  - May chat and post to the feed: a switch.

## Session grants

- A **grant** says what someone may do in a session: `session_grants (room, account 'kind:sub', type_id, tighten jsonb, granted_by, created_at, updated_at)`, unique on `(room, account)`. It's stored by the accounts API: the API is the source of truth for access, and the relay applies it.
- `tighten` narrows the type and never widens it:
  - `{ files?: 'view', foldersRemove?: [prefix], talk?: false }`.
- **Effective access** is computed by the API:
  - `files` is `view` if either the type or the tightening says view;
  - `folders` is the type's folders minus the removed ones. An empty type means all folders; removing from "all" stores `foldersExcept`, which the relay enforces as "everything except these prefixes";
  - `talk` is the type's talk and not tightened.
- **The owner of a session** has full access and never has a grant.
- **Who may set grants:** only the session's owner, recorded in `relay_sessions.owner_account` by the activity design, or by the relay when the owner first connects.
- **API:**
  - `PUT /v1/sessions/:room/grants/:account` with `{ typeId, tighten? }` (the owner's computer token or website JWT; 403 otherwise). The type must belong to the owner or be a built-in.
  - `DELETE /v1/sessions/:room/grants/:account` removes it.
  - `GET /v1/sessions/:room/grants` (owner) lists grants with each type's name and the effective access.

## Access in passes

- `POST /v1/passes` gets an optional body `{ room }`.
  - When `room` is given, the pass payload gains `access: { files, folders, foldersExcept, talk }` for that room: the effective grant, or `null` when there's no grant (not yet let in), or `owner: true` for the owner.
  - It also gains `room` (the pass is then only valid in that room), and `email` (the person's verified account email; absent for agents).
  - Without `room` the pass is as today, valid for identity only and used for HTTP routes that don't touch access.
- **Clients:**
  - the app and CLI request room passes when connecting to a room;
  - `MSG_PASS` refreshes carry the new access;
  - access changes reach a connection within the refresh interval (5 minutes), or at once when the owner changes a grant from the app: the app then asks the relay to reload, see below.

## Relay enforcement

- On connect with a room pass:
  - **owner:** treated as owner, unchanged;
  - **a grant:** approved immediately with that access (`role` = files, `scopes` = folders, plus the new `scopesExcept` and `talk`), so no owner prompt;
  - **no grant:** pending, as today. When the owner approves from the app, they pick an access type in the approve control (default "Can edit"). The app writes the grant through the API, then tells the relay with the existing admin `approve` op, which now carries `{ typeId }`. The relay admits the person with that access, and their next pass refresh confirms it.
- **Enforcement:**
  - **files:** today's UndoManager guard, extended to `scopesExcept` and to view-only;
  - **talk:** the relay tracks `chat` and `agentFeed` in the guard for anyone with `talk: false`, and undoes their additions, sending an access message "you can't post in this session";
  - the relay also refuses HTTP chat-file uploads (`/files` POST) for `talk: false`.
- **Tightening live:**
  - the owner's per-person menu in the app gets an "Access" section: the type picker plus tighten controls (view only, remove folders, no posting);
  - saving writes the grant through the API, and sends the relay an admin `set` op with the new effective access, so it applies at once;
  - the relay accepts `set` only from the owner, and only to narrow what that connection's current pass allows. Widening waits for a pass that allows it, so a modified owner app can't hand out more than the API granted.
- Members approved before this change (stored by the relay with `role`/`scopes`) keep working. When their next pass has a grant, the pass wins.

## Invites

- **The invite panel** in the app (people menu, owner only) gains:
  - **"Invite as"**: an access type picker, defaulting to "Can edit", used by everything below;
  - **"People you've worked with"**: from `GET /v1/me/collaborators` (`[{ account, name, kind, lastTogetherAt }]`, most recent first, at most 30, from the activity data). Each has **Invite**;
  - **"Invite by email"**: an email field and **Send invite**;
  - **the pending invites list**, each with **Cancel**.
- **API:** `POST /v1/sessions/:room/invites` with `{ typeId, to: { email } | { account }, link }` (owner only):
  - it creates `session_invites (id, room, email?, account?, type_id, invited_by, created_at, expires_at = +7 days, used_at, cancelled_at)`;
  - it creates the grant up front, keyed by the account; or, for an email, keyed `email:<lowercased email>` until someone signs in with it;
  - for an email, or a person collaborator (the API looks up their email and never returns it), it sends the email through the existing mailer from `Quilt <hello@hq.heyquilt.com>`:
    - subject "<inviter name> invited you to <session name> on Quilt";
    - body: who invited them, the session name, the `join.heyquilt.com` link, "This invite expires in 7 days", and a line for people new to Quilt (download, then open the link);
  - for an agent collaborator, no email is sent; the grant just pre-approves it;
  - `GET /v1/sessions/:room/invites` lists invites (owner), and `DELETE …/invites/:id` cancels one and removes its unused grant.
- **Auto let-in:** when `POST /v1/passes { room }` is called by a person whose verified email matches an open `email:` invite for that room, the API turns that grant into an account grant, marks the invite used, and returns the access. The relay then admits them immediately, as above.
- **The link holds the room secret.** It passes through the API and the email provider, and the API never stores it. It's used only to build the email.

## App changes

- Approve control: an access type picker (from `GET /v1/access-types`).
- People menu: the per-person "Access" section (owner); the invite panel additions.
- People without talk permission see chat and feed inputs disabled, with "You can't post in this session."

## Security

- Access comes only from API-signed passes, never from the client.
- An owner's live `set` can only narrow what the pass allows.
- Grants are keyed by account, so a display name can't claim one.
- Email invites bind to a verified email (Supabase confirmed email), not a typed name.

## Testing

- **API:**
  - access-type CRUD and its limits;
  - built-ins;
  - grant effective-access maths: tighten, `foldersExcept`;
  - only the owner may set grants;
  - room passes carry access, `room` and `email`;
  - email invite to auto grant on the first pass;
  - collaborator invites never reveal an email;
  - invite expiry and cancel;
  - deleting a type falls back to view.
- **Relay:**
  - a room pass with a grant admits without a prompt;
  - view, folders and `foldersExcept` are enforced;
  - `talk: false` undoes chat and feed additions and refuses chat-file uploads;
  - owner `set` can narrow but not widen;
  - `approve` with `typeId`;
  - a pass's access wins over a stored legacy role.
- **App:**
  - the approve picker;
  - the access section;
  - the invite panel calls;
  - disabled inputs without talk.
- **Website:** the access-types page renders and its CRUD works.
