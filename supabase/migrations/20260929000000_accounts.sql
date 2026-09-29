-- Quilt accounts: profiles, linked computers, link requests, agents.
-- Clients (the website) read their own rows through row-level security; the
-- accounts API writes secrets with the service role.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  color text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  tool text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  platform text not null default '',
  public_key text not null,
  token_hash text unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  -- Per account, not global: knowing a computer's public key must not let
  -- another account take over its row.
  unique (user_id, public_key)
);

create table public.device_links (
  id uuid primary key default gen_random_uuid(),
  device_code_hash text not null unique,
  user_code text not null unique,
  public_key text not null,
  device_name text not null,
  platform text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approving', 'approved', 'denied', 'consumed')),
  user_id uuid references auth.users (id) on delete cascade,
  device_id uuid references public.devices (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  public_key text not null unique,
  private_key_enc text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table public.agent_rooms (
  agent_id uuid not null references public.agents (id) on delete cascade,
  server text not null,
  room text not null,
  secret_enc text not null,
  joined_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  primary key (agent_id, server, room)
);

create index agents_owner_id on public.agents (owner_id);

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.device_links enable row level security;
alter table public.agents enable row level security;
alter table public.agent_rooms enable row level security;

-- People see and edit their own profile.
create policy "own profile: read" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "own profile: edit" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- People see their computers and can rename or unlink them; secrets stay hidden (column grants below).
create policy "own devices: read" on public.devices for select to authenticated using ((select auth.uid()) = user_id);
create policy "own devices: rename or unlink" on public.devices for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- People see their agents and can revoke them.
create policy "own agents: read" on public.agents for select to authenticated using ((select auth.uid()) = owner_id);
create policy "own agents: revoke" on public.agents for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

-- device_links and agent_rooms have no client policies: only the API (service role) touches them.

-- Column privileges: clients never read hashes or encrypted keys, and only change safe columns.
revoke all on public.devices, public.agents, public.device_links, public.agent_rooms from anon, authenticated;
grant select (id, user_id, name, platform, public_key, created_at, last_seen_at, revoked_at) on public.devices to authenticated;
grant update (name, revoked_at) on public.devices to authenticated;
grant select (id, owner_id, name, key_prefix, public_key, created_at, last_used_at, revoked_at) on public.agents to authenticated;
grant update (revoked_at) on public.agents to authenticated;
revoke all on public.profiles from anon, authenticated;
grant select (id, name, color, tool, created_at, updated_at) on public.profiles to authenticated;
grant update (name, color, tool) on public.profiles to authenticated;

-- The API is trusted with everything; don't depend on project default privileges.
grant all on public.profiles, public.devices, public.device_links, public.agents, public.agent_rooms to service_role;

-- A profile for every new account, named from the sign-in provider or the email.
create function public.handle_new_user () returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1), 'You'));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Keep updated_at current ourselves; clients don't have write access to it.
create function public.touch_updated_at () returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;
create trigger profiles_touch_updated_at before update on public.profiles for each row execute function public.touch_updated_at();

-- Revocation is one-way for clients: once revoked_at is set, an authenticated
-- client can't clear it. The API's service role relinks with an un-revoke, so
-- it must be exempt.
create function public.prevent_client_unrevoke () returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if old.revoked_at is not null and new.revoked_at is null and auth.role() = 'authenticated' then
    raise exception 'cannot un-revoke';
  end if;
  return new;
end $$;
create trigger devices_prevent_client_unrevoke before update on public.devices for each row execute function public.prevent_client_unrevoke();
create trigger agents_prevent_client_unrevoke before update on public.agents for each row execute function public.prevent_client_unrevoke();
