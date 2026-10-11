-- ============================================================================
-- RLS VERIFICATION KIT — todo-students-sync (shvmockjugpstullgpcv)
--
-- Proves the four policies in schema.sql actually isolate users. Nothing here
-- ships to production; run it, read the results, then run section 4 (teardown).
--
-- HOW I RAN IT (the honest version — two gotchas cost me a round each):
--
--   1. Seeding auth.users by hand from SQL is NOT supported by GoTrue, and a
--      half-written row breaks sign-in for the whole project with a misleading
--      `500 unexpected_failure / Database error querying schema`. The four
--      token columns are NOT NULL in this schema and have no default, so they
--      must be written explicitly as '' — otherwise /auth/v1/token 500s.
--   2. `set local role authenticated` + `request.jwt.claims` replicates RLS
--      faithfully *inside SQL* — but private expressions like `auth.uid()`
--      cannot be selected there. For real end-to-end proof you need a REAL
--      GoTrue JWT against PostgREST; that is what section 3 does.
--
-- SECTION 1 + 2 are SQL (psql / MCP execute_sql). SECTION 3 is curl.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- SECTION 1 — seed two throwaway users
-- ---------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
  -- GoTrue reads these as non-null strings; NULL -> "Database error querying schema"
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
) values
  ('11111111-1111-4111-8111-111111111111','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'rls-a@example.com', crypt('Test-RLS-Phase2!', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"phase2_test":true}'::jsonb,
   '', '', '', '', '', '', '', ''),
  ('22222222-2222-4222-8222-222222222222','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'rls-b@example.com', crypt('Test-RLS-Phase2!', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"phase2_test":true}'::jsonb,
   '', '', '', '', '', '', '', '')
on conflict (id) do nothing;

insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
values
  (gen_random_uuid(), '11111111-1111-4111-8111-111111111111',
   '{"sub":"11111111-1111-4111-8111-111111111111","email":"rls-a@example.com","email_verified":true}'::jsonb,
   'email', '11111111-1111-4111-8111-111111111111', now(), now(), now()),
  (gen_random_uuid(), '22222222-2222-4222-8222-222222222222',
   '{"sub":"22222222-2222-4222-8222-222222222222","email":"rls-b@example.com","email_verified":true}'::jsonb,
   'email', '22222222-2222-4222-8222-222222222222', now(), now(), now())
on conflict (provider, provider_id) do nothing;


-- ---------------------------------------------------------------------------
-- SECTION 2 — in-SQL RLS checks (fast, no network)
-- Each statement runs in its own transaction; claims are set locally.
-- ---------------------------------------------------------------------------

-- 2a. A inserts its own row -> 1 row. Expect: a_sees_after = 1
begin;
  select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
  set local role authenticated;
  insert into public.tasks (id, user_id, title, subject, priority, revision)
  values ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','user A own task','maths','high',1);
  select count(*) as a_sees_after from public.tasks;   -- expect 1
commit;

-- 2b. B sees nothing of A's. Expect: 0 | 0
begin;
  select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
  set local role authenticated;
  select count(*) as b_sees_rows,
         count(*) filter (where user_id = '11111111-1111-4111-8111-111111111111') as b_sees_a_row
  from public.tasks;
commit;

-- 2c. B cannot UPDATE or DELETE A's row. Expect: 0 | 0
begin;
  select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
  set local role authenticated;
  with upd as (update public.tasks set title = 'hijacked by B'
               where id = 'aaaaaaaa-0000-4000-8000-000000000001' returning 1),
       del as (delete from public.tasks
               where id = 'aaaaaaaa-0000-4000-8000-000000000001' returning 1)
  select (select count(*) from upd) as b_updated_a_rows,
         (select count(*) from del) as b_deleted_a_rows;
commit;

-- 2d. B cannot INSERT a row stamped with A's user_id.
-- Expect: ERROR 42501 "new row violates row-level security policy for table tasks"
begin;
  select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
  set local role authenticated;  -- role is authenticated, claims say A
  insert into public.tasks (id, user_id, title, revision)
  values ('bbbbbbbb-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','spoofed row for B', 1);
commit;


-- ---------------------------------------------------------------------------
-- SECTION 3 — end-to-end PostgREST checks with a REAL GoTrue JWT
-- (get tokens first; see the curl block at the bottom of this file)
-- Expected, measured on 2026-10-11:
--   A GET  -> 200 [{A's own row}]
--   B GET  -> 200 []
--   B PATCH A's row -> 200 []   (zero rows affected)
--   B DELETE A's row -> 200 []  (zero rows affected)
--   B INSERT as A  -> 403 42501 new row violates row-level security policy
--   A GET unchanged -> 200 [{A's own row, title intact}]
--   A GET ?user_id=eq.B -> 200 []  (query filter cannot reach across RLS)
--   anon GET / POST -> 401 42501 permission denied for table tasks
--
-- curl -s -X POST "$URL/auth/v1/token?grant_type=password" \
--   -H "apikey: $ANON" -H 'Content-Type: application/json' \
--   -d '{"email":"rls-a@example.com","password":"Test-RLS-Phase2!"}'
-- curl -s "$URL/rest/v1/tasks?select=id,title" \
--   -H "apikey: $ANON" -H "Authorization: Bearer $JWT"
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- SECTION 4 — teardown. Drops everything section 1 created, nothing else.
-- (auth.users cascade deletes auth.identities and public.tasks rows.)
-- ---------------------------------------------------------------------------
delete from auth.users where email like 'rls-%@example.com';
select count(*) as leftover_test_users from auth.users where email like 'rls-%@example.com';  -- expect 0
select count(*) as leftover_rows from public.tasks;                                          -- expect 0
