# Phase 2 — Supabase sync (offline-first, magic link)

Project: **todo-students-sync** · ref `shvmockjugpstullgpcv` · region `eu-central-1` (Frankfurt)
Anon key: public by design. **`service_role` never enters the repo, the bundle, or this chat.** RLS is the protection.

Hard rules this phase obeys: touch no other Supabase project · delete no repo/Vercel project · every
SQL statement is written to a file before it is run · every migration is preceded by a `git commit`.

---

## A. SQL schema — `supabase/schema.sql` ✅ APPLIED + VERIFIED

`public.tasks`:

| column | type | notes |
|---|---|---|
| `id` | uuid pk | client-generated UUID v4 (`crypto.randomUUID`), so a task created offline already has its final identity |
| `user_id` | uuid not null, default `auth.uid()` | FK → `auth.users(id)` on delete cascade |
| `title` | text not null | `char_length(btrim(title)) between 1 and 200` (mirrors `TaskSchema`) |
| `subject` | text not null default `''` | ≤ 60 |
| `due_at` | timestamptz null | |
| `priority` | text not null default `'normal'` | `in ('high','medium','normal')` |
| `done` | boolean not null default false | |
| `done_at` | timestamptz null | |
| `created_at` / `updated_at` | timestamptz not null default now() | |
| `revision` | bigint not null default 0 | monotonic client counter, `>= 0` |
| `deleted_at` | timestamptz null | **tombstone — see decision D1** |

RLS: `enable` + `force`, four policies, all `auth.uid() = user_id` — `select`/`delete` on `USING`,
`insert` on `WITH CHECK`, `update` on both. `anon` privileges explicitly revoked (no policy + no grant
= zero access). Trigger `tasks_touch_updated_at` (BEFORE UPDATE, FOR EACH ROW) sets `updated_at = now()`,
function pinned with `set search_path = ''`. Indexes: `(user_id, updated_at desc)`, `(user_id, due_at)`,
`(user_id, done)`.

**Deviation from the plan's column list — deliberate:** the plan wrote camelCase (`dueAt`, `createdAt`).
Postgres folds unquoted identifiers to lowercase, so `dueAt` silently becomes `dueat`; forcing `"dueAt"`
would force quoting in every PostgREST filter and every raw query. SQL uses snake_case, and the client
keeps exactly one mapper each way (`rowToTask` / `taskToRow` in `src/lib/sync.ts`) locked by the Zod
parity test in E.

## B. Auth — magic link

`signInWithOtp({ email, options: { emailRedirectTo } })`; session persisted by supabase-js in
localStorage and refreshed on `onAuthStateChange`. First sign-in runs `bootstrapRemote()`:
count remote rows → **0** ⇒ push every local task (the "I've been using it offline for a month" case);
**> 0** ⇒ pull instead. Idempotent: it is keyed on the remote row count, so re-running changes nothing.
Sign-out clears the session only — **IndexedDB is never wiped on sign-out**.

## C. Sync engine — optimistic, offline-first

* **Local write is the only blocking write.** `create`/`update`/`remove` finish against IndexedDB and
  the UI re-renders; the network call happens later. IndexedDB remains the source of truth.
* **Outbox** (`outbox` store, Dexie v2): `{seq, taskId, op: 'upsert'|'delete', revision, payload, queuedAt,
  attempts, nextAttemptAt, lastError}`. Enqueued only while a session exists, so a signed-out app does not
  accumulate an unbounded queue.
* **Push** = one RPC `push_tasks(batch jsonb)` (**decision D3**), `security invoker`, so RLS still applies:
  `insert ... on conflict (id) do update ... where tasks.user_id = auth.uid() and tasks.revision < excluded.revision`.
  Atomic, and it returns `applied` per id — the client learns "my copy lost" instead of silently believing it won.
* **Backoff**: `nextAttemptAt = now + min(60s, 2^attempts s)`. After 3 failed attempts the op is **parked,
  never dropped** — dropping it is silent data loss. Parked ops show in the banner.
* **Pull delta**: `updated_at > lastSyncAt`, ascending, paged (500/request), tombstone rows included.
  Merged with the *same* comparison the JSON import already uses — `isNewer()` from `lib/backup.ts`
  (`updatedAt` decides, `revision` breaks the tie) — so one rule governs both paths.
* **Flush on hide**: `visibilitychange → hidden` does a best-effort `fetch(..., { keepalive: true })`.
  Not `sendBeacon`: it cannot set an `Authorization` header, so it cannot carry the JWT.
* **The SW never syncs.** Chromium kills it after ~30s idle; a sync engine inside it is a lie.

## D. UI

* **Settings → «المزامنة»**: email input + «صيفط رابط الدخول» → magic-link sent state; signed-in view with
  the user's email, **مفعّلة / غير مفعّلة** (never a silent no-op), last sync time, pending count,
  «زامن دابا» and «خروج».
* **Banner** when offline or `pending > 0`: «غير متزامن — N عملية في الانتظار», with a retry action.
* No sync module is even downloaded while `VITE_SUPABASE_URL` is empty (dynamic `import()`), so the
  offline bundle and the existing 45 tests are untouched.

## E. Tests

* `mergeTasks` + remote-delta merge (LWW, revision tie-break) — pure.
* Tombstone pull removes the local row; a local newer edit survives an older remote copy.
* Outbox: enqueue → drain against a mocked transport; retry increments `attempts`, grows
  `nextAttemptAt`, and never drops a parked op.
* First sign-in: remote empty ⇒ pushes local; remote non-empty ⇒ skips push.
* **Zod parity**: parse the column names out of `supabase/schema.sql` and compare them to the keys
  `taskToRow()` actually sends, round-tripped through `rowToTask()`. Catches "field added in TS,
  migration forgotten" — the one drift that silently loses data.

## F. Decisions that need a yes/no before I write the code

| # | Decision | Why it deviates |
|---|---|---|
| **D1** | `deleted_at` tombstone instead of a hard `DELETE` | A hard delete cannot propagate: the other device either never learns about it, or re-pushes the task it still has. Costs one nullable column + a filter in the pull. **Without it, deletes silently resurrect.** |
| **D2** | snake_case SQL columns + one mapper pair | See A. |
| **D3** | `push_tasks` RPC instead of a bare PostgREST upsert | `resolution=merge-duplicates` cannot express `revision <`, so LWW would be decided by race order instead of `revision`. One `security invoker` function; RLS still the gate. |
| **D4** | **No** server-side `sync_queue` table | The outbox must live where the offline writes live — IndexedDB. A server queue is unreachable exactly when it is needed, doubles the write paths, and adds a second RLS surface. Say the word if you want it anyway; it needs `user_id` + 4 policies + `(user_id, created_at)`. |
| **D5** | import/restore enqueue ops too, not just create/update/remove | An imported task that never reaches the outbox is invisible to sync. Same single choke point (`applyTasks`). |

## Rollback

`supabase/rollback.sql` drops the trigger, the function and `public.tasks` — nothing else.
`supabase/rls-verify.sql` seeds two throwaway users, runs the RLS battery, and tears them down.
