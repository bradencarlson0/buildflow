-- Qualify lot_locks columns inside acquire_lot_lock to avoid ambiguity with
-- RETURNS TABLE output variables (token/expires_at/locked_by).
create or replace function public.acquire_lot_lock(p_lot_id text, p_ttl_seconds integer default 300)
returns table (token uuid, expires_at timestamptz, locked_by uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_user_id uuid := auth.uid();
  v_ttl integer := greatest(60, least(coalesce(p_ttl_seconds, 300), 1800));
  v_now timestamptz := now();
  v_expires timestamptz := v_now + make_interval(secs => v_ttl);
  v_existing record;
  v_token uuid;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if not public.bf_can_edit_lot(p_lot_id) then
    raise exception 'Not authorized';
  end if;

  -- Clear expired lock if present.
  delete from public.lot_locks as l
  where l.lot_id = p_lot_id
    and l.org_id = v_org_id
    and l.expires_at <= v_now;

  select l.* into v_existing
  from public.lot_locks as l
  where l.lot_id = p_lot_id
    and l.org_id = v_org_id
  limit 1;

  if v_existing is null then
    v_token := gen_random_uuid();
    insert into public.lot_locks (lot_id, org_id, locked_by, token, expires_at, updated_by)
    values (p_lot_id, v_org_id, v_user_id, v_token, v_expires, v_user_id);
    return query select v_token, v_expires, v_user_id;
    return;
  end if;

  if v_existing.locked_by = v_user_id then
    update public.lot_locks as l
    set expires_at = v_expires, updated_by = v_user_id
    where l.lot_id = p_lot_id and l.org_id = v_org_id;
    return query select v_existing.token, v_expires, v_user_id;
    return;
  end if;

  if public.bf_is_admin() then
    v_token := gen_random_uuid();
    update public.lot_locks as l
    set locked_by = v_user_id, token = v_token, expires_at = v_expires, updated_by = v_user_id
    where l.lot_id = p_lot_id and l.org_id = v_org_id;
    return query select v_token, v_expires, v_user_id;
    return;
  end if;

  raise exception 'Lot is locked by another user';
end;
$$;

grant execute on function public.acquire_lot_lock(text, integer) to authenticated;
