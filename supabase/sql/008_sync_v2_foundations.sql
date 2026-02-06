-- BuildFlow enterprise sync v2 foundations (additive)
-- Safe to re-run; does not drop existing tables.
-- Run in Supabase SQL Editor as role: postgres
-- Demo org id pinned to: 97165bae-19d5-41f6-978c-352876ac108b

begin;

create extension if not exists pgcrypto;

-- -------------------------------------------------------------------
-- 1) Org flags + timezone (Central now; compatible with Eastern later)
-- -------------------------------------------------------------------

alter table public.organizations add column if not exists timezone text not null default 'America/Chicago';
alter table public.organizations add column if not exists is_demo boolean not null default false;

-- Ensure the pinned demo org stays permissive by default.
update public.organizations
set is_demo = true,
    timezone = coalesce(nullif(timezone, ''), 'America/Chicago')
where id = '97165bae-19d5-41f6-978c-352876ac108b'::uuid;

-- -------------------------------------------------------------------
-- 2) Row metadata for optimistic concurrency + tombstones
-- -------------------------------------------------------------------

-- version: increments on every update (via triggers below).
-- updated_by: best-effort auth.uid() capture.
-- deleted_at: soft delete marker for sync safety (client can still hard-delete for now).

alter table public.organizations add column if not exists version integer not null default 1;
alter table public.organizations add column if not exists updated_by uuid;
alter table public.organizations add column if not exists deleted_at timestamptz;

alter table public.profiles add column if not exists version integer not null default 1;
alter table public.profiles add column if not exists updated_by uuid;
alter table public.profiles add column if not exists deleted_at timestamptz;

alter table public.product_types add column if not exists version integer not null default 1;
alter table public.product_types add column if not exists updated_by uuid;
alter table public.product_types add column if not exists deleted_at timestamptz;

alter table public.plans add column if not exists version integer not null default 1;
alter table public.plans add column if not exists updated_by uuid;
alter table public.plans add column if not exists deleted_at timestamptz;

alter table public.agencies add column if not exists version integer not null default 1;
alter table public.agencies add column if not exists updated_by uuid;
alter table public.agencies add column if not exists deleted_at timestamptz;

alter table public.communities add column if not exists version integer not null default 1;
alter table public.communities add column if not exists updated_by uuid;
alter table public.communities add column if not exists deleted_at timestamptz;

alter table public.subcontractors add column if not exists version integer not null default 1;
alter table public.subcontractors add column if not exists updated_by uuid;
alter table public.subcontractors add column if not exists deleted_at timestamptz;

alter table public.lots add column if not exists version integer not null default 1;
alter table public.lots add column if not exists updated_by uuid;
alter table public.lots add column if not exists deleted_at timestamptz;

alter table public.tasks add column if not exists version integer not null default 1;
alter table public.tasks add column if not exists updated_by uuid;
alter table public.tasks add column if not exists deleted_at timestamptz;

-- -------------------------------------------------------------------
-- 3) Updated_at + version trigger (replaces updated_at-only triggers)
-- -------------------------------------------------------------------

create or replace function public.touch_row_meta()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  new.version = coalesce(old.version, 0) + 1;
  return new;
end;
$$;

drop trigger if exists trg_organizations_updated_at on public.organizations;
drop trigger if exists trg_profiles_updated_at on public.profiles;
drop trigger if exists trg_product_types_updated_at on public.product_types;
drop trigger if exists trg_plans_updated_at on public.plans;
drop trigger if exists trg_agencies_updated_at on public.agencies;
drop trigger if exists trg_communities_updated_at on public.communities;
drop trigger if exists trg_subcontractors_updated_at on public.subcontractors;
drop trigger if exists trg_lots_updated_at on public.lots;
drop trigger if exists trg_tasks_updated_at on public.tasks;

drop trigger if exists trg_organizations_row_meta on public.organizations;
drop trigger if exists trg_profiles_row_meta on public.profiles;
drop trigger if exists trg_product_types_row_meta on public.product_types;
drop trigger if exists trg_plans_row_meta on public.plans;
drop trigger if exists trg_agencies_row_meta on public.agencies;
drop trigger if exists trg_communities_row_meta on public.communities;
drop trigger if exists trg_subcontractors_row_meta on public.subcontractors;
drop trigger if exists trg_lots_row_meta on public.lots;
drop trigger if exists trg_tasks_row_meta on public.tasks;

