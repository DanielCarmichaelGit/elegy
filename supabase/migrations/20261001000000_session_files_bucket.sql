-- Encrypted large files from Quilt sessions. Private: only the relay (with its
-- secret key) signs upload and download links, so no policies are needed.
insert into storage.buckets (id, name, public, file_size_limit)
values ('session-files', 'session-files', false, 104857600)
on conflict (id) do nothing;
