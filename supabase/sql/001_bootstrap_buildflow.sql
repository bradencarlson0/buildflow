-- BuildFlow clean bootstrap (DESTRUCTIVE for BuildFlow tables only)
-- Run in Supabase SQL Editor as role: postgres
-- Org id pinned to: 97165bae-19d5-41f6-978c-352876ac108b

begin;

create extension if not exists pgcrypto;

-- ---------- cleanup ----------
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user() cascade;
drop function if exists public.current_profile_org_id() cascade;
drop function if exists public.touch_updated_at() cascade;

drop table if exists public.task_dependencies cascade;
drop table if exists public.tasks cascade;
drop table if exists public.lots cascade;
drop table if exists public.communities cascade;
drop table if exists public.subcontractors cascade;
drop table if exists public.plans cascade;
drop table if exists public.product_types cascade;
drop table if exists public.agencies cascade;
drop table if exists public.profiles cascade;
drop table if exists public.organizations cascade;

-- ---------- core tables ----------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  builder_name text not null default '',
  default_build_days integer not null default 120 check (default_build_days > 0),
  work_days integer[] not null default array[1,2,3,4,5],
  holidays text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete restrict,
  role text not null default 'admin',
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.product_types (
  id text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  build_days integer not null default 120 check (build_days > 0),
  template_id text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.plans (
  id text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  product_type_id text references public.product_types(id) on delete set null,
  sq_ft numeric,
  bedrooms numeric,
  bathrooms numeric,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.agencies (
  id text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  type text not null default 'municipality',
  inspection_types text[] not null default '{}'::text[],
  is_org_level boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.communities (
  id text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  address jsonb not null default '{}'::jsonb,
  product_type_ids text[] not null default '{}'::text[],
  lot_count integer not null default 0,
  lots_by_product_type jsonb not null default '{}'::jsonb,
  builders jsonb not null default '[]'::jsonb,
  realtors jsonb not null default '[]'::jsonb,
  inspectors jsonb not null default '[]'::jsonb,
  agency_ids text[] not null default '{}'::text[],
  agencies jsonb not null default '[]'::jsonb,
  documents jsonb not null default '[]'::jsonb,
  specs jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subcontractors (
  id text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null default 'Subcontractor',
  company_name text not null default '',
  trade text not null default 'other',
  secondary_trades text[] not null default '{}'::text[],
  phone text,
  email text,
  office_phone text,
  primary_contact jsonb not null default '{}'::jsonb,
  additional_contacts jsonb not null default '[]'::jsonb,
  insurance_expiration date,
  license_number text,
  w9_on_file boolean not null default false,
  crew_size integer,
  max_concurrent_lots integer not null default 1,
  is_preferred boolean not null default true,
  is_backup boolean not null default false,
  rating numeric(4,2),
  total_jobs integer not null default 0,
  on_time_pct numeric(5,2),
  delay_count integer not null default 0,
  blackout_dates text[] not null default '{}'::text[],
  notes text,
  status text not null default 'active',
  documents jsonb not null default '[]'::jsonb,
  custom_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.lots (
  id text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  community_id text not null references public.communities(id) on delete cascade,
  block text not null default '',
  lot_number text not null,
  product_type_id text references public.product_types(id) on delete set null,
  plan_id text references public.plans(id) on delete set null,
  builder_id text,
  address text not null default '',
  job_number text not null default '',
  permit_number text,
  model_type text not null default '',
  status text not null default 'not_started',
  start_date date,
  hard_deadline date,
  build_days integer not null default 120 check (build_days > 0),
  target_completion_date date,
  actual_completion_date date,
  sold_status text not null default 'available',
  sold_date date,
  custom_fields jsonb not null default '{}'::jsonb,
  inspections jsonb not null default '[]'::jsonb,
  punch_list jsonb,
  daily_logs jsonb not null default '[]'::jsonb,
  change_orders jsonb not null default '[]'::jsonb,
  material_orders jsonb not null default '[]'::jsonb,
  documents jsonb not null default '[]'::jsonb,
  photos jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tasks (
  id text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  lot_id text not null references public.lots(id) on delete cascade,
  name text not null,
  trade text not null default 'other',
  track text not null default 'foundation',
  phase text not null default 'foundation',
  duration integer not null default 1 check (duration > 0),
  sort_order integer not null default 0,
  status text not null default 'not_started',
  scheduled_start text,
  scheduled_end text,
  actual_start text,
  actual_end text,
  sub_id text references public.subcontractors(id) on delete set null,
  notes text,
  delay_reason text,
  delay_days integer not null default 0,
  dependencies jsonb not null default '[]'::jsonb,
  custom_fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.task_dependencies (
  id bigserial primary key,
  task_id text not null references public.tasks(id) on delete cascade,
  depends_on_task_id text not null references public.tasks(id) on delete cascade,
  type text not null default 'FS',
  lag_days integer not null default 0,
  created_at timestamptz not null default now(),
  unique (task_id, depends_on_task_id, type, lag_days)
);

-- ---------- indexes ----------
create index idx_profiles_org_id on public.profiles(org_id);
create index idx_product_types_org_id on public.product_types(org_id);
create index idx_plans_org_id on public.plans(org_id);
create index idx_agencies_org_id on public.agencies(org_id);
create index idx_communities_org_id on public.communities(org_id);
create index idx_subcontractors_org_id on public.subcontractors(org_id);
create index idx_lots_org_id on public.lots(org_id);
create index idx_lots_community_id on public.lots(community_id);
create index idx_tasks_org_id on public.tasks(org_id);
create index idx_tasks_lot_id on public.tasks(lot_id);
create index idx_task_dependencies_task_id on public.task_dependencies(task_id);

-- ---------- updated_at trigger ----------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_organizations_updated_at before update on public.organizations for each row execute function public.touch_updated_at();
create trigger trg_profiles_updated_at before update on public.profiles for each row execute function public.touch_updated_at();
create trigger trg_product_types_updated_at before update on public.product_types for each row execute function public.touch_updated_at();
create trigger trg_plans_updated_at before update on public.plans for each row execute function public.touch_updated_at();
create trigger trg_agencies_updated_at before update on public.agencies for each row execute function public.touch_updated_at();
create trigger trg_communities_updated_at before update on public.communities for each row execute function public.touch_updated_at();
create trigger trg_subcontractors_updated_at before update on public.subcontractors for each row execute function public.touch_updated_at();
create trigger trg_lots_updated_at before update on public.lots for each row execute function public.touch_updated_at();
create trigger trg_tasks_updated_at before update on public.tasks for each row execute function public.touch_updated_at();

-- ---------- auth helpers ----------
create or replace function public.current_profile_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.org_id
  from public.profiles p
  where p.id = auth.uid()
  limit 1
$$;

grant execute on function public.current_profile_org_id() to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, org_id, role, display_name)
  values (
    new.id,
    '97165bae-19d5-41f6-978c-352876ac108b'::uuid,
    'admin',
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------- RLS ----------
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.product_types enable row level security;
alter table public.plans enable row level security;
alter table public.agencies enable row level security;
alter table public.communities enable row level security;
alter table public.subcontractors enable row level security;
alter table public.lots enable row level security;
alter table public.tasks enable row level security;
alter table public.task_dependencies enable row level security;

-- profiles (no recursion)
create policy profiles_select_self on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_insert_self on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update_self on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- organizations
create policy organizations_select on public.organizations for select to authenticated using (id = public.current_profile_org_id());
create policy organizations_update on public.organizations for update to authenticated using (id = public.current_profile_org_id()) with check (id = public.current_profile_org_id());

-- org-scoped tables
create policy product_types_all on public.product_types for all to authenticated
using (org_id = public.current_profile_org_id())
with check (org_id = public.current_profile_org_id());

create policy plans_all on public.plans for all to authenticated
using (org_id = public.current_profile_org_id())
with check (org_id = public.current_profile_org_id());

create policy agencies_all on public.agencies for all to authenticated
using (org_id = public.current_profile_org_id())
with check (org_id = public.current_profile_org_id());

create policy communities_all on public.communities for all to authenticated
using (org_id = public.current_profile_org_id())
with check (org_id = public.current_profile_org_id());

create policy subcontractors_all on public.subcontractors for all to authenticated
using (org_id = public.current_profile_org_id())
with check (org_id = public.current_profile_org_id());

create policy lots_all on public.lots for all to authenticated
using (org_id = public.current_profile_org_id())
with check (org_id = public.current_profile_org_id());

create policy tasks_all on public.tasks for all to authenticated
using (org_id = public.current_profile_org_id())
with check (org_id = public.current_profile_org_id());

create policy task_dependencies_all on public.task_dependencies for all to authenticated
using (
  exists (
    select 1
    from public.tasks t
    where t.id = public.task_dependencies.task_id
      and t.org_id = public.current_profile_org_id()
  )
)
with check (
  exists (
    select 1
    from public.tasks t
    where t.id = public.task_dependencies.task_id
      and t.org_id = public.current_profile_org_id()
  )
);

-- ---------- seed ----------
insert into public.organizations (id, name, builder_name, default_build_days, work_days, holidays)
values (
  '97165bae-19d5-41f6-978c-352876ac108b',
  'BuildFlow',
  'BC Land',
  120,
  array[1,2,3,4,5],
  '{}'::text[]
)
on conflict (id) do update
set
  name = excluded.name,
  builder_name = excluded.builder_name,
  default_build_days = excluded.default_build_days,
  work_days = excluded.work_days;

-- map all existing auth users into this org as admin (greenfield convenience)
insert into public.profiles (id, org_id, role, display_name)
select
  u.id,
  '97165bae-19d5-41f6-978c-352876ac108b'::uuid,
  'admin',
  coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1))
from auth.users u
on conflict (id) do update
set
  org_id = excluded.org_id,
  role = excluded.role,
  display_name = excluded.display_name,
  updated_at = now();

insert into public.product_types (id, org_id, name, build_days, template_id, sort_order, is_active)
values
  ('pt-cottage',  '97165bae-19d5-41f6-978c-352876ac108b', 'Cottage', 115, 'template-cottage-115', 1, true),
  ('pt-rancher',  '97165bae-19d5-41f6-978c-352876ac108b', 'Rancher', 130, 'template-rancher-130', 2, true),
  ('pt-townhome', '97165bae-19d5-41f6-978c-352876ac108b', 'Townhome',145, 'template-townhome-145',3, true)
on conflict (id) do update
set
  name = excluded.name,
  build_days = excluded.build_days,
  template_id = excluded.template_id,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;

insert into public.plans (id, org_id, name, product_type_id, sq_ft, bedrooms, bathrooms, is_active)
values
  ('plan-oak',    '97165bae-19d5-41f6-978c-352876ac108b', 'The Oak',    'pt-cottage', 1400, 2, 2, true),
  ('plan-cedar',  '97165bae-19d5-41f6-978c-352876ac108b', 'The Cedar',  'pt-rancher', 1800, 3, 2, true),
  ('plan-birch',  '97165bae-19d5-41f6-978c-352876ac108b', 'The Birch',  'pt-townhome',2000, 4, 3, true)
on conflict (id) do update
set
  name = excluded.name,
  product_type_id = excluded.product_type_id,
  sq_ft = excluded.sq_ft,
  bedrooms = excluded.bedrooms,
  bathrooms = excluded.bathrooms,
  is_active = excluded.is_active;

insert into public.agencies (id, org_id, name, type, inspection_types, is_org_level, is_active)
values
  ('agency-dallas', '97165bae-19d5-41f6-978c-352876ac108b', 'City of Dallas', 'municipality', array['PRE','FND','FRM','RME','INS','FIN','COO'], true, true)
on conflict (id) do update
set
  name = excluded.name,
  type = excluded.type,
  inspection_types = excluded.inspection_types,
  is_org_level = excluded.is_org_level,
  is_active = excluded.is_active;

insert into public.communities (
  id, org_id, name, address, product_type_ids, lot_count, lots_by_product_type,
  builders, realtors, inspectors, agency_ids, agencies, documents, specs, is_active
)
values (
  'comm-grove',
  '97165bae-19d5-41f6-978c-352876ac108b',
  'The Grove',
  '{"street":"1234 Oak Valley Road","city":"Dallas","state":"TX","zip":"75001"}'::jsonb,
  array['pt-cottage','pt-rancher','pt-townhome'],
  1,
  '{"pt-cottage":[1],"pt-rancher":[],"pt-townhome":[]}'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  array['agency-dallas'],
  '[]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  true
)
on conflict (id) do update
set
  name = excluded.name,
  address = excluded.address,
  product_type_ids = excluded.product_type_ids,
  lot_count = excluded.lot_count,
  lots_by_product_type = excluded.lots_by_product_type,
  agency_ids = excluded.agency_ids,
  is_active = excluded.is_active;

insert into public.subcontractors (
  id, org_id, name, company_name, trade, secondary_trades, phone, email, office_phone,
  primary_contact, additional_contacts, max_concurrent_lots, is_preferred, is_backup,
  total_jobs, delay_count, notes, status
)
values
  (
    'sub-concrete',
    '97165bae-19d5-41f6-978c-352876ac108b',
    'AG Construction',
    'AG Construction',
    'concrete',
    '{}'::text[],
    '470-585-0495',
    'ag@example.com',
    '470-585-0495',
    '{"name":"Jorge","phone":"470-585-0495","email":"ag@example.com"}'::jsonb,
    '[]'::jsonb,
    1, true, false, 0, 0, 'Foundation crew', 'active'
  ),
  (
    'sub-plumbing',
    '97165bae-19d5-41f6-978c-352876ac108b',
    'Bama Gas',
    'Bama Gas',
    'plumbing',
    '{}'::text[],
    '555-1200',
    'plumbing@example.com',
    '555-1200',
    '{"name":"Plumbing PM","phone":"555-1200","email":"plumbing@example.com"}'::jsonb,
    '[]'::jsonb,
    1, true, false, 0, 0, 'Plumbing crew', 'active'
  ),
  (
    'sub-electrical',
    '97165bae-19d5-41f6-978c-352876ac108b',
    'Mullins',
    'Mullins',
    'electrical',
    '{}'::text[],
    '555-1300',
    'electrical@example.com',
    '555-1300',
    '{"name":"Electrical PM","phone":"555-1300","email":"electrical@example.com"}'::jsonb,
    '[]'::jsonb,
    1, true, false, 0, 0, 'Electrical crew', 'active'
  ),
  (
    'sub-framing',
    '97165bae-19d5-41f6-978c-352876ac108b',
    'Madison Lawnscapes',
    'Madison Lawnscapes',
    'framing',
    '{}'::text[],
    '555-1400',
    'framing@example.com',
    '555-1400',
    '{"name":"Framing PM","phone":"555-1400","email":"framing@example.com"}'::jsonb,
    '[]'::jsonb,
    1, true, false, 0, 0, 'Framing crew', 'active'
  )
on conflict (id) do update
set
  name = excluded.name,
  company_name = excluded.company_name,
  trade = excluded.trade,
  phone = excluded.phone,
  email = excluded.email,
  office_phone = excluded.office_phone,
  primary_contact = excluded.primary_contact,
  notes = excluded.notes,
  status = excluded.status,
  updated_at = now();

insert into public.lots (
  id, org_id, community_id, block, lot_number, product_type_id, plan_id, builder_id,
  address, job_number, permit_number, model_type, status, start_date, hard_deadline,
  build_days, target_completion_date, actual_completion_date, sold_status, sold_date,
  custom_fields, inspections, punch_list, daily_logs, change_orders, material_orders, documents, photos
)
values (
  'lot-grove-1',
  '97165bae-19d5-41f6-978c-352876ac108b',
  'comm-grove',
  '',
  '1',
  'pt-cottage',
  'plan-oak',
  null,
  '',
  '',
  null,
  '',
  'in_progress',
  current_date,
  null,
  115,
  null,
  null,
  'available',
  null,
  '{}'::jsonb,
  '[]'::jsonb,
  null,
  '[]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb
)
on conflict (id) do update
set
  community_id = excluded.community_id,
  lot_number = excluded.lot_number,
  product_type_id = excluded.product_type_id,
  plan_id = excluded.plan_id,
  status = excluded.status,
  build_days = excluded.build_days,
  updated_at = now();

insert into public.tasks (
  id, org_id, lot_id, name, trade, track, phase, duration, sort_order, status,
  scheduled_start, scheduled_end, sub_id, notes, delay_reason, delay_days, dependencies, custom_fields
)
values
  (
    'task-001',
    '97165bae-19d5-41f6-978c-352876ac108b',
    'lot-grove-1',
    'Form / Gravel Deliver',
    'concrete',
    'foundation',
    'foundation',
    2,
    1,
    'not_started',
    to_char(current_date, 'YYYY-MM-DD'),
    to_char(current_date + interval '1 day', 'YYYY-MM-DD'),
    'sub-concrete',
    null, null, 0, '[]'::jsonb, '{}'::jsonb
  ),
  (
    'task-002',
    '97165bae-19d5-41f6-978c-352876ac108b',
    'lot-grove-1',
    'Plumbing Slab',
    'plumbing',
    'foundation',
    'foundation',
    2,
    2,
    'not_started',
    to_char(current_date + interval '2 day', 'YYYY-MM-DD'),
    to_char(current_date + interval '3 day', 'YYYY-MM-DD'),
    'sub-plumbing',
    null, null, 0, '[]'::jsonb, '{}'::jsonb
  ),
  (
    'task-003',
    '97165bae-19d5-41f6-978c-352876ac108b',
    'lot-grove-1',
    'Slab Inspection',
    'concrete',
    'foundation',
    'foundation',
    1,
    3,
    'not_started',
    to_char(current_date + interval '4 day', 'YYYY-MM-DD'),
    to_char(current_date + interval '4 day', 'YYYY-MM-DD'),
    'sub-concrete',
    null, null, 0, '[]'::jsonb, '{}'::jsonb
  ),
  (
    'task-004',
    '97165bae-19d5-41f6-978c-352876ac108b',
    'lot-grove-1',
    'Frame',
    'framing',
    'structure',
    'structure',
    5,
    4,
    'not_started',
    to_char(current_date + interval '5 day', 'YYYY-MM-DD'),
    to_char(current_date + interval '9 day', 'YYYY-MM-DD'),
    'sub-framing',
    null, null, 0, '[]'::jsonb, '{}'::jsonb
  ),
  (
    'task-005',
    '97165bae-19d5-41f6-978c-352876ac108b',
    'lot-grove-1',
    'Rough Electrical',
    'electrical',
    'interior',
    'mechanical',
    2,
    5,
    'not_started',
    to_char(current_date + interval '10 day', 'YYYY-MM-DD'),
    to_char(current_date + interval '11 day', 'YYYY-MM-DD'),
    'sub-electrical',
    null, null, 0, '[]'::jsonb, '{}'::jsonb
  )
on conflict (id) do update
set
  lot_id = excluded.lot_id,
  name = excluded.name,
  trade = excluded.trade,
  track = excluded.track,
  phase = excluded.phase,
  duration = excluded.duration,
  sort_order = excluded.sort_order,
  status = excluded.status,
  scheduled_start = excluded.scheduled_start,
  scheduled_end = excluded.scheduled_end,
  sub_id = excluded.sub_id,
  updated_at = now();

insert into public.task_dependencies (task_id, depends_on_task_id, type, lag_days)
values
  ('task-002', 'task-001', 'FS', 0),
  ('task-003', 'task-002', 'FS', 0),
  ('task-004', 'task-003', 'FS', 0),
  ('task-005', 'task-004', 'FS', 0)
on conflict do nothing;

-- optional grants (RLS still enforces tenancy)
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

commit;
