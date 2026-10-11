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
-- ============================================================================

create or replace function public.push_tasks(batch jsonb)
returns table (id uuid, updated_at timestamptz, revision bigint, applied boolean)
language plpgsql
security invoker
set search_path = ''
as $$
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
-- Verification (run against a real GoTrue JWT, not `set local role`):
--   A pushes a new row            -> applied=true, updated_at stamped by now()
--   A pushes it again, rev+1      -> applied=true, updated_at moves
--   A pushes it again, rev-1      -> applied=false, revision = current server rev
--   B pushes A's id with rev+999  -> applied=false (RLS USING + user_id guard)
--   anon calls the RPC            -> 401 / 42501
-- ============================================================================
