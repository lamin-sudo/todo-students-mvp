-- ============================================================================
-- ROLLBACK for supabase/schema.sql (todo-students-sync / shvmockjugpstullgpcv)
--
-- Only run this against the todo-students-sync project. It drops ONLY the
-- objects created by schema.sql — no shared/extension objects, no other table.
-- Data loss: yes, `public.tasks` is dropped. Take an export first if the table
-- holds anything you care about:
--   curl "$URL/rest/v1/tasks?select=*" -H "apikey: $ANON" -H "Authorization: Bearer $JWT"
-- (there is no anon access by design — use an authenticated user's token).
-- ============================================================================

drop trigger if exists tasks_touch_updated_at on public.tasks;
drop function if exists public.touch_updated_at();
drop table if exists public.tasks cascade;

-- pgcrypto is shared infrastructure; left in place on purpose.
