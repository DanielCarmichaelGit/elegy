-- Access types and session invites: people define reusable access types, give someone
-- one in a session (a grant, which may narrow it but never widen it), and invite people
-- and agents to a session as one. The accounts API is the only reader and writer, and
-- signs the access into session passes; the relay enforces it. So row-level security is
-- on with no client policies and no client grants, like session activity.

-- An account's own access types. The built-ins ('builtin:edit', 'builtin:view') live in
-- code, not here, so grants keep type ids as text.
create table public.access_types (
  id uuid primary key default gen_random_uuid(),
  owner_account text not null check (owner_account ~ '^person:[A-Za-z0-9_-]{1,64}$'),
  name text not null check (char_length(name) between 1 and 40),
  files text not null check (files in ('edit', 'view')),
  -- Relative folder prefixes; empty means every folder.
  folders text[] not null default '{}' check (cardinality(folders) <= 20),
  -- May post to chat and the feed.
  talk boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index access_types_owner_account on public.access_types (owner_account, created_at);

-- What someone may do in one session: a type, narrowed by `tighten`
-- ({ files?: 'view', foldersRemove?: [...], talk?: false }). Keyed by account
-- ('person:<uuid>' or 'agent:<uuid>'), or by 'email:<address>' for an email invite
-- nobody has signed in with yet. Goes with its session.
create table public.session_grants (
  room text not null references public.relay_sessions (room) on delete cascade,
  account text not null check (account ~ '^((person|agent):[A-Za-z0-9_-]{1,64}|email:[^[:space:]@]+@[^[:space:]@]+)$'),
  type_id text not null,
  tighten jsonb not null default '{}'::jsonb,
  granted_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (room, account)
);
create index session_grants_account on public.session_grants (account);
create index session_grants_type_id on public.session_grants (type_id);

-- Invites to a session, by email or to someone the owner has worked with (an account).
-- The link (it holds the room secret) is never stored: it only goes into the email.
create table public.session_invites (
  id uuid primary key default gen_random_uuid(),
  room text not null references public.relay_sessions (room) on delete cascade,
  email text check (email = lower(email) and char_length(email) <= 254),
  account text check (account ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$'),
  -- The name the owner saw when inviting an account (never its email).
  account_name text not null default '' check (char_length(account_name) <= 64),
  type_id text not null,
  invited_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by text,
  cancelled_at timestamptz,
  check ((email is null) <> (account is null))
);
create index session_invites_room on public.session_invites (room, created_at);
-- One open invite per address or account in a session. Expiry isn't part of it (it moves
-- with time): the API deletes that key's expired, unused invites just before inserting.
create unique index session_invites_open_email on public.session_invites (room, email) where used_at is null and cancelled_at is null;
create unique index session_invites_open_account on public.session_invites (room, account) where used_at is null and cancelled_at is null;
create index session_invites_account on public.session_invites (account);

alter table public.access_types enable row level security;
alter table public.session_grants enable row level security;
alter table public.session_invites enable row level security;
revoke all on public.access_types, public.session_grants, public.session_invites from anon, authenticated;
grant all on public.access_types, public.session_grants, public.session_invites to service_role;

-- Deleting a type: its grants and invites fall back to View only, the safe default.
create function public.delete_access_type (p_id uuid, p_owner text)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  delete from public.access_types where id = p_id and owner_account = p_owner;
  if not found then
    return false;
  end if;
  update public.session_grants set type_id = 'builtin:view', updated_at = now() where type_id = p_id::text;
  update public.session_invites set type_id = 'builtin:view' where type_id = p_id::text;
  return true;
end;
$$;

-- Someone signed in with an email that has an open invite to this room: the invite is
-- used, and its grant moves from the email to their account (replacing one they had).
create function public.claim_email_invites (p_room text, p_email text, p_account text, p_now timestamptz)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  claimed integer;
begin
  update public.session_invites set used_at = p_now, used_by = p_account
    where room = p_room and email = p_email and used_at is null and cancelled_at is null and expires_at > p_now;
  get diagnostics claimed = row_count;
  if claimed > 0 then
    insert into public.session_grants as g (room, account, type_id, tighten, granted_by, created_at, updated_at)
      select e.room, p_account, e.type_id, e.tighten, e.granted_by, p_now, p_now
      from public.session_grants e where e.room = p_room and e.account = 'email:' || p_email
      on conflict (room, account) do update set
        type_id = excluded.type_id, tighten = excluded.tighten, granted_by = excluded.granted_by, updated_at = excluded.updated_at;
    delete from public.session_grants where room = p_room and account = 'email:' || p_email;
  end if;
  return claimed;
end;
$$;

-- Deleting an account: its access types, and its grants and invites in other people's
-- sessions (its own sessions take theirs with them).
create function public.delete_account_access (p_accounts text[])
returns void
language sql
set search_path = ''
as $$
  delete from public.access_types where owner_account = any (p_accounts);
  delete from public.session_grants where account = any (p_accounts);
  delete from public.session_invites where account = any (p_accounts);
$$;

revoke execute on function public.delete_access_type (uuid, text) from public, anon, authenticated;
revoke execute on function public.claim_email_invites (text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.delete_account_access (text[]) from public, anon, authenticated;
grant execute on function public.delete_access_type (uuid, text) to service_role;
grant execute on function public.claim_email_invites (text, text, text, timestamptz) to service_role;
grant execute on function public.delete_account_access (text[]) to service_role;