create trigger trg_organizations_row_meta before update on public.organizations for each row execute function public.touch_row_meta();
create trigger trg_profiles_row_meta before update on public.profiles for each row execute function public.touch_row_meta();
create trigger trg_product_types_row_meta before update on public.product_types for each row execute function public.touch_row_meta();
create trigger trg_plans_row_meta before update on public.plans for each row execute function public.touch_row_meta();
create trigger trg_agencies_row_meta before update on public.agencies for each row execute function public.touch_row_meta();
create trigger trg_communities_row_meta before update on public.communities for each row execute function public.touch_row_meta();
create trigger trg_subcontractors_row_meta before update on public.subcontractors for each row execute function public.touch_row_meta();
create trigger trg_lots_row_meta before update on public.lots for each row execute function public.touch_row_meta();
create trigger trg_tasks_row_meta before update on public.tasks for each row execute function public.touch_row_meta();

-- -------------------------------------------------------------------
-- 4) Assignment + lock tables (scaffold: demo permissive; prod restrictive)
-- -------------------------------------------------------------------

create table if not exists public.lot_assignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lot_id text not null references public.lots(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'super',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  created_by uuid,
  ended_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1
);

create index if not exists idx_lot_assignments_org_id on public.lot_assignments(org_id);
create index if not exists idx_lot_assignments_lot_id on public.lot_assignments(lot_id);
create index if not exists idx_lot_assignments_profile_id on public.lot_assignments(profile_id);

-- Enforce one active superintendent assignment per lot (future multi-super is possible by changing this).
create unique index if not exists uniq_lot_assignments_primary_super
on public.lot_assignments(lot_id)
where role = 'super' and ended_at is null and deleted_at is null;

drop trigger if exists trg_lot_assignments_updated_at on public.lot_assignments;
drop trigger if exists trg_lot_assignments_row_meta on public.lot_assignments;
create trigger trg_lot_assignments_row_meta before update on public.lot_assignments for each row execute function public.touch_row_meta();

create table if not exists public.lot_locks (
  lot_id text primary key references public.lots(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  locked_by uuid not null references public.profiles(id) on delete cascade,
  token uuid not null default gen_random_uuid(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  version integer not null default 1
);

create index if not exists idx_lot_locks_org_id on public.lot_locks(org_id);
create index if not exists idx_lot_locks_locked_by on public.lot_locks(locked_by);

drop trigger if exists trg_lot_locks_updated_at on public.lot_locks;
drop trigger if exists trg_lot_locks_row_meta on public.lot_locks;
create trigger trg_lot_locks_row_meta before update on public.lot_locks for each row execute function public.touch_row_meta();

-- -------------------------------------------------------------------
-- 5) Append-only collaboration tables (notes + attachment metadata)
-- -------------------------------------------------------------------

create table if not exists public.task_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lot_id text not null references public.lots(id) on delete cascade,
  task_id text not null references public.tasks(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  version integer not null default 1
);

create index if not exists idx_task_notes_org_id on public.task_notes(org_id);
create index if not exists idx_task_notes_lot_id on public.task_notes(lot_id);
create index if not exists idx_task_notes_task_id on public.task_notes(task_id);

drop trigger if exists trg_task_notes_updated_at on public.task_notes;
drop trigger if exists trg_task_notes_row_meta on public.task_notes;
create trigger trg_task_notes_row_meta before update on public.task_notes for each row execute function public.touch_row_meta();

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lot_id text not null references public.lots(id) on delete cascade,
  task_id text references public.tasks(id) on delete set null,
  kind text not null default 'photo',
  category text,
  caption text,
  mime text not null default 'application/octet-stream',
  file_name text not null default '',
  file_size integer not null default 0,
  checksum text,
  storage_bucket text not null default 'buildflow',
  storage_path text,
  thumb_storage_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,
  version integer not null default 1
);

create index if not exists idx_attachments_org_id on public.attachments(org_id);
create index if not exists idx_attachments_lot_id on public.attachments(lot_id);
create index if not exists idx_attachments_task_id on public.attachments(task_id);

