# 020: Supabase: the files bucket was also created in the accounts project, and a few settings are off

**Status:** Open · **Reported:** 2026-10-01 (audit) · **Seen on:** Supabase projects pwebomewzuezaxoowykk (accounts, "Development") and awuikewxoddlryghvknr ("Quilt Files")

## What happens
1. **`session_files_bucket` ran against the accounts project.** Its migration
   history lists version `20261001025244 session_files_bucket`, and
   `storage.buckets` there holds a private `session-files` bucket (created
   02:52:44 UTC), seven minutes before the same bucket was made in the Files
   project (02:59:30 UTC, applied by hand: that project has no migration
   history at all). `supabase/files-project/session_files_bucket.sql` says it
   must never be applied to the accounts project. Nothing writes to the stray
   bucket (0 objects), so the risk is confusion, not data.
2. **Leaked-password protection is off** on the accounts project (security
   advisor WARN) while password sign-in exists (`web/app/signin/PasswordForm.js`).
3. **Expired rows are never deleted** (see 019 item 7): no pg_cron, no API cleanup.
4. **Not verifiable with the tools available here**: the Auth dashboard
   settings (redirect-URL allow-list must include `https://heyquilt.com/auth/callback`
   for sign-up, magic link, OAuth and password reset; magic-link/OTP expiry;
   whether anonymous sign-ins are off; email confirmation on). Check them once by hand.

## What is fine (checked)
Schema matches the five migrations exactly; RLS is on for all 14 tables and
the policies match; `anon` has no grants on any table or function;
`authenticated` only has column-scoped SELECT (plus the intended UPDATE
columns) and never sees `token_hash`, `access_hash`, `refresh_hash`,
`secret_enc`; trigger functions and `create_org`/`transfer_org` are
service-role only; the three `security definer` helpers are callable by
signed-in users on purpose (advisor WARN, acceptable). Files project: bucket
private, 50 MB limit (matches `QUILT_MAX_STORED_FILE_MB=50`), no public
tables, no auth users. No 4xx/5xx or error-level log lines in the last 24 h on
either project. Unindexed composite foreign keys and 17 unused indexes are
expected at this size.

## Next steps
1. Accounts project: `delete from storage.buckets where id = 'session-files'`
   and remove the `session_files_bucket` row from `supabase_migrations.schema_migrations`.
   Files project: record the bucket SQL as a migration so the history is not empty.
2. Auth → Password security: enable leaked-password protection.
3. Add the cleanup job from 019.
4. Review the Auth URL configuration and anonymous sign-ins setting.

## Log
- 2026-10-01: found by the audit.
