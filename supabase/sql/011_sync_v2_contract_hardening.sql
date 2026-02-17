-- BuildFlow sync v2 contract hardening + demo baseline protection guards
-- Run in Supabase SQL Editor as role: postgres

begin;

-- -------------------------------------------------------------------
-- 1) Baseline protection metadata on organizations
-- -------------------------------------------------------------------

alter table public.organizations add column if not exists baseline_protection_enabled boolean not null default false;
alter table public.organizations add column if not exists baseline_id text;
alter table public.organizations add column if not exists baseline_checksum text;
alter table public.organizations add column if not exists baseline_protected_at timestamptz;
alter table public.organizations add column if not exists baseline_protected_by uuid;

create or replace function public.set_demo_baseline_protection(
  p_enabled boolean default true,
  p_baseline_id text default null,
  p_baseline_checksum text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_user_id uuid := auth.uid();
  v_is_admin boolean := false;
  v_row public.organizations%rowtype;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select (role = 'admin') into v_is_admin
  from public.profiles
  where id = v_user_id;

  if coalesce(v_is_admin, false) = false then
    raise exception 'Not authorized';
  end if;

  if v_org_id is null then
    raise exception 'No org for current user';
  end if;

  update public.organizations o
  set
    baseline_protection_enabled = coalesce(p_enabled, false),
    baseline_id = case when coalesce(p_enabled, false) then nullif(trim(coalesce(p_baseline_id, '')), '') else null end,
    baseline_checksum = case when coalesce(p_enabled, false) then nullif(trim(coalesce(p_baseline_checksum, '')), '') else null end,
    baseline_protected_at = case when coalesce(p_enabled, false) then now() else null end,
    baseline_protected_by = case when coalesce(p_enabled, false) then v_user_id else null end,
    updated_by = v_user_id
  where o.id = v_org_id
  returning o.* into v_row;

  if v_row.id is null then
    raise exception 'Organization not found';
  end if;

  return jsonb_build_object(
    'ok', true,
    'org_id', v_row.id,
    'enabled', v_row.baseline_protection_enabled,
    'baseline_id', v_row.baseline_id,
    'baseline_checksum', v_row.baseline_checksum,
    'baseline_protected_at', v_row.baseline_protected_at,
    'baseline_protected_by', v_row.baseline_protected_by
  );
end;
$$;

grant execute on function public.set_demo_baseline_protection(boolean, text, text) to authenticated;

-- -------------------------------------------------------------------
-- 2) Protect reset_buildflow_seed by org baseline protection flag
-- -------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.reset_buildflow_seed(uuid)') is not null
     and to_regprocedure('public.reset_buildflow_seed_unsafe(uuid)') is null then
    execute 'alter function public.reset_buildflow_seed(uuid) rename to reset_buildflow_seed_unsafe';
  end if;
end;
$$;

create or replace function public.reset_buildflow_seed(target_org_id uuid default null, p_force boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := coalesce(target_org_id, public.current_profile_org_id());
  v_enabled boolean := false;
  v_baseline_id text := null;
begin
  if to_regprocedure('public.reset_buildflow_seed_unsafe(uuid)') is null then
    raise exception 'reset_buildflow_seed_unsafe is missing. Apply seed reset SQL before hardening migration.';
  end if;

  if v_org_id is null then
    raise exception 'No org id available';
  end if;

  select
    coalesce(o.baseline_protection_enabled, false),
    nullif(trim(coalesce(o.baseline_id, '')), '')
  into v_enabled, v_baseline_id
  from public.organizations o
  where o.id = v_org_id;

  if coalesce(v_enabled, false) and coalesce(p_force, false) = false then
    raise exception 'Baseline protection is enabled for org %. Disable protection before resetting seed (baseline_id=%).',
      v_org_id, coalesce(v_baseline_id, 'n/a');
  end if;

  perform public.reset_buildflow_seed_unsafe(v_org_id);
end;
$$;

grant execute on function public.reset_buildflow_seed(uuid, boolean) to authenticated;

do $$
begin
  if to_regprocedure('public.reset_buildflow_seed_unsafe(uuid)') is not null then
    execute 'revoke execute on function public.reset_buildflow_seed_unsafe(uuid) from authenticated';
    execute 'revoke execute on function public.reset_buildflow_seed_unsafe(uuid) from anon';
  end if;
end;
$$;

-- -------------------------------------------------------------------
-- 3) sync_pull contract hardening (cursor + versions metadata)
-- -------------------------------------------------------------------

create or replace function public.sync_pull(p_since timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_now timestamptz := now();
  v_versions jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if v_org_id is null then
    raise exception 'No org for current user';
  end if;

  v_versions := jsonb_build_object(
    'organizations', coalesce((select max(version) from public.organizations o where o.id = v_org_id), 0),
    'lots', coalesce((select max(version) from public.lots l where l.org_id = v_org_id), 0),
    'tasks', coalesce((select max(version) from public.tasks t where t.org_id = v_org_id), 0),
    'lot_assignments', coalesce((select max(version) from public.lot_assignments la where la.org_id = v_org_id), 0),
    'attachments', coalesce((select max(version) from public.attachments a where a.org_id = v_org_id), 0)
  );

  return jsonb_build_object(
    'server_time', v_now,
    'cursor', v_now,
    'since', p_since,
    'versions', v_versions,
    'lots', coalesce(
      (
        select jsonb_agg(l)
        from public.lots l
        where l.org_id = v_org_id
          and (p_since is null or l.updated_at > p_since)
      ),
      '[]'::jsonb
    ),
    'tasks', coalesce(
      (
        select jsonb_agg(t)
        from public.tasks t
        where t.org_id = v_org_id
          and (p_since is null or t.updated_at > p_since)
      ),
      '[]'::jsonb
    ),
    'lot_assignments', coalesce(
      (
        select jsonb_agg(la)
        from public.lot_assignments la
        where la.org_id = v_org_id
          and (p_since is null or la.updated_at > p_since)
      ),
      '[]'::jsonb
    ),
    'attachments', coalesce(
      (
        select jsonb_agg(a)
        from public.attachments a
        where a.org_id = v_org_id
          and (p_since is null or a.updated_at > p_since)
      ),
      '[]'::jsonb
    )
  );
end;
$$;

grant execute on function public.sync_pull(timestamptz) to authenticated;

-- -------------------------------------------------------------------
-- 4) sync_push contract hardening (per-op results, no silent rollback)
-- -------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.sync_push(jsonb)') is not null
     and to_regprocedure('public.sync_push_unsafe(jsonb)') is null then
    execute 'alter function public.sync_push(jsonb) rename to sync_push_unsafe';
  end if;
