-- Encrypted large files from Quilt sessions. Applied to the separate
-- "Quilt Files" Supabase project (awuikewxoddlryghvknr), never the accounts project,
-- so the relay's secret key can't reach accounts data.
-- Private: only the relay (with its
-- secret key) signs upload and download links, so no policies are needed.
-- 50 MB per file, matching QUILT_MAX_STORED_FILE_MB in fly.toml.
insert into storage.buckets (id, name, public, file_size_limit)
values ('session-files', 'session-files', false, 52428800)
on conflict (id) do nothing;
