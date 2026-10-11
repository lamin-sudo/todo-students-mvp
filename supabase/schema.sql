-- ============================================================================
-- todo-students-sync — Phase 2 schema (Supabase / Postgres 17)
-- Project ref: shvmockjugpstullgpcv   (eu-central-1, Frankfurt)
--
-- SCOPE RULES (hard):
--   * This file touches ONLY `public.tasks` + its RLS/policies/trigger/indexes.
--   * It must NEVER be run against another project (MELLORA znomcchqodlzgsbayuoo). 
--   * `service_role` is never used by the app; RLS is the only protection.
--   * Idempotent: `create ... if not exists` / `drop policy if exists`, safe to re-run.
--
-- NAMING (deliberate deviation from the plan's camelCase column list):
--   Postgres folds unquoted identifiers to lowercase, so `dueAt` silently
--   becomes `dueat`; forcing `"dueAt"` would make every PostgREST filter and
--   every raw query require quoting. SQL uses snake_case and the client uses
--   one mapper (`rowToTask`/`taskToRow` in src/lib/sync.ts) covered by the
--   Zod parity test.
--
-- ROLLBACK: see supabase/rollback.sql
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. tasks
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id         uuid primary key default gen_random_uuid(),
  -- default auth.uid() so an INSERT that omits user_id lands on the caller's own
  -- row instead of failing RLS on a NULL comparison. The WITH CHECK policy still
  -- rejects an explicit foreign user_id — the default is convenience, not a hole.
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title      text not null check (char_length(btrim(title)) between 1 and 200),
  subject    text not null default '' check (char_length(subject) <= 60),
  due_at     timestamptz,
  priority   text not null default 'normal' check (priority in ('high', 'medium', 'normal')),
  done       boolean not null default false,
  done_at    timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- monotonic client counter; breaks ties when two devices share a timestamp
  revision   bigint not null default 0 check (revision >= 0),
  -- Tombstone. A hard DELETE cannot propagate: the other device either never
  -- learns about it, or re-pushes the task it still has locally. Pull includes
  -- tombstones so deletes converge. (NEW vs the plan — needs @user yes/no.)
  deleted_at timestamptz
);

comment on table public.tasks is
  'Todo rows for todo-students-mvp. Per-user isolated by RLS (auth.uid() = user_id).';

-- ---------------------------------------------------------------------------
-- 2. updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
-- pinned search_path: a trigger is the classic target for search_path attacks
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row
  execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. indexes — one per pull/filter predicate the client actually issues
-- ---------------------------------------------------------------------------
create index if not exists tasks_user_updated_idx on public.tasks (user_id, updated_at desc);
create index if not exists tasks_user_due_idx     on public.tasks (user_id, due_at);
create index if not exists tasks_user_done_idx    on public.tasks (user_id, done);

-- ---------------------------------------------------------------------------
-- 4. RLS — enable, force, and deny by default
-- ---------------------------------------------------------------------------
alter table public.tasks enable row level security;
-- FORCE puts the table OWNER under policies. Verified caveat, measured not
-- assumed: in this project `postgres` and `service_role` carry the BYPASSRLS
-- attribute, and BYPASSRLS wins over FORCE. So FORCE is hygiene, NOT the
-- protection. The protection is (1) anon holds zero privileges and (2) the
-- four `authenticated` policies.
alter table public.tasks force row level security;

-- Explicit grants: `anon` gets nothing at all (no policy + no privilege).
revoke all on table public.tasks from anon;
grant select, insert, update, delete on table public.tasks to authenticated;

-- SELECT / UPDATE / DELETE: USING gates which rows are visible/touchable.
-- INSERT / UPDATE: WITH CHECK gates what may be WRITTEN — without it a user
-- could insert a row stamped with someone else's user_id.
drop policy if exists tasks_select_own on public.tasks;
create policy tasks_select_own on public.tasks
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists tasks_insert_own on public.tasks;
create policy tasks_insert_own on public.tasks
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists tasks_update_own on public.tasks;
create policy tasks_update_own on public.tasks
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists tasks_delete_own on public.tasks;
create policy tasks_delete_own on public.tasks
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 5. NOT created on purpose: server-side `sync_queue`
--    The outbox must live where the offline writes live — IndexedDB. A
--    server-side queue is unreachable exactly when it is needed (offline),
--    doubles the write paths, makes ordering ambiguous (local revision vs
--    row id), and adds a second RLS surface to get wrong. If @user insists,
--    it needs user_id + 4 policies + (user_id, created_at) — say the word.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 6. Verification queries (run manually, expect the stated result)
-- ---------------------------------------------------------------------------
-- select relname, relrowsecurity, relforcerowsecurity
--   from pg_class where relname = 'tasks';            -- t | t
-- select polname, polcmd from pg_policy
--   where polrelid = 'public.tasks'::regclass;        -- 4 rows (r/a/w/d)
-- select grantee, privilege_type from information_schema.role_table_grants
--   where table_name = 'tasks';                       -- anon absent
-- select tgname from pg_trigger where tgrelid = 'public.tasks'::regclass;
