-- BuildFlow Storage RLS Policies (additive)
-- Enables authenticated org members to read, and assigned/admin users to write,
-- to objects stored under the path: {org_id}/{lot_id}/...
--
-- Buckets used: photos, documents
-- Run in Supabase SQL Editor as role: postgres

begin;

create or replace function public.bf_storage_org_id_from_name(p_name text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select nullif(split_part(coalesce(p_name, ''), '/', 1), '')::uuid
$$;

create or replace function public.bf_storage_lot_id_from_name(p_name text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif(split_part(coalesce(p_name, ''), '/', 2), '')
$$;

create or replace function public.bf_storage_can_read(p_bucket_id text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.uid() is not null
    and p_bucket_id in ('photos', 'documents')
    and public.bf_storage_org_id_from_name(p_name) = public.current_profile_org_id()
$$;

create or replace function public.bf_storage_can_write(p_bucket_id text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.bf_storage_can_read(p_bucket_id, p_name)
    and public.bf_can_edit_lot(public.bf_storage_lot_id_from_name(p_name))
$$;

grant execute on function public.bf_storage_org_id_from_name(text) to authenticated;
grant execute on function public.bf_storage_lot_id_from_name(text) to authenticated;
grant execute on function public.bf_storage_can_read(text, text) to authenticated;
grant execute on function public.bf_storage_can_write(text, text) to authenticated;

-- RLS policies on storage.objects (Supabase Storage)
-- Drop first to keep script re-runnable.
drop policy if exists bf_storage_read on storage.objects;
drop policy if exists bf_storage_insert on storage.objects;
drop policy if exists bf_storage_update on storage.objects;
drop policy if exists bf_storage_delete on storage.objects;

create policy bf_storage_read
on storage.objects
for select
to authenticated
using (public.bf_storage_can_read(bucket_id, name));

create policy bf_storage_insert
on storage.objects
for insert
to authenticated
with check (public.bf_storage_can_write(bucket_id, name));

create policy bf_storage_update
on storage.objects
for update
to authenticated
using (public.bf_storage_can_write(bucket_id, name))
with check (public.bf_storage_can_write(bucket_id, name));

create policy bf_storage_delete
on storage.objects
for delete
to authenticated
using (public.bf_storage_can_write(bucket_id, name));

commit;

