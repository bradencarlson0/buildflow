import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createSeedState } from '../src/data/seed.js'

const ORG_ID = process.env.BUILDFLOW_ORG_ID || '97165bae-19d5-41f6-978c-352876ac108b'

const esc = (value) => String(value).replace(/'/g, "''")
const str = (value) => (value == null ? 'null' : `'${esc(value)}'`)
const num = (value) => {
  if (value == null || value === '') return 'null'
  const n = Number(value)
  return Number.isFinite(n) ? String(n) : 'null'
}
const bool = (value) => (value == null ? 'null' : value ? 'true' : 'false')
const intArray = (value) => {
  const list = Array.isArray(value) ? value : []
  if (list.length === 0) return "'{}'::integer[]"
  return `array[${list.map((item) => num(item)).join(', ')}]::integer[]`
}
const textArray = (value) => {
  const list = Array.isArray(value) ? value : []
  if (list.length === 0) return "'{}'::text[]"
  return `array[${list.map((item) => str(item)).join(', ')}]::text[]`
}
const jsonb = (value) => {
  const v = value == null ? null : JSON.stringify(value)
  return v == null ? 'null' : `'${esc(v)}'::jsonb`
}

const valuesBlock = (rows) => rows.map((row) => `  (${row.join(', ')})`).join(',\n')

const seed = createSeedState()

const productTypesRows = (seed.product_types ?? []).map((pt) => [
  str(pt.id),
  str(ORG_ID),
  str(pt.name),
  num(pt.build_days),
  str(pt.template_id ?? null),
  num(pt.sort_order ?? 0),
  bool(pt.is_active ?? true),
])

const plansRows = (seed.plans ?? []).map((plan) => [
  str(plan.id),
  str(ORG_ID),
  str(plan.name),
  str(plan.product_type_id ?? null),
  num(plan.sq_ft ?? null),
  num(plan.bedrooms ?? null),
  num(plan.bathrooms ?? null),
  bool(plan.is_active ?? true),
])

const agenciesRows = (seed.agencies ?? []).map((agency) => [
  str(agency.id),
  str(ORG_ID),
  str(agency.name),
  str(agency.type ?? 'municipality'),
  textArray(agency.inspection_types),
  bool(agency.is_org_level ?? true),
  bool(agency.is_active ?? true),
])

const communitiesRows = (seed.communities ?? []).map((community) => [
  str(community.id),
  str(ORG_ID),
  str(community.name),
  jsonb(community.address ?? {}),
  textArray(community.product_type_ids),
  num(community.lot_count ?? 0),
  jsonb(community.lots_by_product_type ?? {}),
  jsonb(community.builders ?? []),
  jsonb(community.realtors ?? []),
  jsonb(community.inspectors ?? []),
  textArray(community.agency_ids),
  jsonb(community.agencies ?? []),
  jsonb(community.documents ?? []),
  jsonb(community.specs ?? []),
  bool(community.is_active ?? true),
])

const subcontractorRows = (seed.subcontractors ?? []).map((sub) => [
  str(sub.id),
  str(ORG_ID),
  str(sub.name ?? sub.company_name ?? 'Subcontractor'),
  str(sub.company_name ?? sub.name ?? 'Subcontractor'),
  str(sub.trade ?? 'other'),
  textArray(sub.secondary_trades),
  str(sub.phone ?? sub.primary_contact?.phone ?? null),
  str(sub.email ?? sub.primary_contact?.email ?? null),
  str(sub.office_phone ?? sub.phone ?? sub.primary_contact?.phone ?? null),
  jsonb(sub.primary_contact ?? {}),
  jsonb(sub.additional_contacts ?? []),
  str(sub.insurance_expiration ?? null),
  str(sub.license_number ?? null),
  bool(sub.w9_on_file ?? false),
  num(sub.crew_size ?? null),
  num(sub.max_concurrent_lots ?? 1),
  bool(sub.is_preferred ?? true),
  bool(sub.is_backup ?? false),
  num(sub.rating ?? null),
  num(sub.total_jobs ?? 0),
  num(sub.on_time_pct ?? null),
  num(sub.delay_count ?? 0),
  textArray(sub.blackout_dates),
  str(sub.notes ?? null),
  str(sub.status ?? 'active'),
  jsonb(sub.documents ?? []),
  jsonb(sub.custom_fields ?? {}),
])

const lotsRows = (seed.lots ?? []).map((lot) => [
  str(lot.id),
  str(ORG_ID),
  str(lot.community_id),
  str(lot.block ?? ''),
  str(lot.lot_number ?? ''),
  str(lot.product_type_id ?? null),
  str(lot.plan_id ?? null),
  str(lot.builder_id ?? null),
  str(lot.address ?? ''),
  str(lot.job_number ?? ''),
  str(lot.permit_number ?? null),
  str(lot.model_type ?? ''),
  str(lot.status ?? 'not_started'),
  str(lot.start_date ?? null),
  str(lot.hard_deadline ?? null),
  num(lot.build_days ?? 120),
  str(lot.target_completion_date ?? null),
  str(lot.actual_completion_date ?? null),
  str(lot.sold_status ?? 'available'),
  str(lot.sold_date ?? null),
  jsonb(lot.custom_fields ?? {}),
  jsonb(lot.inspections ?? []),
  jsonb(lot.punch_list ?? null),
  jsonb(lot.daily_logs ?? []),
  jsonb(lot.change_orders ?? []),
  jsonb(lot.material_orders ?? []),
  jsonb(lot.documents ?? []),
  jsonb(lot.photos ?? []),
])

const taskRows = (seed.lots ?? []).flatMap((lot) =>
  (lot.tasks ?? []).map((task) => [
    str(task.id),
    str(ORG_ID),
    str(lot.id),
    str(task.name ?? 'Task'),
    str(task.trade ?? 'other'),
    str(task.track ?? 'foundation'),
    str(task.phase ?? 'foundation'),
    num(task.duration ?? 1),
    num(task.sort_order ?? 0),
    str(task.status ?? 'not_started'),
    str(task.scheduled_start ?? null),
    str(task.scheduled_end ?? null),
    str(task.actual_start ?? null),
    str(task.actual_end ?? null),
    str(task.sub_id ?? null),
    str(task.notes ?? null),
    str(task.delay_reason ?? null),
    num(task.delay_days ?? 0),
    jsonb(task.dependencies ?? []),
    jsonb(task.custom_fields ?? {}),
  ]),
)

const taskDepRows = (seed.lots ?? []).flatMap((lot) =>
  (lot.tasks ?? []).flatMap((task) =>
    (task.dependencies ?? [])
      .filter((dep) => dep?.depends_on_task_id)
      .map((dep) => [
        str(task.id),
        str(dep.depends_on_task_id),
        str(dep.type ?? 'FS'),
        num(dep.lag_days ?? 0),
      ]),
  ),
)

const org = seed.org ?? {}
const holidays = Array.isArray(org.holidays)
  ? org.holidays.map((h) => (typeof h === 'string' ? h : h?.date)).filter(Boolean)
  : []

const sql = `-- Seed Supabase from local BuildFlow seed state
-- Generated by scripts/generate-supabase-seed-from-local.mjs
-- Org: ${ORG_ID}

begin;

insert into public.organizations (id, name, builder_name, default_build_days, work_days, holidays)
values (
  ${str(ORG_ID)},
  ${str(org.name ?? 'BuildFlow')},
  ${str(org.builder_name ?? org.name ?? 'BuildFlow')},
  ${num(org.default_build_days ?? 120)},
  ${intArray(org.work_days ?? [1, 2, 3, 4, 5])},
  ${textArray(holidays)}
)
on conflict (id) do update
set
  name = excluded.name,
  builder_name = excluded.builder_name,
  default_build_days = excluded.default_build_days,
  work_days = excluded.work_days,
  holidays = excluded.holidays,
  updated_at = now();

-- assign existing users in this project to the org
insert into public.profiles (id, org_id, role, display_name)
select
  u.id,
  ${str(ORG_ID)}::uuid,
  'admin',
  coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1))
from auth.users u
on conflict (id) do update
set
  org_id = excluded.org_id,
  role = excluded.role,
  display_name = excluded.display_name,
  updated_at = now();

-- replace org-scoped data with local seed baseline
delete from public.task_dependencies
where exists (select 1 from public.tasks t where t.id = task_dependencies.task_id and t.org_id = ${str(ORG_ID)}::uuid);

delete from public.tasks where org_id = ${str(ORG_ID)}::uuid;
delete from public.lots where org_id = ${str(ORG_ID)}::uuid;
delete from public.communities where org_id = ${str(ORG_ID)}::uuid;
delete from public.subcontractors where org_id = ${str(ORG_ID)}::uuid;
delete from public.plans where org_id = ${str(ORG_ID)}::uuid;
delete from public.product_types where org_id = ${str(ORG_ID)}::uuid;
delete from public.agencies where org_id = ${str(ORG_ID)}::uuid;

insert into public.product_types (id, org_id, name, build_days, template_id, sort_order, is_active)
values
${valuesBlock(productTypesRows)};

insert into public.plans (id, org_id, name, product_type_id, sq_ft, bedrooms, bathrooms, is_active)
values
${valuesBlock(plansRows)};

insert into public.agencies (id, org_id, name, type, inspection_types, is_org_level, is_active)
values
${valuesBlock(agenciesRows)};

insert into public.communities (
  id, org_id, name, address, product_type_ids, lot_count, lots_by_product_type,
  builders, realtors, inspectors, agency_ids, agencies, documents, specs, is_active
)
values
${valuesBlock(communitiesRows)};

insert into public.subcontractors (
  id, org_id, name, company_name, trade, secondary_trades, phone, email, office_phone,
  primary_contact, additional_contacts, insurance_expiration, license_number, w9_on_file, crew_size,
  max_concurrent_lots, is_preferred, is_backup, rating, total_jobs, on_time_pct, delay_count,
  blackout_dates, notes, status, documents, custom_fields
)
values
${valuesBlock(subcontractorRows)};

insert into public.lots (
  id, org_id, community_id, block, lot_number, product_type_id, plan_id, builder_id,
  address, job_number, permit_number, model_type, status, start_date, hard_deadline,
  build_days, target_completion_date, actual_completion_date, sold_status, sold_date,
  custom_fields, inspections, punch_list, daily_logs, change_orders, material_orders, documents, photos
)
values
${valuesBlock(lotsRows)};

${taskRows.length > 0 ? `insert into public.tasks (
  id, org_id, lot_id, name, trade, track, phase, duration, sort_order, status,
  scheduled_start, scheduled_end, actual_start, actual_end, sub_id, notes, delay_reason,
  delay_days, dependencies, custom_fields
)
values
${valuesBlock(taskRows)};
` : '-- seed has no task rows (tasks are generated when lots are started)'}

${taskDepRows.length > 0 ? `insert into public.task_dependencies (task_id, depends_on_task_id, type, lag_days)
values
${valuesBlock(taskDepRows)};` : '-- seed has no task dependency rows'}

commit;
`

const outPath = resolve('supabase/sql/003_seed_from_local_seedstate.sql')
await writeFile(outPath, sql, 'utf8')
console.log(`Generated ${outPath}`)
console.log(`Counts: product_types=${productTypesRows.length}, plans=${plansRows.length}, agencies=${agenciesRows.length}, communities=${communitiesRows.length}, subs=${subcontractorRows.length}, lots=${lotsRows.length}, tasks=${taskRows.length}, deps=${taskDepRows.length}`)
