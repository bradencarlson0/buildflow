-- One-time cleanup: remove task dependency rows (BuildFlow demo org)
-- Run in Supabase SQL Editor as role: postgres

delete from public.task_dependencies td
using public.tasks t
where td.task_id = t.id
  and t.org_id = '97165bae-19d5-41f6-978c-352876ac108b'::uuid;