drop trigger if exists trg_attachments_updated_at on public.attachments;
drop trigger if exists trg_attachments_row_meta on public.attachments;
create trigger trg_attachments_row_meta before update on public.attachments for each row execute function public.touch_row_meta();

-- -------------------------------------------------------------------
-- 6) Permission helpers (used by RLS + RPC)
-- -------------------------------------------------------------------

create or replace function public.bf_current_profile_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p.role, 'viewer')
  from public.profiles p
  where p.id = auth.uid()
  limit 1
$$;

grant execute on function public.bf_current_profile_role() to authenticated;

create or replace function public.bf_current_org_is_demo()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(o.is_demo, false)
  from public.organizations o
  where o.id = public.current_profile_org_id()
  limit 1
$$;

grant execute on function public.bf_current_org_is_demo() to authenticated;

create or replace function public.bf_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.bf_current_profile_role() = 'admin'
$$;

grant execute on function public.bf_is_admin() to authenticated;

create or replace function public.bf_can_edit_lot(p_lot_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.bf_is_admin()
    or public.bf_current_org_is_demo()
    or exists (
      select 1
      from public.lot_assignments la
      where la.org_id = public.current_profile_org_id()
        and la.lot_id = p_lot_id
        and la.profile_id = auth.uid()
        and la.role = 'super'
        and la.ended_at is null
        and la.deleted_at is null
    )
$$;

grant execute on function public.bf_can_edit_lot(text) to authenticated;

-- -------------------------------------------------------------------
-- 7) RLS for new tables and more enterprise-friendly write policies
-- -------------------------------------------------------------------

alter table public.lot_assignments enable row level security;
alter table public.lot_locks enable row level security;
alter table public.task_notes enable row level security;
alter table public.attachments enable row level security;

-- Drop permissive "all" policies and replace with explicit select/write scopes.
drop policy if exists product_types_all on public.product_types;
drop policy if exists plans_all on public.plans;
drop policy if exists agencies_all on public.agencies;
drop policy if exists communities_all on public.communities;
drop policy if exists subcontractors_all on public.subcontractors;
drop policy if exists lots_all on public.lots;
drop policy if exists tasks_all on public.tasks;

-- Drop replacement policies if they already exist (Postgres has no "create policy if not exists").
drop policy if exists product_types_select on public.product_types;
drop policy if exists product_types_write on public.product_types;
drop policy if exists product_types_update on public.product_types;
drop policy if exists product_types_delete on public.product_types;

drop policy if exists plans_select on public.plans;
drop policy if exists plans_write on public.plans;
drop policy if exists plans_update on public.plans;
drop policy if exists plans_delete on public.plans;

drop policy if exists agencies_select on public.agencies;
drop policy if exists agencies_write on public.agencies;
drop policy if exists agencies_update on public.agencies;
drop policy if exists agencies_delete on public.agencies;

drop policy if exists communities_select on public.communities;
drop policy if exists communities_write on public.communities;
drop policy if exists communities_update on public.communities;
drop policy if exists communities_delete on public.communities;

drop policy if exists subcontractors_select on public.subcontractors;
drop policy if exists subcontractors_write on public.subcontractors;
drop policy if exists subcontractors_update on public.subcontractors;
drop policy if exists subcontractors_delete on public.subcontractors;

drop policy if exists lots_select on public.lots;
drop policy if exists lots_insert on public.lots;
drop policy if exists lots_update on public.lots;
drop policy if exists lots_delete on public.lots;

drop policy if exists tasks_select on public.tasks;
drop policy if exists tasks_insert on public.tasks;
drop policy if exists tasks_update on public.tasks;
drop policy if exists tasks_delete on public.tasks;

drop policy if exists lot_assignments_select on public.lot_assignments;
drop policy if exists lot_assignments_write_admin on public.lot_assignments;

drop policy if exists lot_locks_select on public.lot_locks;
drop policy if exists lot_locks_write on public.lot_locks;

drop policy if exists task_notes_select on public.task_notes;
drop policy if exists task_notes_write on public.task_notes;

drop policy if exists attachments_select on public.attachments;
drop policy if exists attachments_write on public.attachments;

