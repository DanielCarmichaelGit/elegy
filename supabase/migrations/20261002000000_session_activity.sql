-- Session activity: the relay reports who is in which session, and when (by
-- account, from their pass), and the website shows people the sessions they
-- were in and who they worked with. Only session names and times are kept: no
-- paths, files or chat. Everything goes through the accounts API, so row-level
-- security is on with no client policies and no client grants.

create table public.relay_sessions (
  room text primary key check (room ~ '^[A-Za-z0-9_-]{1,64}$'),
  name text not null default '' check (char_length(name) <= 80),
  -- 'person:<uuid>' or 'agent:<uuid>': the first account the relay reported as the room's owner.
  owner_account text,
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  -- Set when the owner renames the session; the relay's name no longer replaces it after that.
  renamed_at timestamptz
);
create index relay_sessions_owner_account on public.relay_sessions (owner_account);
create index relay_sessions_last_active_at on public.relay_sessions (last_active_at);

-- One row per connection let into a session. Two computers on one account are two visits;
-- the API merges them when it adds up time.
create table public.session_visits (
  id uuid primary key default gen_random_uuid(),
  -- The relay's id for the "start" event: a replayed event can't make a second visit.
  event_start_id uuid not null unique,
  room text not null references public.relay_sessions (room) on delete cascade,
  account text not null check (account ~ '^(person|agent):[A-Za-z0-9_-]{1,64}$'),
  account_name text not null default '' check (char_length(account_name) <= 64),
  kind text not null check (kind in ('person', 'agent')),
  started_at timestamptz not null,
  ended_at timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
create index session_visits_room on public.session_visits (room, started_at);
create index session_visits_account on public.session_visits (account, room);
create index session_visits_ended_at on public.session_visits (ended_at);

-- Event ids the API has applied, so a batch the relay sends twice applies once. Pruned after 7 days.
create table public.relay_events_seen (
  id uuid primary key,
  received_at timestamptz not null default now()
);
create index relay_events_seen_received_at on public.relay_events_seen (received_at);

alter table public.relay_sessions enable row level security;
alter table public.session_visits enable row level security;
alter table public.relay_events_seen enable row level security;
revoke all on public.relay_sessions, public.session_visits, public.relay_events_seen from anon, authenticated;
grant all on public.relay_sessions, public.session_visits, public.relay_events_seen to service_role;

-- Applies the relay's events in order, each once. Every step is safe to repeat as well.
create function public.ingest_presence (p_events jsonb, p_received_at timestamptz default now())
returns integer
language plpgsql
set search_path = ''
as $$
declare
  e jsonb;
  t timestamptz;
  applied integer := 0;
begin
  for e in select value from jsonb_array_elements(p_events) loop
    insert into public.relay_events_seen (id, received_at) values ((e->>'id')::uuid, p_received_at)
      on conflict (id) do nothing;
    if not found then
      continue;
    end if;
    applied := applied + 1;
    t := to_timestamp((e->>'at')::double precision / 1000);
    if e->>'type' = 'start' then
      insert into public.relay_sessions as s (room, owner_account, created_at, last_active_at)
        values (e->>'room', case when (e->>'owner')::boolean then e->>'account' end, t, t)
        on conflict (room) do update set
          owner_account = coalesce(s.owner_account, excluded.owner_account),
          last_active_at = greatest(s.last_active_at, excluded.last_active_at);
      insert into public.session_visits (event_start_id, room, account, account_name, kind, started_at)
        values ((e->>'id')::uuid, e->>'room', e->>'account', coalesce(e->>'name', ''), split_part(e->>'account', ':', 1), t)
        on conflict (event_start_id) do nothing;
    elsif e->>'type' = 'end' then
      update public.session_visits set ended_at = greatest(started_at, t)
        where event_start_id = (e->>'start')::uuid and ended_at is null;
      update public.relay_sessions set last_active_at = greatest(last_active_at, t)
        where room = e->>'room';
    elsif e->>'type' = 'name' then
      insert into public.relay_sessions as s (room, name, created_at, last_active_at)
        values (e->>'room', e->>'name', t, t)
        on conflict (room) do update set name = excluded.name
        where s.renamed_at is null;
    end if;
  end loop;
  return applied;
end;
$$;

-- The sessions an account was in: the p_limit most recently active, plus any active since p_since.
create function public.account_sessions (p_account text, p_since timestamptz, p_limit integer)
returns setof public.relay_sessions
language sql
stable
set search_path = ''
as $$
  with mine as (
    select s.* from public.relay_sessions s
    where exists (select 1 from public.session_visits v where v.account = p_account and v.room = s.room)
  ), recent as (
    select m.room from mine m order by m.last_active_at desc, m.room limit p_limit
  )
  select m.* from mine m
  where m.room in (select r.room from recent r) or m.last_active_at >= p_since
  order by m.last_active_at desc, m.room;
$$;

-- Every visit in these sessions (the API works out who overlapped whom).
create function public.visits_in_rooms (p_rooms text[])
returns setof public.session_visits
language sql
stable
set search_path = ''
as $$
  select v.* from public.session_visits v where v.room = any (p_rooms) order by v.started_at, v.id;
$$;

-- Visits that ended before p_before go, then sessions left with no visits, then old event ids.
create function public.prune_activity (p_before timestamptz, p_seen_before timestamptz)
returns void
language sql
set search_path = ''
as $$
  delete from public.session_visits where ended_at < p_before;
  delete from public.relay_sessions s where s.last_active_at < p_before
    and not exists (select 1 from public.session_visits v where v.room = s.room);
  delete from public.relay_events_seen where received_at < p_seen_before;
$$;

-- Deleting an account: its sessions (with everyone's visits in them) and its own visits.
create function public.delete_account_activity (p_accounts text[])
returns void
language sql
set search_path = ''
as $$
  delete from public.relay_sessions where owner_account = any (p_accounts);
  delete from public.session_visits where account = any (p_accounts);
$$;

revoke execute on function public.ingest_presence (jsonb, timestamptz) from public, anon, authenticated;
revoke execute on function public.account_sessions (text, timestamptz, integer) from public, anon, authenticated;
revoke execute on function public.visits_in_rooms (text[]) from public, anon, authenticated;
revoke execute on function public.prune_activity (timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.delete_account_activity (text[]) from public, anon, authenticated;
grant execute on function public.ingest_presence (jsonb, timestamptz) to service_role;
grant execute on function public.account_sessions (text, timestamptz, integer) to service_role;
grant execute on function public.visits_in_rooms (text[]) to service_role;
grant execute on function public.prune_activity (timestamptz, timestamptz) to service_role;
grant execute on function public.delete_account_activity (text[]) to service_role;
