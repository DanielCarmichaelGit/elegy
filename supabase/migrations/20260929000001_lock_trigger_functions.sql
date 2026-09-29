-- Trigger functions aren't meant to be called over the API.
revoke execute on function public.handle_new_user(), public.touch_updated_at(), public.prevent_client_unrevoke() from public, anon, authenticated;
