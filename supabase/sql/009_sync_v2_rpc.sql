-- BuildFlow sync v2 RPCs (additive)
-- Provides cursor-based pull + durable outbox push with optimistic concurrency.
-- Run in Supabase SQL Editor as role: postgres

begin;

-- -------------------------------------------------------------------
-- sync_pull: cursor-based incremental reads
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
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if v_org_id is null then
    raise exception 'No org for current user';
  end if;

  return jsonb_build_object(
    'server_time', v_now,
    'since', p_since,
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
-- sync_push: apply a list of ops transactionally
--
-- Initial supported op shapes (JSON):
--   { id, kind: 'tasks_batch', lot_id, tasks: [{ action, id, base_version, row }] }
--     - action: 'upsert' | 'delete'
--     - row: task-like object (client sends full row; server enforces org + lot)
--   { id, kind: 'attachments_batch', attachments: [{ action, id, base_version, row }] }
--     - action: 'upsert' | 'delete'
--     - row: attachment-like object (client sends row; server enforces org + lot)
-- -------------------------------------------------------------------

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
  v_kind text;
  v_op_id text;
  v_lot_id text;
  v_lot_base_version int;
  v_lot_row jsonb;
  v_task jsonb;
  v_task_action text;
  v_task_id text;
  v_base_version int;
  v_row jsonb;
  v_attachment jsonb;
  v_attachment_action text;
  v_attachment_id text;
  v_attachment_base_version int;
  v_attachment_row jsonb;
  v_attachment_lot_id text;
  v_applied jsonb := '[]'::jsonb;
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

  -- Apply each op in order. If any op raises, the whole function call rolls back.
  for v_op in select value from jsonb_array_elements(p_ops)
  loop
    v_kind := coalesce(v_op->>'kind', '');
    v_op_id := coalesce(v_op->>'id', '');

    if v_kind = 'tasks_batch' then
      v_lot_id := nullif(v_op->>'lot_id', '');
      if v_lot_id is null then
        raise exception 'tasks_batch missing lot_id';
      end if;

      if not public.bf_can_edit_lot(v_lot_id) then
        raise exception 'Not authorized to edit lot %', v_lot_id;
      end if;

      -- Optional lot patch with optimistic concurrency check.
      if jsonb_typeof(v_op->'lot') = 'object' then
        v_lot_row := v_op->'lot';
        v_lot_base_version := nullif(v_op->>'lot_base_version','')::int;
        if v_lot_base_version is null then
          raise exception 'Lot update requires lot_base_version (lot %)', v_lot_id;
        end if;

        update public.lots l
        set
          status = (case when v_lot_row ? 'status' then coalesce(v_lot_row->>'status', l.status) else l.status end),
          start_date = (case when v_lot_row ? 'start_date' then nullif(v_lot_row->>'start_date','')::date else l.start_date end),
          plan_id = (case when v_lot_row ? 'plan_id' then nullif(v_lot_row->>'plan_id','') else l.plan_id end),
          job_number = (case when v_lot_row ? 'job_number' then coalesce(v_lot_row->>'job_number','') else l.job_number end),
          address = (case when v_lot_row ? 'address' then coalesce(v_lot_row->>'address','') else l.address end),
          permit_number = (case when v_lot_row ? 'permit_number' then nullif(v_lot_row->>'permit_number','') else l.permit_number end),
          hard_deadline = (case when v_lot_row ? 'hard_deadline' then nullif(v_lot_row->>'hard_deadline','')::date else l.hard_deadline end),
          model_type = (case when v_lot_row ? 'model_type' then coalesce(v_lot_row->>'model_type','') else l.model_type end),
          build_days = (case when v_lot_row ? 'build_days' then greatest(1, coalesce((v_lot_row->>'build_days')::int, l.build_days)) else l.build_days end),
          target_completion_date = (case when v_lot_row ? 'target_completion_date' then nullif(v_lot_row->>'target_completion_date','')::date else l.target_completion_date end),
          actual_completion_date = (case when v_lot_row ? 'actual_completion_date' then nullif(v_lot_row->>'actual_completion_date','')::date else l.actual_completion_date end),
          custom_fields = (case when v_lot_row ? 'custom_fields' then coalesce(v_lot_row->'custom_fields', '{}'::jsonb) else l.custom_fields end),
          updated_by = v_user_id
        where l.org_id = v_org_id
          and l.id = v_lot_id
          and l.version = v_lot_base_version
          and l.deleted_at is null;

        if not found then
          raise exception 'Conflict (lot update): %', v_lot_id;
        end if;
      end if;

      if jsonb_typeof(v_op->'tasks') <> 'array' then
        raise exception 'tasks_batch missing tasks array';
      end if;

      for v_task in select value from jsonb_array_elements(v_op->'tasks')
      loop
        v_task_action := coalesce(v_task->>'action', 'upsert');
        v_task_id := nullif(v_task->>'id', '');
        v_base_version := nullif(v_task->>'base_version', '')::int;
        v_row := v_task->'row';

        if v_task_id is null then
          raise exception 'Task missing id';
        end if;

        if v_task_action = 'delete' then
          if v_base_version is null then
            raise exception 'Delete requires base_version (task %)', v_task_id;
          end if;

          update public.tasks t
          set deleted_at = v_now,
              updated_by = v_user_id
          where t.org_id = v_org_id
            and t.lot_id = v_lot_id
            and t.id = v_task_id
            and t.version = v_base_version
            and t.deleted_at is null;

          if not found then
            raise exception 'Conflict (task delete): %', v_task_id;
          end if;
        else
          if v_row is null or jsonb_typeof(v_row) <> 'object' then
            raise exception 'Upsert requires row object (task %)', v_task_id;
          end if;

          if v_base_version is null then
            -- Insert new row. If the id already exists, treat as conflict.
            begin
              insert into public.tasks (
                id, org_id, lot_id,
                name, trade, track, phase, duration, sort_order, status,
                scheduled_start, scheduled_end,
                actual_start, actual_end,
                sub_id, notes, delay_reason, delay_days, custom_fields,
                updated_by
              )
              values (
                v_task_id, v_org_id, v_lot_id,
                coalesce(v_row->>'name', 'Task'),
                coalesce(v_row->>'trade', 'other'),
                coalesce(v_row->>'track', 'foundation'),
                coalesce(v_row->>'phase', 'foundation'),
                greatest(1, coalesce((v_row->>'duration')::int, 1)),
                coalesce((v_row->>'sort_order')::int, 0),
                coalesce(v_row->>'status', 'not_started'),
                nullif(v_row->>'scheduled_start', ''),
                nullif(v_row->>'scheduled_end', ''),
                nullif(v_row->>'actual_start', ''),
                nullif(v_row->>'actual_end', ''),
                nullif(v_row->>'sub_id', ''),
                nullif(v_row->>'notes', ''),
                nullif(v_row->>'delay_reason', ''),
                coalesce((v_row->>'delay_days')::int, 0),
                coalesce(v_row->'custom_fields', '{}'::jsonb),
                v_user_id
              );
            exception
              when unique_violation then
                raise exception 'Conflict (task insert exists): %', v_task_id;
            end;
          else
            -- Update with optimistic concurrency check.
            update public.tasks t
            set
              name = coalesce(v_row->>'name', t.name),
              trade = coalesce(v_row->>'trade', t.trade),
              track = coalesce(v_row->>'track', t.track),
              phase = coalesce(v_row->>'phase', t.phase),
              duration = greatest(1, coalesce((v_row->>'duration')::int, t.duration)),
              sort_order = coalesce((v_row->>'sort_order')::int, t.sort_order),
              status = coalesce(v_row->>'status', t.status),
              scheduled_start = (case when v_row ? 'scheduled_start' then nullif(v_row->>'scheduled_start','') else t.scheduled_start end),
              scheduled_end = (case when v_row ? 'scheduled_end' then nullif(v_row->>'scheduled_end','') else t.scheduled_end end),
              actual_start = (case when v_row ? 'actual_start' then nullif(v_row->>'actual_start','') else t.actual_start end),
              actual_end = (case when v_row ? 'actual_end' then nullif(v_row->>'actual_end','') else t.actual_end end),
              sub_id = (case when v_row ? 'sub_id' then nullif(v_row->>'sub_id','') else t.sub_id end),
              notes = (case when v_row ? 'notes' then nullif(v_row->>'notes','') else t.notes end),
              delay_reason = (case when v_row ? 'delay_reason' then nullif(v_row->>'delay_reason','') else t.delay_reason end),
              delay_days = (case when v_row ? 'delay_days' then coalesce((v_row->>'delay_days')::int, 0) else t.delay_days end),
              custom_fields = (case when v_row ? 'custom_fields' then coalesce(v_row->'custom_fields', '{}'::jsonb) else t.custom_fields end),
              updated_by = v_user_id
            where t.org_id = v_org_id
              and t.lot_id = v_lot_id
              and t.id = v_task_id
              and t.version = v_base_version
              and t.deleted_at is null;

            if not found then
              raise exception 'Conflict (task update): %', v_task_id;
            end if;
          end if;
        end if;
      end loop;

      v_applied := v_applied || jsonb_build_array(jsonb_build_object('id', v_op_id, 'kind', v_kind, 'lot_id', v_lot_id, 'applied_at', v_now));
    elsif v_kind = 'attachments_batch' then
      if jsonb_typeof(v_op->'attachments') <> 'array' then
        raise exception 'attachments_batch missing attachments array';
      end if;

      for v_attachment in select value from jsonb_array_elements(v_op->'attachments')
      loop
        v_attachment_action := coalesce(v_attachment->>'action', 'upsert');
        v_attachment_id := nullif(v_attachment->>'id', '');
        v_attachment_base_version := nullif(v_attachment->>'base_version', '')::int;
        v_attachment_row := v_attachment->'row';

        if v_attachment_id is null then
          raise exception 'Attachment missing id';
        end if;

        if v_attachment_action = 'delete' then
          if v_attachment_base_version is null then
            raise exception 'Delete requires base_version (attachment %)', v_attachment_id;
          end if;

          update public.attachments a
          set deleted_at = v_now,
              updated_by = v_user_id
          where a.org_id = v_org_id
            and a.id = v_attachment_id::uuid
            and a.version = v_attachment_base_version
            and a.deleted_at is null;

          if not found then
            raise exception 'Conflict (attachment delete): %', v_attachment_id;
          end if;
        else
          if v_attachment_row is null or jsonb_typeof(v_attachment_row) <> 'object' then
            raise exception 'Upsert requires row object (attachment %)', v_attachment_id;
          end if;

          v_attachment_lot_id := nullif(v_attachment_row->>'lot_id', '');
          if v_attachment_lot_id is null then
            raise exception 'Attachment upsert requires lot_id (attachment %)', v_attachment_id;
          end if;

          if not public.bf_can_edit_lot(v_attachment_lot_id) then
            raise exception 'Not authorized to edit lot %', v_attachment_lot_id;
          end if;

          if v_attachment_base_version is null then
            begin
              insert into public.attachments (
                id, org_id, lot_id, task_id,
                kind, category, caption, mime, file_name, file_size, checksum,
                storage_bucket, storage_path, thumb_storage_path,
                created_by, updated_by
              )
              values (
                v_attachment_id::uuid, v_org_id, v_attachment_lot_id,
                nullif(v_attachment_row->>'task_id', ''),
                coalesce(v_attachment_row->>'kind', 'photo'),
                nullif(v_attachment_row->>'category', ''),
                nullif(v_attachment_row->>'caption', ''),
                coalesce(v_attachment_row->>'mime', 'application/octet-stream'),
                coalesce(v_attachment_row->>'file_name', ''),
                greatest(0, coalesce((v_attachment_row->>'file_size')::int, 0)),
                nullif(v_attachment_row->>'checksum', ''),
                coalesce(v_attachment_row->>'storage_bucket', 'buildflow'),
                nullif(v_attachment_row->>'storage_path', ''),
                nullif(v_attachment_row->>'thumb_storage_path', ''),
                v_user_id, v_user_id
              );
            exception
              when unique_violation then
                raise exception 'Conflict (attachment insert exists): %', v_attachment_id;
            end;
          else
            update public.attachments a
            set
              lot_id = (case when v_attachment_row ? 'lot_id' then nullif(v_attachment_row->>'lot_id','') else a.lot_id end),
              task_id = (case when v_attachment_row ? 'task_id' then nullif(v_attachment_row->>'task_id','') else a.task_id end),
              kind = (case when v_attachment_row ? 'kind' then coalesce(v_attachment_row->>'kind', a.kind) else a.kind end),
              category = (case when v_attachment_row ? 'category' then nullif(v_attachment_row->>'category','') else a.category end),
              caption = (case when v_attachment_row ? 'caption' then nullif(v_attachment_row->>'caption','') else a.caption end),
              mime = (case when v_attachment_row ? 'mime' then coalesce(v_attachment_row->>'mime', a.mime) else a.mime end),
              file_name = (case when v_attachment_row ? 'file_name' then coalesce(v_attachment_row->>'file_name', a.file_name) else a.file_name end),
              file_size = (case when v_attachment_row ? 'file_size' then greatest(0, coalesce((v_attachment_row->>'file_size')::int, a.file_size)) else a.file_size end),
              checksum = (case when v_attachment_row ? 'checksum' then nullif(v_attachment_row->>'checksum','') else a.checksum end),
              storage_bucket = (case when v_attachment_row ? 'storage_bucket' then coalesce(v_attachment_row->>'storage_bucket', a.storage_bucket) else a.storage_bucket end),
              storage_path = (case when v_attachment_row ? 'storage_path' then nullif(v_attachment_row->>'storage_path','') else a.storage_path end),
              thumb_storage_path = (case when v_attachment_row ? 'thumb_storage_path' then nullif(v_attachment_row->>'thumb_storage_path','') else a.thumb_storage_path end),
              updated_by = v_user_id
            where a.org_id = v_org_id
              and a.id = v_attachment_id::uuid
              and a.version = v_attachment_base_version
              and a.deleted_at is null;

            if not found then
              raise exception 'Conflict (attachment update): %', v_attachment_id;
            end if;
          end if;
        end if;
      end loop;

      v_applied := v_applied || jsonb_build_array(jsonb_build_object('id', v_op_id, 'kind', v_kind, 'applied_at', v_now));
    else
      raise exception 'Unsupported op kind: %', v_kind;
    end if;
  end loop;

  return jsonb_build_object(
    'server_time', v_now,
    'applied', v_applied
  );
end;
$$;

grant execute on function public.sync_push(jsonb) to authenticated;

commit;
