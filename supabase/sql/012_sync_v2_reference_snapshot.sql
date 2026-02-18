-- BuildFlow sync v2 reference-data lane
-- Adds a first-class reference_snapshot op and incremental pull coverage for
-- communities/subcontractors/product types/plans/agencies.

begin;

create or replace function public.sync_apply_reference_snapshot(p_snapshot jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_user_id uuid := auth.uid();
  v_row jsonb;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if v_org_id is null then
    raise exception 'No org for current user';
  end if;

  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'reference_snapshot missing snapshot object';
  end if;

  if not (public.bf_is_admin() or public.bf_current_org_is_demo()) then
    raise exception 'Not authorized to sync reference data';
  end if;

  if jsonb_typeof(p_snapshot->'product_types') = 'array' then
    for v_row in select value from jsonb_array_elements(p_snapshot->'product_types')
    loop
      if nullif(v_row->>'id', '') is null then continue; end if;
      insert into public.product_types (
        id, org_id, name, build_days, template_id, sort_order, is_active,
        updated_by, deleted_at
      )
      values (
        v_row->>'id',
        v_org_id,
        coalesce(nullif(v_row->>'name', ''), 'Product Type'),
        greatest(1, coalesce(nullif(v_row->>'build_days', '')::int, 1)),
        nullif(v_row->>'template_id', ''),
        coalesce(nullif(v_row->>'sort_order', '')::int, 0),
        coalesce((v_row->>'is_active')::boolean, true),
        v_user_id,
        nullif(v_row->>'deleted_at', '')::timestamptz
      )
      on conflict (id) do update
      set
        name = excluded.name,
        build_days = excluded.build_days,
        template_id = excluded.template_id,
        sort_order = excluded.sort_order,
        is_active = excluded.is_active,
        updated_by = v_user_id,
        deleted_at = excluded.deleted_at
      where public.product_types.org_id = v_org_id;
    end loop;
  end if;

  if jsonb_typeof(p_snapshot->'plans') = 'array' then
    for v_row in select value from jsonb_array_elements(p_snapshot->'plans')
    loop
      if nullif(v_row->>'id', '') is null then continue; end if;
      insert into public.plans (
        id, org_id, name, product_type_id, sq_ft, bedrooms, bathrooms, is_active,
        updated_by, deleted_at
      )
      values (
        v_row->>'id',
        v_org_id,
        coalesce(nullif(v_row->>'name', ''), 'Plan'),
        nullif(v_row->>'product_type_id', ''),
        nullif(v_row->>'sq_ft', '')::numeric,
        nullif(v_row->>'bedrooms', '')::numeric,
        nullif(v_row->>'bathrooms', '')::numeric,
        coalesce((v_row->>'is_active')::boolean, true),
        v_user_id,
        nullif(v_row->>'deleted_at', '')::timestamptz
      )
      on conflict (id) do update
      set
        name = excluded.name,
        product_type_id = excluded.product_type_id,
        sq_ft = excluded.sq_ft,
        bedrooms = excluded.bedrooms,
        bathrooms = excluded.bathrooms,
        is_active = excluded.is_active,
        updated_by = v_user_id,
        deleted_at = excluded.deleted_at
      where public.plans.org_id = v_org_id;
    end loop;
  end if;

  if jsonb_typeof(p_snapshot->'agencies') = 'array' then
    for v_row in select value from jsonb_array_elements(p_snapshot->'agencies')
    loop
      if nullif(v_row->>'id', '') is null then continue; end if;
      insert into public.agencies (
        id, org_id, name, type, inspection_types, is_org_level, is_active,
        updated_by, deleted_at
      )
      values (
        v_row->>'id',
        v_org_id,
        coalesce(nullif(v_row->>'name', ''), 'Agency'),
        coalesce(nullif(v_row->>'type', ''), 'municipality'),
        coalesce(array(select jsonb_array_elements_text(coalesce(v_row->'inspection_types', '[]'::jsonb))), '{}'::text[]),
        coalesce((v_row->>'is_org_level')::boolean, true),
        coalesce((v_row->>'is_active')::boolean, true),
        v_user_id,
        nullif(v_row->>'deleted_at', '')::timestamptz
      )
      on conflict (id) do update
      set
        name = excluded.name,
        type = excluded.type,
        inspection_types = excluded.inspection_types,
        is_org_level = excluded.is_org_level,
        is_active = excluded.is_active,
        updated_by = v_user_id,
        deleted_at = excluded.deleted_at
      where public.agencies.org_id = v_org_id;
    end loop;
  end if;

  if jsonb_typeof(p_snapshot->'communities') = 'array' then
    for v_row in select value from jsonb_array_elements(p_snapshot->'communities')
    loop
      if nullif(v_row->>'id', '') is null then continue; end if;
      insert into public.communities (
        id, org_id, name, address, product_type_ids, lot_count, lots_by_product_type,
        builders, realtors, inspectors, agency_ids, agencies, documents, specs,
        is_active, updated_by, deleted_at
      )
      values (
        v_row->>'id',
        v_org_id,
        coalesce(nullif(v_row->>'name', ''), 'Community'),
        coalesce(v_row->'address', '{}'::jsonb),
        coalesce(array(select jsonb_array_elements_text(coalesce(v_row->'product_type_ids', '[]'::jsonb))), '{}'::text[]),
        greatest(0, coalesce(nullif(v_row->>'lot_count', '')::int, 0)),
        coalesce(v_row->'lots_by_product_type', '{}'::jsonb),
        coalesce(v_row->'builders', '[]'::jsonb),
        coalesce(v_row->'realtors', '[]'::jsonb),
        coalesce(v_row->'inspectors', '[]'::jsonb),
        coalesce(array(select jsonb_array_elements_text(coalesce(v_row->'agency_ids', '[]'::jsonb))), '{}'::text[]),
        coalesce(v_row->'agencies', '[]'::jsonb),
        coalesce(v_row->'documents', '[]'::jsonb),
        coalesce(v_row->'specs', '[]'::jsonb),
        coalesce((v_row->>'is_active')::boolean, true),
        v_user_id,
        nullif(v_row->>'deleted_at', '')::timestamptz
      )
      on conflict (id) do update
      set
        name = excluded.name,
        address = excluded.address,
        product_type_ids = excluded.product_type_ids,
        lot_count = excluded.lot_count,
        lots_by_product_type = excluded.lots_by_product_type,
        builders = excluded.builders,
        realtors = excluded.realtors,
        inspectors = excluded.inspectors,
        agency_ids = excluded.agency_ids,
        agencies = excluded.agencies,
        documents = excluded.documents,
        specs = excluded.specs,
        is_active = excluded.is_active,
        updated_by = v_user_id,
        deleted_at = excluded.deleted_at
      where public.communities.org_id = v_org_id;
    end loop;
  end if;

  if jsonb_typeof(p_snapshot->'subcontractors') = 'array' then
    for v_row in select value from jsonb_array_elements(p_snapshot->'subcontractors')
    loop
      if nullif(v_row->>'id', '') is null then continue; end if;
      insert into public.subcontractors (
        id, org_id, name, company_name, trade, secondary_trades,
        phone, email, office_phone, primary_contact, additional_contacts,
        insurance_expiration, license_number, w9_on_file, crew_size,
        is_preferred, is_backup, rating, total_jobs, on_time_pct, delay_count,
        blackout_dates, notes, status, documents, custom_fields,
        updated_by, deleted_at
      )
      values (
        v_row->>'id',
        v_org_id,
        coalesce(nullif(v_row->>'name', ''), 'Subcontractor'),
        coalesce(v_row->>'company_name', v_row->>'name', 'Subcontractor'),
        coalesce(nullif(v_row->>'trade', ''), 'other'),
        coalesce(array(select jsonb_array_elements_text(coalesce(v_row->'secondary_trades', '[]'::jsonb))), '{}'::text[]),
        nullif(v_row->>'phone', ''),
        nullif(v_row->>'email', ''),
        nullif(v_row->>'office_phone', ''),
        coalesce(v_row->'primary_contact', '{}'::jsonb),
        coalesce(v_row->'additional_contacts', '[]'::jsonb),
        nullif(v_row->>'insurance_expiration', '')::date,
        nullif(v_row->>'license_number', ''),
        coalesce((v_row->>'w9_on_file')::boolean, false),
        nullif(v_row->>'crew_size', '')::int,
        coalesce((v_row->>'is_preferred')::boolean, true),
        coalesce((v_row->>'is_backup')::boolean, false),
        nullif(v_row->>'rating', '')::numeric,
        coalesce(nullif(v_row->>'total_jobs', '')::int, 0),
        nullif(v_row->>'on_time_pct', '')::numeric,
        coalesce(nullif(v_row->>'delay_count', '')::int, 0),
        coalesce(array(select jsonb_array_elements_text(coalesce(v_row->'blackout_dates', '[]'::jsonb))), '{}'::text[]),
        nullif(v_row->>'notes', ''),
        coalesce(nullif(v_row->>'status', ''), 'active'),
        coalesce(v_row->'documents', '[]'::jsonb),
        coalesce(v_row->'custom_fields', '{}'::jsonb),
        v_user_id,
        nullif(v_row->>'deleted_at', '')::timestamptz
      )
      on conflict (id) do update
      set
        name = excluded.name,
        company_name = excluded.company_name,
        trade = excluded.trade,
        secondary_trades = excluded.secondary_trades,
        phone = excluded.phone,
        email = excluded.email,
        office_phone = excluded.office_phone,
        primary_contact = excluded.primary_contact,
        additional_contacts = excluded.additional_contacts,
        insurance_expiration = excluded.insurance_expiration,
        license_number = excluded.license_number,
        w9_on_file = excluded.w9_on_file,
        crew_size = excluded.crew_size,
        is_preferred = excluded.is_preferred,
        is_backup = excluded.is_backup,
        rating = excluded.rating,
        total_jobs = excluded.total_jobs,
        on_time_pct = excluded.on_time_pct,
        delay_count = excluded.delay_count,
        blackout_dates = excluded.blackout_dates,
        notes = excluded.notes,
        status = excluded.status,
        documents = excluded.documents,
        custom_fields = excluded.custom_fields,
        updated_by = v_user_id,
        deleted_at = excluded.deleted_at
      where public.subcontractors.org_id = v_org_id;
    end loop;
  end if;

  if jsonb_typeof(p_snapshot->'lots') = 'array' then
    for v_row in select value from jsonb_array_elements(p_snapshot->'lots')
    loop
      if nullif(v_row->>'id', '') is null then continue; end if;
      insert into public.lots (
        id, org_id, community_id, block, lot_number, product_type_id, plan_id, builder_id,
        address, job_number, permit_number, model_type, status, start_date,
        hard_deadline, build_days, target_completion_date, actual_completion_date,
        sold_status, sold_date, custom_fields, inspections, punch_list,
        daily_logs, change_orders, material_orders, documents, photos,
        updated_by, deleted_at
      )
      values (
        v_row->>'id',
        v_org_id,
        nullif(v_row->>'community_id', ''),
        coalesce(v_row->>'block', ''),
        coalesce(v_row->>'lot_number', ''),
        nullif(v_row->>'product_type_id', ''),
        nullif(v_row->>'plan_id', ''),
        nullif(v_row->>'builder_id', ''),
        coalesce(v_row->>'address', ''),
        coalesce(v_row->>'job_number', ''),
        nullif(v_row->>'permit_number', ''),
        coalesce(v_row->>'model_type', ''),
        coalesce(nullif(v_row->>'status', ''), 'not_started'),
        nullif(v_row->>'start_date', '')::date,
        nullif(v_row->>'hard_deadline', '')::date,
        greatest(1, coalesce(nullif(v_row->>'build_days', '')::int, 1)),
        nullif(v_row->>'target_completion_date', '')::date,
        nullif(v_row->>'actual_completion_date', '')::date,
        coalesce(nullif(v_row->>'sold_status', ''), 'available'),
        nullif(v_row->>'sold_date', '')::date,
        coalesce(v_row->'custom_fields', '{}'::jsonb),
        coalesce(v_row->'inspections', '[]'::jsonb),
        case when v_row ? 'punch_list' then v_row->'punch_list' else null end,
        coalesce(v_row->'daily_logs', '[]'::jsonb),
        coalesce(v_row->'change_orders', '[]'::jsonb),
        coalesce(v_row->'material_orders', '[]'::jsonb),
        coalesce(v_row->'documents', '[]'::jsonb),
        coalesce(v_row->'photos', '[]'::jsonb),
        v_user_id,
        nullif(v_row->>'deleted_at', '')::timestamptz
      )
      on conflict (id) do update
      set
        community_id = excluded.community_id,
        block = excluded.block,
        lot_number = excluded.lot_number,
        product_type_id = excluded.product_type_id,
        plan_id = excluded.plan_id,
        builder_id = excluded.builder_id,
        address = excluded.address,
        job_number = excluded.job_number,
        permit_number = excluded.permit_number,
        model_type = excluded.model_type,
        status = excluded.status,
        start_date = excluded.start_date,
        hard_deadline = excluded.hard_deadline,
        build_days = excluded.build_days,
        target_completion_date = excluded.target_completion_date,
        actual_completion_date = excluded.actual_completion_date,
        sold_status = excluded.sold_status,
        sold_date = excluded.sold_date,
        custom_fields = excluded.custom_fields,
        inspections = excluded.inspections,
        punch_list = excluded.punch_list,
        daily_logs = excluded.daily_logs,
        change_orders = excluded.change_orders,
        material_orders = excluded.material_orders,
        documents = excluded.documents,
        photos = excluded.photos,
        updated_by = v_user_id,
        deleted_at = excluded.deleted_at
      where public.lots.org_id = v_org_id;
    end loop;
  end if;

  if jsonb_typeof(p_snapshot->'lot_assignments') = 'array' then
    for v_row in select value from jsonb_array_elements(p_snapshot->'lot_assignments')
    loop
      if nullif(v_row->>'id', '') is null then continue; end if;
      if nullif(v_row->>'lot_id', '') is null then continue; end if;
      if nullif(v_row->>'profile_id', '') is null then continue; end if;
      insert into public.lot_assignments (
        id, org_id, lot_id, profile_id, role, ended_at, deleted_at, created_by, updated_by
      )
      values (
        (v_row->>'id')::uuid,
        v_org_id,
        v_row->>'lot_id',
        (v_row->>'profile_id')::uuid,
        coalesce(nullif(v_row->>'role', ''), 'super'),
        nullif(v_row->>'ended_at', '')::timestamptz,
        nullif(v_row->>'deleted_at', '')::timestamptz,
        v_user_id,
        v_user_id
      )
      on conflict (id) do update
      set
        lot_id = excluded.lot_id,
        profile_id = excluded.profile_id,
        role = excluded.role,
        ended_at = excluded.ended_at,
        deleted_at = excluded.deleted_at,
        updated_by = v_user_id
      where public.lot_assignments.org_id = v_org_id;
    end loop;
  end if;
end;
$$;

grant execute on function public.sync_apply_reference_snapshot(jsonb) to authenticated;

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
    'product_types', coalesce((select max(version) from public.product_types pt where pt.org_id = v_org_id), 0),
    'plans', coalesce((select max(version) from public.plans p where p.org_id = v_org_id), 0),
    'agencies', coalesce((select max(version) from public.agencies a where a.org_id = v_org_id), 0),
    'communities', coalesce((select max(version) from public.communities c where c.org_id = v_org_id), 0),
    'subcontractors', coalesce((select max(version) from public.subcontractors s where s.org_id = v_org_id), 0),
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
    'product_types', coalesce(
      (
        select jsonb_agg(pt)
        from public.product_types pt
        where pt.org_id = v_org_id
          and (p_since is null or pt.updated_at > p_since)
      ),
      '[]'::jsonb
    ),
    'plans', coalesce(
      (
        select jsonb_agg(p)
        from public.plans p
        where p.org_id = v_org_id
          and (p_since is null or p.updated_at > p_since)
      ),
      '[]'::jsonb
    ),
    'agencies', coalesce(
      (
        select jsonb_agg(a)
        from public.agencies a
        where a.org_id = v_org_id
          and (p_since is null or a.updated_at > p_since)
      ),
      '[]'::jsonb
    ),
    'communities', coalesce(
      (
        select jsonb_agg(c)
        from public.communities c
        where c.org_id = v_org_id
          and (p_since is null or c.updated_at > p_since)
      ),
      '[]'::jsonb
    ),
    'subcontractors', coalesce(
      (
        select jsonb_agg(s)
        from public.subcontractors s
        where s.org_id = v_org_id
          and (p_since is null or s.updated_at > p_since)
      ),
      '[]'::jsonb
    ),
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
      if v_kind = 'reference_snapshot' then
        perform public.sync_apply_reference_snapshot(v_op->'snapshot');
      else
        perform public.sync_push_unsafe(jsonb_build_array(v_op));
      end if;

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

commit;
