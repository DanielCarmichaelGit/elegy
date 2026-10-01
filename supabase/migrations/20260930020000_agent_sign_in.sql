-- Agent sign-in: a signed-in person makes a one-time agent invite link, and an
-- AI that uses it joins as an agent with its own keys and a short profile. The
-- API no longer holds agents' private keys or a static key, so those columns
-- go. No agents exist yet (checked before this runs), so nothing carries over.

-- The old client policies read owner_id, so they go before the column does.
drop policy "own agents: read" on public.agents;
drop policy "own agents: revoke" on public.agents;

alter table public.agents
  drop column key_prefix,
  drop column key_hash,
  drop column private_key_enc,
  drop column owner_id,
  add column owner_user_id uuid references public.profiles (id) on delete cascade,
  add column org_id uuid references public.orgs (id) on delete cascade,
  add column invited_by uuid references auth.users (id) on delete set null,
  add column provider text not null,
  add column type text not null,
  add column description text not null default '';

-- An agent may bring its own Ed25519 key when it joins; when it does, the key is
-- one agent's only (unique still holds, and allows many nulls).
alter table public.agents alter column public_key drop not null;

-- A personal agent belongs to one person; an org agent to one org. Never both.
alter table public.agents add constraint agents_one_home check ((owner_user_id is null) <> (org_id is null));
alter table public.agents add constraint agents_name_length check (char_length(name) between 1 and 40);
alter table public.agents add constraint agents_provider_length check (char_length(provider) between 1 and 40);
alter table public.agents add constraint agents_type_length check (char_length(type) between 1 and 40);
alter table public.agents add constraint agents_description_length check (char_length(description) <= 180);
-- Lets org_members take a composite (agent_id, org_id) foreign key.
alter table public.agents add constraint agents_id_org_id_key unique (id, org_id);

create index agents_owner_user_id on public.agents (owner_user_id);
create index agents_org_id on public.agents (org_id);
create index agents_invited_by on public.agents (invited_by);

-- An agent can only be a member of its own org: the plain agent_id foreign key
-- becomes a composite one (like roles and teams), so a personal agent or
-- another org's agent can never be attached to a membership here.
alter table public.org_members drop constraint org_members_agent_id_fkey;
alter table public.org_members add constraint org_members_agent_id_fkey
  foreign key (agent_id, org_id) references public.agents (id, org_id) on delete cascade;

-- People read their personal agents; org agents are read with Agents: Read.
create policy "agents: read own and org agents" on public.agents for select to authenticated using (
  (select auth.uid()) = owner_user_id
  or (org_id is not null and public.has_org_grant(org_id, 'agents', 'r'))
);

-- Reads only. Revoking goes through the API, which also revokes the agent's keys.
revoke all on public.agents from anon, authenticated;
grant select (id, name, provider, type, description, public_key, owner_user_id, org_id, invited_by, created_at, last_used_at, revoked_at) on public.agents to authenticated;

create table public.agent_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  owner_user_id uuid references public.profiles (id) on delete cascade,
  org_id uuid references public.orgs (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  role_id uuid,
  -- [{ teamId, access, scopes }]: checked by the API when the invite is made, and teams are re-checked when it's used.
  teams jsonb not null default '[]'::jsonb check (jsonb_typeof(teams) = 'array'),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_agent_id uuid references public.agents (id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  check ((owner_user_id is null) <> (org_id is null)),
  -- A personal invite has no org role to give.
  check (org_id is not null or role_id is null),
  -- Composite, like org_invites, so a role from another org can never be attached.
  -- A deleted role only clears role_id: the invite is at most an hour old.
  foreign key (role_id, org_id) references public.roles (id, org_id) on delete set null (role_id)
);
create index agent_invites_owner_user_id on public.agent_invites (owner_user_id);
create index agent_invites_org_id on public.agent_invites (org_id);
create index agent_invites_created_by on public.agent_invites (created_by);
create index agent_invites_role_id on public.agent_invites (role_id);
create index agent_invites_used_by_agent_id on public.agent_invites (used_by_agent_id);

create table public.agent_keys (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  -- Every pair minted by refreshing shares its family; reusing a spent refresh key revokes the family.
  family_id uuid not null,
  access_hash text not null unique,
  refresh_hash text not null unique,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  refreshed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index agent_keys_agent_id on public.agent_keys (agent_id);
create index agent_keys_family_id on public.agent_keys (family_id);

alter table public.agent_invites enable row level security;
alter table public.agent_keys enable row level security;

-- No client policies or grants: invite tokens and key hashes are only for the API.
revoke all on public.agent_invites, public.agent_keys from anon, authenticated;

-- The API is trusted with everything; don't depend on project default privileges.
grant all on public.agents, public.agent_invites, public.agent_keys to service_role;
