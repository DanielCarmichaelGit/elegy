-- Quilt orgs: orgs, custom roles, members, flat teams, email invites and
-- domain join requests. Members read their own org's non-secret rows through
-- row-level security, gated by the caller's own permission grid; every write
-- goes through the accounts API (service role), which checks the same grid.

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
create index orgs_owner_id on public.orgs (owner_id);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  builtin text check (builtin in ('owner', 'admin', 'member')),
  grants jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (org_id, name),
  -- Lets org_members/org_invites take a composite (role_id, org_id) foreign
  -- key, so a role can never be attached to a member/invite in another org.
  unique (id, org_id)
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
  role_id uuid,
  joined_at timestamptz not null default now(),
  check ((user_id is null) <> (agent_id is null)),
  check (user_id is null or role_id is not null),
  unique (org_id, user_id),
  unique (org_id, agent_id),
  -- Lets team_members take a composite (member_id, org_id) foreign key.
  unique (id, org_id),
  -- Composite, not a plain role_id fk: a role_id with a null org_id match is
  -- impossible here (role_id implies org_id), but this is what stops a role
  -- from another org ever being attached to this membership.
  foreign key (role_id, org_id) references public.roles (id, org_id)
);
create index org_members_user_id on public.org_members (user_id);
create index org_members_agent_id on public.org_members (agent_id);
create index org_members_role_id on public.org_members (role_id);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  unique (org_id, name),
  -- Lets team_members take a composite (team_id, org_id) foreign key.
  unique (id, org_id)
);

create table public.team_members (
  team_id uuid not null,
  org_id uuid not null,
  member_id uuid not null,
  access text not null check (access in ('editor', 'viewer')),
  -- Folder limits, for agents (a later plan); the relay's scope rules allow up to 20.
  scopes text[] not null default '{}' check (cardinality(scopes) <= 20),
  added_at timestamptz not null default now(),
  primary key (team_id, member_id),
  -- Composite foreign keys, so a team and the member it holds are always in
  -- the same org; both cascade, matching the single-column fks they replace.
  foreign key (team_id, org_id) references public.teams (id, org_id) on delete cascade,
  foreign key (member_id, org_id) references public.org_members (id, org_id) on delete cascade
);
create index team_members_member_id on public.team_members (member_id);

create table public.org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  email text not null check (email = lower(email)),
  role_id uuid not null,
  token_hash text not null unique,
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  -- No action (the default) on the role, not cascade: the API refuses
  -- deleting a role that members or open invites still use.
  foreign key (role_id, org_id) references public.roles (id, org_id)
);
create index org_invites_org_id on public.org_invites (org_id);
create index org_invites_role_id on public.org_invites (role_id);
create index org_invites_invited_by on public.org_invites (invited_by);

create table public.join_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- The confirmed address they asked with, so approvers can see who's asking.
  email text not null check (email = lower(email)),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index join_requests_one_pending on public.join_requests (org_id, user_id) where status = 'pending';
create index join_requests_user_id on public.join_requests (user_id);
create index join_requests_org_id on public.join_requests (org_id);
create index join_requests_decided_by on public.join_requests (decided_by);

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

-- The teams the signed-in person (as an org member) is on. Security definer
-- for the same reason: it's used by the teams and team_members policies.
create function public.my_team_ids () returns setof uuid
language sql stable security definer set search_path = '' as $$
  select tm.team_id
  from public.team_members tm
  join public.org_members m on m.id = tm.member_id
  where m.user_id = (select auth.uid())
$$;

-- True when the signed-in person can do p_op ('c'/'r'/'u'/'d') on p_resource
-- in p_org: the Owner can do everything, everyone else needs the checkbox on
-- their role's grants (src/api/permissions.js BUILTIN/checks the same grid).
-- Security definer, like my_org_ids, so policies can call it without a
-- policy on roles/org_members recursing into itself.
create function public.has_org_grant (p_org uuid, p_resource text, p_op text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.org_members m
    join public.roles r on r.id = m.role_id and r.org_id = m.org_id
    where m.org_id = p_org
      and m.user_id = (select auth.uid())
      and (r.builtin = 'owner' or (r.grants -> p_resource ->> p_op) = 'true')
  )
$$;

-- Org settings: Read gates the dashboard UI for domain/domain_requests, but
-- the row itself (name, slug included) is readable by any member: the
-- switcher and every org page need the name and slug just to render.
create policy "members read their orgs" on public.orgs for select to authenticated using (id in (select public.my_org_ids()));
create policy "members read their org's roles" on public.roles for select to authenticated using (
  public.has_org_grant(org_id, 'roles', 'r')
  or public.has_org_grant(org_id, 'members', 'u')
  or public.has_org_grant(org_id, 'invites', 'c')
  or id in (select role_id from public.org_members where org_id = roles.org_id and user_id = (select auth.uid()))
);
create policy "members read their org's members" on public.org_members for select to authenticated using (
  public.has_org_grant(org_id, 'members', 'r')
  or user_id = (select auth.uid())
);
create policy "members read their org's teams" on public.teams for select to authenticated using (
  public.has_org_grant(org_id, 'teams', 'r')
  or id in (select public.my_team_ids())
);
create policy "members read their org's team members" on public.team_members for select to authenticated using (
  public.has_org_grant(org_id, 'team_members', 'r')
  or team_id in (select public.my_team_ids())
);
create policy "own join requests: read" on public.join_requests for select to authenticated using ((select auth.uid()) = user_id);
-- org_invites has no client policy: only the API touches it.

