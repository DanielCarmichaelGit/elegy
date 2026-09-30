-- Quilt orgs: orgs, custom roles, members, flat teams, email invites and
-- domain join requests. Members read their own org's non-secret rows through
-- row-level security; every write goes through the accounts API (service role),
-- which checks the caller's permission grid.

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 48),
  -- No cascade: the API makes an owner transfer or delete their orgs before deleting their account.
  owner_id uuid not null references auth.users (id),
  domain text check (domain is null or domain = lower(domain)),
  domain_requests boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  builtin text check (builtin in ('owner', 'admin', 'member')),
  grants jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);
create unique index roles_one_builtin on public.roles (org_id, builtin) where builtin is not null;

create table public.org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- profiles(id) mirrors auth.users(id) and lets the API embed names.
  user_id uuid references public.profiles (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete cascade,
  -- No action (checked at the end of the statement), so deleting an org can
  -- cascade to both its members and its roles; the API refuses deleting a role in use.
  role_id uuid references public.roles (id),
  joined_at timestamptz not null default now(),
  check ((user_id is null) <> (agent_id is null)),
  check (user_id is null or role_id is not null),
  unique (org_id, user_id),
  unique (org_id, agent_id)
);
create index org_members_user_id on public.org_members (user_id);
create index org_members_role_id on public.org_members (role_id);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table public.team_members (
  team_id uuid not null references public.teams (id) on delete cascade,
  member_id uuid not null references public.org_members (id) on delete cascade,
  access text not null check (access in ('editor', 'viewer')),
  -- Folder limits, for agents (a later plan); the relay's scope rules allow up to 20.
  scopes text[] not null default '{}' check (cardinality(scopes) <= 20),
  added_at timestamptz not null default now(),
  primary key (team_id, member_id)
);
create index team_members_member_id on public.team_members (member_id);

create table public.org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  email text not null check (email = lower(email)),
  role_id uuid not null references public.roles (id) on delete cascade,
  token_hash text not null unique,
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
create index org_invites_org_id on public.org_invites (org_id);
create index org_invites_role_id on public.org_invites (role_id);

create table public.join_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- The confirmed address they asked with, so approvers can see who's asking.
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index join_requests_one_pending on public.join_requests (org_id, user_id) where status = 'pending';
create index join_requests_user_id on public.join_requests (user_id);

alter table public.orgs enable row level security;
alter table public.roles enable row level security;
alter table public.org_members enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.org_invites enable row level security;
alter table public.join_requests enable row level security;

-- The orgs the signed-in person belongs to. Security definer so the policy on
-- org_members can use it without recursing into itself.
create function public.my_org_ids () returns setof uuid
language sql stable security definer set search_path = '' as $$
  select org_id from public.org_members where user_id = (select auth.uid())
$$;

create policy "members read their orgs" on public.orgs for select to authenticated using (id in (select public.my_org_ids()));
create policy "members read their org's roles" on public.roles for select to authenticated using (org_id in (select public.my_org_ids()));
create policy "members read their org's members" on public.org_members for select to authenticated using (org_id in (select public.my_org_ids()));
create policy "members read their org's teams" on public.teams for select to authenticated using (org_id in (select public.my_org_ids()));
create policy "members read their org's team members" on public.team_members for select to authenticated
  using (team_id in (select id from public.teams where org_id in (select public.my_org_ids())));
create policy "own join requests: read" on public.join_requests for select to authenticated using ((select auth.uid()) = user_id);
-- org_invites has no client policy: only the API touches it.

-- Column privileges: reads only, and never token hashes.
revoke all on public.orgs, public.roles, public.org_members, public.teams, public.team_members, public.org_invites, public.join_requests from anon, authenticated;
grant select (id, name, slug, owner_id, domain, domain_requests, created_at) on public.orgs to authenticated;
grant select (id, org_id, name, builtin, grants, created_at) on public.roles to authenticated;
grant select (id, org_id, user_id, agent_id, role_id, joined_at) on public.org_members to authenticated;
grant select (id, org_id, name, created_at) on public.teams to authenticated;
grant select (team_id, member_id, access, scopes, added_at) on public.team_members to authenticated;
grant select (id, org_id, user_id, status, decided_at, created_at) on public.join_requests to authenticated;

-- The API is trusted with everything; don't depend on project default privileges.
grant all on public.orgs, public.roles, public.org_members, public.teams, public.team_members, public.org_invites, public.join_requests to service_role;

-- A new org with its three built-in roles and its owner, in one transaction.
-- The grids come from the API (src/api/permissions.js BUILTIN) so there's one source.
create function public.create_org (p_name text, p_slug text, p_owner uuid, p_owner_grants jsonb, p_admin_grants jsonb, p_member_grants jsonb)
returns public.orgs
language plpgsql security invoker set search_path = '' as $$
declare
  o public.orgs;
  owner_role uuid;
begin
  insert into public.orgs (name, slug, owner_id) values (p_name, p_slug, p_owner) returning * into o;
  insert into public.roles (org_id, name, builtin, grants) values (o.id, 'Owner', 'owner', p_owner_grants) returning id into owner_role;
  insert into public.roles (org_id, name, builtin, grants) values (o.id, 'Admin', 'admin', p_admin_grants), (o.id, 'Member', 'member', p_member_grants);
  insert into public.org_members (org_id, user_id, role_id) values (o.id, p_owner, owner_role);
  return o;
end $$;

-- Ownership moves in one step, so there is always exactly one owner: the old
-- owner becomes an Admin and the new one takes the Owner role.
create function public.transfer_org (p_org uuid, p_to uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  old_owner uuid;
begin
  select owner_id into old_owner from public.orgs where id = p_org for update;
  if not exists (select 1 from public.org_members where org_id = p_org and user_id = p_to) then
    raise exception 'not a member of this org';
  end if;
  update public.org_members set role_id = (select id from public.roles where org_id = p_org and builtin = 'admin')
    where org_id = p_org and user_id = old_owner;
  update public.org_members set role_id = (select id from public.roles where org_id = p_org and builtin = 'owner')
    where org_id = p_org and user_id = p_to;
  update public.orgs set owner_id = p_to where id = p_org;
end $$;

-- These aren't meant to be called over the API by anyone but the service role.
revoke execute on function public.create_org(text, text, uuid, jsonb, jsonb, jsonb), public.transfer_org(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_org(text, text, uuid, jsonb, jsonb, jsonb), public.transfer_org(uuid, uuid) to service_role;
revoke execute on function public.my_org_ids() from public, anon;
grant execute on function public.my_org_ids() to authenticated;