-- product_types (admin-managed, demo permissive)
create policy product_types_select on public.product_types for select to authenticated
using (org_id = public.current_profile_org_id());
create policy product_types_write on public.product_types for insert to authenticated
with check (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));
create policy product_types_update on public.product_types for update to authenticated
using (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()))
with check (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));
create policy product_types_delete on public.product_types for delete to authenticated
using (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));

-- plans (admin-managed, demo permissive)
create policy plans_select on public.plans for select to authenticated
using (org_id = public.current_profile_org_id());
create policy plans_write on public.plans for insert to authenticated
with check (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));
create policy plans_update on public.plans for update to authenticated
using (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()))
with check (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));
create policy plans_delete on public.plans for delete to authenticated
using (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));

-- agencies (admin-managed, demo permissive)
create policy agencies_select on public.agencies for select to authenticated
using (org_id = public.current_profile_org_id());
create policy agencies_write on public.agencies for insert to authenticated
with check (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));
create policy agencies_update on public.agencies for update to authenticated
using (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()))
with check (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));
create policy agencies_delete on public.agencies for delete to authenticated
using (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));

-- communities (admin-managed, demo permissive)
create policy communities_select on public.communities for select to authenticated
using (org_id = public.current_profile_org_id());
create policy communities_write on public.communities for insert to authenticated
with check (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));
create policy communities_update on public.communities for update to authenticated
using (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()))
with check (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));
create policy communities_delete on public.communities for delete to authenticated
using (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));

-- subcontractors (admin-managed, demo permissive)
create policy subcontractors_select on public.subcontractors for select to authenticated
using (org_id = public.current_profile_org_id());
create policy subcontractors_write on public.subcontractors for insert to authenticated
with check (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));
create policy subcontractors_update on public.subcontractors for update to authenticated
using (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()))
with check (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));
create policy subcontractors_delete on public.subcontractors for delete to authenticated
using (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));

-- lots (admins always; assigned super can update their lot; demo permissive)
create policy lots_select on public.lots for select to authenticated
using (org_id = public.current_profile_org_id());
create policy lots_insert on public.lots for insert to authenticated
with check (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));
create policy lots_update on public.lots for update to authenticated
using (org_id = public.current_profile_org_id() and public.bf_can_edit_lot(id))
with check (org_id = public.current_profile_org_id() and public.bf_can_edit_lot(id));
create policy lots_delete on public.lots for delete to authenticated
using (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));

-- tasks (admins always; assigned super can update tasks on their lot; demo permissive)
create policy tasks_select on public.tasks for select to authenticated
using (org_id = public.current_profile_org_id());
create policy tasks_insert on public.tasks for insert to authenticated
with check (org_id = public.current_profile_org_id() and public.bf_can_edit_lot(lot_id));
create policy tasks_update on public.tasks for update to authenticated
using (org_id = public.current_profile_org_id() and public.bf_can_edit_lot(lot_id))
with check (org_id = public.current_profile_org_id() and public.bf_can_edit_lot(lot_id));
create policy tasks_delete on public.tasks for delete to authenticated
using (org_id = public.current_profile_org_id() and public.bf_can_edit_lot(lot_id));

-- lot_assignments (readable to org; write via RPC functions for now)
create policy lot_assignments_select on public.lot_assignments for select to authenticated
using (org_id = public.current_profile_org_id());
create policy lot_assignments_write_admin on public.lot_assignments for all to authenticated
using (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()))
with check (org_id = public.current_profile_org_id() and (public.bf_is_admin() or public.bf_current_org_is_demo()));

-- lot_locks (visible to org; editable only if can edit lot)
create policy lot_locks_select on public.lot_locks for select to authenticated
using (org_id = public.current_profile_org_id());
create policy lot_locks_write on public.lot_locks for all to authenticated
using (org_id = public.current_profile_org_id() and public.bf_can_edit_lot(lot_id))
with check (org_id = public.current_profile_org_id() and public.bf_can_edit_lot(lot_id));

-- task_notes (readable to org; write if can edit lot)
create policy task_notes_select on public.task_notes for select to authenticated
using (org_id = public.current_profile_org_id());
create policy task_notes_write on public.task_notes for all to authenticated
using (org_id = public.current_profile_org_id() and public.bf_can_edit_lot(lot_id))
with check (org_id = public.current_profile_org_id() and public.bf_can_edit_lot(lot_id));

