-- ============================================================================
-- push_tasks — the single write path for sync (Phase 2)
-- Project: todo-students-sync (shvmockjugpstullgpcv). Migration: phase2_push_tasks
--
-- WHY AN RPC INSTEAD OF A PLAIN PostgREST UPSERT
--   `Prefer: resolution=merge-duplicates` has no way to express "only if my copy
--   is newer", so LWW would be settled by request arrival order instead of by
--   `revision`. This function decides it in one atomic statement and REPORTS
--   which rows lost, so the client can pull the winner instead of believing it won.
--
-- WHY `security invoker` (not `definer`)
--   So RLS still applies. The function cannot become a back door that writes
--   rows RLS would otherwise refuse — see the `auth.uid()` guards below.
--
-- TIMESTAMPS
--   `now()` on the SERVER is the ordering authority for every write, including
--   INSERT (the BEFORE UPDATE trigger only covers updates). The client writes
--   back the returned `updated_at` verbatim, which is what stops the push→pull
--   churn loop (client clock vs server clock disagreeing forever).
--
-- IDEMPOTENT: safe to re-run.
--
-- GOTCHA (cost me a 42702 round): RETURNS TABLE(...) declares `id`, `updated_at`,
-- `revision` and `applied` as PL/pgSQL VARIABLES, so every unqualified mention of
-- those names inside the body is ambiguous ("column reference is ambiguous").
-- `#variable_conflict use_column` resolves every ambiguous name to the COLUMN,
-- which is what is wanted in all of them. Do not remove this line.
-- ============================================================================

create or replace function public.push_tasks(batch jsonb)
returns table (id uuid, updated_at timestamptz, revision bigint, applied boolean)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'push_tasks requires an authenticated user' using errcode = '42501';
  end if;

  return query
  with raw as (
    select
      (e->>'id')::uuid                                          as id,
      (e->>'title')::text                                       as title,
      coalesce(e->>'subject', '')::text                         as subject,
      nullif(e->>'due_at', '')::timestamptz                     as due_at,
      coalesce(e->>'priority', 'normal')::text                  as priority,
      coalesce((e->>'done')::boolean, false)                    as done,
      nullif(e->>'done_at', '')::timestamptz                    as done_at,
      nullif(e->>'deleted_at', '')::timestamptz                 as deleted_at,
      greatest(coalesce((e->>'revision')::bigint, 0), 0)        as revision
    from jsonb_array_elements(batch) as e
  ),
  -- A batch must never name the same id twice: ON CONFLICT DO UPDATE refuses to
  -- touch a row twice in one statement ("cannot affect row a second time").
  -- Keeping the highest revision also makes "duplicate id" mean the newest one.
  input as (
    select distinct on (id) * from raw order by id, revision desc
  ),
  ins as (
    insert into public.tasks as t
      (id, user_id, title, subject, due_at, priority, done, done_at,
       created_at, updated_at, revision, deleted_at)
    select i.id, uid, i.title, i.subject, i.due_at, i.priority, i.done, i.done_at,
           now(), now(), i.revision, i.deleted_at
    from input i
    on conflict (id) do update
      set title      = excluded.title,
          subject    = excluded.subject,
          due_at     = excluded.due_at,
          priority   = excluded.priority,
          done       = excluded.done,
          done_at    = excluded.done_at,
          revision   = excluded.revision,
          deleted_at = excluded.deleted_at
          -- updated_at intentionally absent: the BEFORE UPDATE trigger owns it
      -- `t.user_id = uid` is redundant with the RLS USING clause on purpose:
      -- defence in depth if this function is ever re-created as SECURITY DEFINER.
      where t.user_id = uid and t.revision < excluded.revision
    returning t.id, t.updated_at, t.revision
  )
  select i.id,
         coalesce(u.updated_at, c.updated_at) as updated_at,
         coalesce(u.revision, c.revision)     as revision,
         (u.id is not null)                   as applied
  from input i
  left join ins u on u.id = i.id
  -- same-statement snapshot: for a rejected id this is the CURRENT server row,
  -- which is exactly what the client needs to reconcile
  left join public.tasks c on c.id = i.id;
end;
$$;

comment on function public.push_tasks(jsonb) is
  'Atomic LWW upsert. Always stamps the caller''s own auth.uid() as user_id (payload user_id is ignored); returns per-row applied + the server-stamped updated_at/revision.';

-- anon gets nothing: no EXECUTE, no table privileges.
revoke all on function public.push_tasks(jsonb) from public;
revoke all on function public.push_tasks(jsonb) from anon;
grant execute on function public.push_tasks(jsonb) to authenticated;

-- ============================================================================
-- Verification — RUN AGAINST REAL GoTrue JWTs (measured 2026-10-11, not assumed):
--
--  1. A pushes a NEW row, rev 1      -> [{revision:1, applied:true, updated_at stamped}]
--  2. A pushes same row, rev 2       -> [applied:true, updated_at MOVES]      (1s later)
--  3. A pushes same row, rev 1       -> [applied:false, revision:2]  <- server rev
--  4. B pushes A's id, rev 999       -> [applied:false, revision:null]
--     NOTE, and this is the intended behaviour, not a bug: `revision:null` here is
--     RLS working. B cannot see A's row (the `left join public.tasks` yields
--     nothing), so the RPC refuses to leak A's state to B. The contract is
--     `applied:false` => "pull and reconcile"; `revision:null` means "not even
--     visible to you", which only happens across users. It cannot happen within
--     one account (two devices), because both share the same user_id — case 3
--     proves the same-user path returns the real server revision.
--  5. A's row afterwards             -> title still the rev-2 value: NOT hijacked
--  6. same id twice in one batch     -> one row, highest revision (7) wins
--  7. tombstone push, rev 3          -> applied:true, deleted_at set
--  8. anon calls the RPC             -> 401 42501 permission denied for function
-- ============================================================================