end;
$$;

create or replace function public.sync_push(p_ops jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_user_id uuid := auth.uid();
  v_now timestamptz := now();
  v_op jsonb;
  v_op_id text;
  v_kind text;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_applied jsonb := '[]'::jsonb;
  v_conflicts jsonb := '[]'::jsonb;
  v_status text;
  v_code text;
  v_reason text;
  v_state text;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if v_org_id is null then
    raise exception 'No org for current user';
  end if;

  if p_ops is null or jsonb_typeof(p_ops) <> 'array' then
    raise exception 'p_ops must be a JSON array';
  end if;

  if to_regprocedure('public.sync_push_unsafe(jsonb)') is null then
    raise exception 'sync_push_unsafe is missing. Apply sync v2 RPC SQL before hardening migration.';
  end if;

  for v_op in select value from jsonb_array_elements(p_ops)
  loop
    v_op_id := coalesce(nullif(v_op->>'id', ''), md5(v_op::text));
    v_kind := coalesce(nullif(v_op->>'kind', ''), 'unknown');

    begin
      perform public.sync_push_unsafe(jsonb_build_array(v_op));

      v_result := jsonb_build_object(
        'id', v_op_id,
        'kind', v_kind,
        'status', 'applied',
        'conflict_code', null,
        'conflict_reason', null,
        'applied_at', now()
      );

      v_results := v_results || jsonb_build_array(v_result);
      v_applied := v_applied || jsonb_build_array(
        jsonb_build_object(
          'id', v_op_id,
          'kind', v_kind,
          'applied_at', v_result->>'applied_at'
        )
      );
    exception when others then
      v_state := coalesce(sqlstate, 'P0001');
      v_reason := coalesce(sqlerrm, 'sync_push failed');
      v_status := 'rejected';
      v_code := 'apply_failed';

      if v_state = '42883' then
        v_status := 'unavailable';
        v_code := 'rpc_unavailable';
      elsif lower(v_reason) like '%locked by another user%' then
        v_status := 'conflict';
        v_code := 'lock_denied';
      elsif lower(v_reason) like '%conflict%' then
        v_status := 'conflict';
        v_code := 'version_conflict';
      elsif lower(v_reason) like '%not authorized%' then
        v_status := 'rejected';
        v_code := 'not_authorized';
      elsif lower(v_reason) like '%missing%' then
        v_status := 'rejected';
        v_code := 'invalid_payload';
      end if;

      v_result := jsonb_build_object(
        'id', v_op_id,
        'kind', v_kind,
        'status', v_status,
        'conflict_code', v_code,
        'conflict_reason', v_reason,
        'applied_at', null
      );

      v_results := v_results || jsonb_build_array(v_result);
      v_conflicts := v_conflicts || jsonb_build_array(v_result);
    end;
  end loop;

  return jsonb_build_object(
    'server_time', v_now,
    'results', v_results,
    'applied', v_applied,
    'conflicts', v_conflicts
  );
end;
$$;

grant execute on function public.sync_push(jsonb) to authenticated;

do $$
begin
  if to_regprocedure('public.sync_push_unsafe(jsonb)') is not null then
    execute 'revoke execute on function public.sync_push_unsafe(jsonb) from authenticated';
    execute 'revoke execute on function public.sync_push_unsafe(jsonb) from anon';
  end if;
end;
$$;

-- -------------------------------------------------------------------
-- 5) Explicit-code lock RPC wrapper
-- -------------------------------------------------------------------

create or replace function public.acquire_lot_lock_v2(p_lot_id text, p_ttl_seconds integer default 300)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_reason text;
  v_state text;
  v_code text;
begin
  begin
    select * into v_row
    from public.acquire_lot_lock(p_lot_id, p_ttl_seconds)
    limit 1;

    return jsonb_build_object(
      'ok', true,
      'code', 'ok',
      'message', null,
      'token', v_row.token,
      'expires_at', v_row.expires_at,
      'locked_by', v_row.locked_by
    );
  exception when others then
    v_state := coalesce(sqlstate, 'P0001');
    v_reason := coalesce(sqlerrm, 'Unable to acquire lock');
    v_code := 'error';

    if v_state = '42883' then
      v_code := 'rpc_unavailable';
    elsif lower(v_reason) like '%not authenticated%' then
      v_code := 'deny_not_authenticated';
    elsif lower(v_reason) like '%not authorized%' then
      v_code := 'deny_not_authorized';
    elsif lower(v_reason) like '%locked by another user%' then
      v_code := 'deny_locked';
    end if;

    return jsonb_build_object(
      'ok', false,
      'code', v_code,
      'message', v_reason,
      'token', null,
      'expires_at', null,
      'locked_by', null
    );
  end;
end;
$$;

grant execute on function public.acquire_lot_lock_v2(text, integer) to authenticated;

commit;