-- Column privileges: reads only, and never token hashes.
revoke all on public.orgs, public.roles, public.org_members, public.teams, public.team_members, public.org_invites, public.join_requests from anon, authenticated;
grant select (id, name, slug, owner_id, domain, domain_requests, created_at) on public.orgs to authenticated;
grant select (id, org_id, name, builtin, grants, created_at) on public.roles to authenticated;
grant select (id, org_id, user_id, agent_id, role_id, joined_at) on public.org_members to authenticated;
grant select (id, org_id, name, created_at) on public.teams to authenticated;
grant select (team_id, org_id, member_id, access, scopes, added_at) on public.team_members to authenticated;
grant select (id, org_id, user_id, status, decided_at, created_at) on public.join_requests to authenticated;

-- The API is trusted with everything; don't depend on project default privileges.
grant all on public.orgs, public.roles, public.org_members, public.teams, public.team_members, public.org_invites, public.join_requests to service_role;

-- A new org with its three built-in roles and its owner, in one transaction.
-- The grids come from the API (src/api/permissions.js BUILTIN) so there's one source.
-- p_first: for "a team" sign-ups, where the account may not have an org yet.
-- An advisory lock on the owner serializes two concurrent first-org calls (two
-- tabs, a double click) for the same person, and if they already belong to an
-- org by the time the lock is held (this call or an accepted invite), that org
-- is returned instead of making a second one.
create function public.create_org (p_name text, p_slug text, p_owner uuid, p_owner_grants jsonb, p_admin_grants jsonb, p_member_grants jsonb, p_first boolean default false)
returns public.orgs
language plpgsql security invoker set search_path = '' as $$
declare
  o public.orgs;
  owner_role uuid;
begin
  if p_first then
    perform pg_advisory_xact_lock(hashtextextended(p_owner::text, 0));
    select orgs.* into o from public.orgs
      join public.org_members on org_members.org_id = orgs.id
      where org_members.user_id = p_owner
      limit 1;
    if found then
      return o;
    end if;
  end if;

  insert into public.orgs (name, slug, owner_id) values (p_name, p_slug, p_owner) returning * into o;
  insert into public.roles (org_id, name, builtin, grants) values (o.id, 'Owner', 'owner', p_owner_grants) returning id into owner_role;
  insert into public.roles (org_id, name, builtin, grants) values (o.id, 'Admin', 'admin', p_admin_grants), (o.id, 'Member', 'member', p_member_grants);
  insert into public.org_members (org_id, user_id, role_id) values (o.id, p_owner, owner_role);
  return o;
end $$;

-- Ownership moves in one step, so there is always exactly one owner: the old
-- owner becomes an Admin and the new one takes the Owner role.
create function public.transfer_org (p_org uuid, p_from uuid, p_to uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  old_owner uuid;
begin
  select owner_id into old_owner from public.orgs where id = p_org for update;

  -- p_from is the owner the caller saw when they clicked transfer; if someone else
  -- already took ownership in the meantime, refuse rather than transfer it out from
  -- under them a second time.
  if old_owner is distinct from p_from then
    raise exception 'not the owner' using errcode = 'QO003';
  end if;

  -- Lock the target's membership row so a concurrent removal can't race the transfer.
  perform 1 from public.org_members where org_id = p_org and user_id = p_to for update;
  if not found then
    raise exception 'target is not a member of this org' using errcode = 'QO002';
  end if;

  update public.org_members set role_id = (select id from public.roles where org_id = p_org and builtin = 'admin')
    where org_id = p_org and user_id = old_owner;
  if not found then
    raise exception 'current owner is not a member of this org' using errcode = 'QO001';
  end if;

  update public.org_members set role_id = (select id from public.roles where org_id = p_org and builtin = 'owner')
    where org_id = p_org and user_id = p_to;

  update public.orgs set owner_id = p_to where id = p_org;
end $$;

-- These aren't meant to be called over the API by anyone but the service role.
revoke execute on function public.create_org(text, text, uuid, jsonb, jsonb, jsonb, boolean), public.transfer_org(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_org(text, text, uuid, jsonb, jsonb, jsonb, boolean), public.transfer_org(uuid, uuid, uuid) to service_role;

-- Signed-in helpers used only by RLS policies: never anonymous, and pointless
-- to call outside a policy (they only report the caller's own rights).
revoke execute on function public.my_org_ids() from public, anon;
grant execute on function public.my_org_ids() to authenticated;
revoke execute on function public.my_team_ids() from public, anon;
grant execute on function public.my_team_ids() to authenticated;
revoke execute on function public.has_org_grant(uuid, text, text) from public, anon;
grant execute on function public.has_org_grant(uuid, text, text) to authenticated;
