-- BuildFlow guest org provisioning helper
-- Run in Supabase SQL Editor as role: postgres
-- Org id pinned to: 97165bae-19d5-41f6-978c-352876ac108b

create or replace function public.ensure_guest_org()
returns table (org_id uuid, role text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := '97165bae-19d5-41f6-978c-352876ac108b'::uuid;
  v_role text := 'admin';
  v_display text := 'Guest';
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  begin
    v_display := coalesce(auth.jwt() ->> 'email', auth.jwt() ->> 'phone', 'Guest');
  exception when others then
    v_display := 'Guest';
  end;

  insert into public.organizations (id, name, builder_name, default_build_days, work_days, holidays)
  values (
    v_org_id,
    'BuildFlow Demo',
    'BuildFlow Demo',
    120,
    array[1,2,3,4,5],
    '{}'::text[]
  )
  on conflict (id) do nothing;

  insert into public.profiles (id, org_id, role, display_name)
  values (auth.uid(), v_org_id, v_role, v_display)
  on conflict (id) do update
  set
    org_id = excluded.org_id,
    role = excluded.role,
    display_name = excluded.display_name,
    updated_at = now();

  return query select v_org_id, v_role;
end;
$$;

grant execute on function public.ensure_guest_org() to authenticated;