-- attachments (readable to org; write if can edit lot)
create policy attachments_select on public.attachments for select to authenticated
using (org_id = public.current_profile_org_id());
create policy attachments_write on public.attachments for all to authenticated
using (org_id = public.current_profile_org_id() and public.bf_can_edit_lot(lot_id))
with check (org_id = public.current_profile_org_id() and public.bf_can_edit_lot(lot_id));

-- -------------------------------------------------------------------
-- 8) RPC helpers (claim lot + schedule edit locks)
-- -------------------------------------------------------------------

create or replace function public.claim_lot(p_lot_id text)
returns table (lot_id text, profile_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_user_id uuid := auth.uid();
  v_role text := public.bf_current_profile_role();
  v_existing uuid;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if v_role not in ('admin', 'super') then
    raise exception 'Not authorized';
  end if;

  if not exists (select 1 from public.lots l where l.id = p_lot_id and l.org_id = v_org_id) then
    raise exception 'Lot not found';
  end if;

  select la.profile_id
  into v_existing
  from public.lot_assignments la
  where la.org_id = v_org_id
    and la.lot_id = p_lot_id
    and la.role = 'super'
    and la.ended_at is null
    and la.deleted_at is null
  limit 1;

  if v_existing is null then
    insert into public.lot_assignments (org_id, lot_id, profile_id, role, created_by, updated_by)
    values (v_org_id, p_lot_id, v_user_id, 'super', v_user_id, v_user_id);
  elsif v_existing <> v_user_id and v_role <> 'admin' then
    raise exception 'Lot already assigned';
  elsif v_existing <> v_user_id and v_role = 'admin' then
    update public.lot_assignments
    set ended_at = now(), updated_by = v_user_id
    where org_id = v_org_id
      and lot_id = p_lot_id
      and role = 'super'
      and ended_at is null
      and deleted_at is null;

    insert into public.lot_assignments (org_id, lot_id, profile_id, role, created_by, updated_by)
    values (v_org_id, p_lot_id, v_user_id, 'super', v_user_id, v_user_id);
  end if;

  return query select p_lot_id, v_user_id;
end;
$$;

grant execute on function public.claim_lot(text) to authenticated;

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
  delete from public.lot_locks
  where lot_id = p_lot_id
    and org_id = v_org_id
    and expires_at <= v_now;

  select * into v_existing
  from public.lot_locks
  where lot_id = p_lot_id
    and org_id = v_org_id
  limit 1;

  if v_existing is null then
    v_token := gen_random_uuid();
    insert into public.lot_locks (lot_id, org_id, locked_by, token, expires_at, updated_by)
    values (p_lot_id, v_org_id, v_user_id, v_token, v_expires, v_user_id);
    return query select v_token, v_expires, v_user_id;
    return;
  end if;

  if v_existing.locked_by = v_user_id then
    update public.lot_locks
    set expires_at = v_expires, updated_by = v_user_id
    where lot_id = p_lot_id and org_id = v_org_id;
    return query select v_existing.token, v_expires, v_user_id;
    return;
  end if;

  if public.bf_is_admin() then
    v_token := gen_random_uuid();
    update public.lot_locks
    set locked_by = v_user_id, token = v_token, expires_at = v_expires, updated_by = v_user_id
    where lot_id = p_lot_id and org_id = v_org_id;
    return query select v_token, v_expires, v_user_id;
    return;
  end if;

  raise exception 'Lot is locked by another user';
end;
$$;

grant execute on function public.acquire_lot_lock(text, integer) to authenticated;

create or replace function public.release_lot_lock(p_token uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  delete from public.lot_locks
  where token = p_token
    and (locked_by = v_user_id or public.bf_is_admin());
end;
$$;

grant execute on function public.release_lot_lock(uuid) to authenticated;

-- Ensure new tables are accessible to authenticated clients (RLS still enforces rules).
grant select, insert, update, delete on table public.lot_assignments to authenticated;
grant select, insert, update, delete on table public.lot_locks to authenticated;
grant select, insert, update, delete on table public.task_notes to authenticated;
grant select, insert, update, delete on table public.attachments to authenticated;

commit;
