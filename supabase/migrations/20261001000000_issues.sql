-- Issue tracking: every error, 404, crash and slow action from the desktop app, the
-- accounts API and the website lands in `events`; failures are grouped into `issues`
-- by a fingerprint the API computes. Both tables are the API's only: nothing is read
-- or written by clients. Events are pruned by the API after 30 days; issues stay.

create table public.issues (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique,
  surface text not null check (surface in ('app', 'api', 'web')),
  kind text not null check (kind in ('action', 'error', 'http404', 'crash')),
  name text not null check (char_length(name) between 1 and 80),
  -- The first message seen for this fingerprint, as it was (the fingerprint uses a normalized copy).
  message text not null default '' check (char_length(message) <= 500),
  count integer not null default 0,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  -- Set by hand in the dashboard; a new occurrence clears it.
  resolved_at timestamptz
);
create index issues_last_seen_at on public.issues (last_seen_at desc);
create index issues_open on public.issues (last_seen_at desc) where resolved_at is null;

create table public.events (
  id uuid primary key default gen_random_uuid(),
  surface text not null check (surface in ('app', 'api', 'web')),
  kind text not null check (kind in ('action', 'error', 'http404', 'crash')),
  name text not null check (char_length(name) between 1 and 80),
  outcome text not null check (outcome in ('ok', 'slow', 'error')),
  status integer,
  duration_ms integer,
  message text not null default '' check (char_length(message) <= 500),
  app_version text not null default '' check (char_length(app_version) <= 40),
  platform text not null default '' check (char_length(platform) <= 40),
  user_id uuid references auth.users (id) on delete set null,
  device_id uuid references public.devices (id) on delete set null,
  -- A few flat facts (which editor, which route). The API caps it at 2 KB of scalars.
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  issue_id uuid references public.issues (id) on delete set null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index events_occurred_at on public.events (occurred_at desc);
create index events_issue_id on public.events (issue_id);
create index events_user_id on public.events (user_id);
create index events_device_id on public.events (device_id);
create index events_surface_name on public.events (surface, name, occurred_at desc);

alter table public.issues enable row level security;
alter table public.events enable row level security;
-- No client policies or grants: the API writes with the service role, and people read the
-- tables in the Supabase dashboard.
revoke all on public.issues, public.events from anon, authenticated;
grant all on public.issues, public.events to service_role;

-- One round trip per batch: insert every event, and for each one that is not ok open or
-- count up its issue. `events` is a JSON array of rows in the columns' names, with
-- `fingerprint` on the ones that are not ok.
create or replace function public.record_events (events jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  e jsonb;
  issue uuid;
  n integer := 0;
begin
  if events is null or jsonb_typeof(events) <> 'array' then
    raise exception 'events must be an array';
  end if;
  for e in select * from jsonb_array_elements(events) loop
    issue := null;
    if (e->>'outcome') <> 'ok' then
      insert into public.issues (fingerprint, surface, kind, name, message, count, first_seen_at, last_seen_at)
      values (e->>'fingerprint', e->>'surface', e->>'kind', e->>'name', coalesce(e->>'message', ''), 1,
              (e->>'occurred_at')::timestamptz, (e->>'occurred_at')::timestamptz)
      on conflict (fingerprint) do update set
        count = public.issues.count + 1,
        last_seen_at = greatest(public.issues.last_seen_at, excluded.last_seen_at),
        resolved_at = null
      returning id into issue;
    end if;
    insert into public.events (surface, kind, name, outcome, status, duration_ms, message, app_version, platform,
                               user_id, device_id, context, issue_id, occurred_at)
    values (e->>'surface', e->>'kind', e->>'name', e->>'outcome', (e->>'status')::integer, (e->>'duration_ms')::integer,
            coalesce(e->>'message', ''), coalesce(e->>'app_version', ''), coalesce(e->>'platform', ''),
            (e->>'user_id')::uuid, (e->>'device_id')::uuid, coalesce(e->'context', '{}'::jsonb), issue,
            (e->>'occurred_at')::timestamptz);
    n := n + 1;
  end loop;
  return n;
end
$$;
revoke execute on function public.record_events(jsonb) from public, anon, authenticated;
grant execute on function public.record_events(jsonb) to service_role;
