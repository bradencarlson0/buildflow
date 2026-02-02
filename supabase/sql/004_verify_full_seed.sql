-- Verify full local-seed sync in Supabase
select 'organizations' as table_name, count(*) as count from public.organizations
union all select 'profiles', count(*) from public.profiles
union all select 'communities', count(*) from public.communities
union all select 'lots', count(*) from public.lots
union all select 'tasks', count(*) from public.tasks
union all select 'task_dependencies', count(*) from public.task_dependencies
union all select 'subcontractors', count(*) from public.subcontractors
union all select 'product_types', count(*) from public.product_types
union all select 'plans', count(*) from public.plans
union all select 'agencies', count(*) from public.agencies
order by table_name;

select c.id, c.name, c.lot_count
from public.communities c
order by c.id;
