-- Personal vs. org accounts: set once at sign-up, never editable afterwards.
-- Orgs are only created through the org sign-up flow (POST /v1/orgs checks this).
alter table public.profiles add column kind text not null default 'personal' check (kind in ('personal', 'org'));

create or replace function public.handle_new_user () returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name, kind)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1), 'You'),
    case when new.raw_user_meta_data ->> 'account' = 'org' then 'org' else 'personal' end
  );
  return new;
end $$;

-- create or replace keeps the function's existing ACL (the lock_trigger_functions
-- migration's revoke already applies); this re-states it as defence in depth.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Clients still can't write kind (the update grant stays name, color, tool only);
-- they can now read it, so the website can tell personal and org accounts apart.
grant select (kind) on public.profiles to authenticated;
