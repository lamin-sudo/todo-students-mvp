import { TaskSchema, type Task } from '../schemas';

/**
 * A row as Postgres/PostgREST actually spells it (snake_case).
 *
 * Why snake_case and not the plan's `dueAt`: Postgres folds unquoted
 * identifiers to lowercase, so a column created as `dueAt` silently becomes
 * `dueat`, and forcing `"dueAt"` would force quoting in every filter and every
 * raw query. There is exactly ONE mapper in each direction (this file) and a
 * test asserts its column list against `supabase/schema.sql`.
 */
export type TaskRow = {
  id: string;
  user_id: string;
  title: string;
  subject: string;
  due_at: string | null;
  priority: string;
  done: boolean;
  done_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
  deleted_at: string | null;
};

/** The exact keys `taskToRow` emits. Asserted against schema.sql in tests. */
export const ROW_COLUMNS = [
  'id',
  'user_id',
  'title',
  'subject',
  'due_at',
  'priority',
  'done',
  'done_at',
  'created_at',
  'updated_at',
  'revision',
  'deleted_at',
] as const;

/**
 * Canonical ISO-8601, always millisecond precision with a `Z`.
 *
 * THIS IS NOT COSMETIC. `isNewer()` in lib/backup.ts compares `updatedAt` as
 * STRINGS, which is correct only while every timestamp has the same shape.
 * Postgres hands back `2026-10-11T22:43:07.637547+00:00`; the client writes
 * `2026-10-11T22:43:07.637Z`. Compared as strings the microsecond form sorts
 * BEFORE the Z form ('5' < 'Z') even though it is 547µs LATER — so a server copy
 * would look older than a client copy and the merge would keep the wrong one.
 * Everything crossing the boundary goes through here.
 *
 * Sub-millisecond precision is dropped; that is acceptable because `revision`
 * is the documented tie-breaker when two writes land in the same millisecond.
 */
export function canonIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** `null` for an empty Postgres timestamp, which arrives as `null`, not `''`. */
function nullableIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' ? canonIso(value) : null;
}

/** Local task -> remote row. `deleted_at` is supplied by the caller (tombstone). */
export function taskToRow(task: Task, userId: string, deletedAt: string | null = null): TaskRow {
  return {
    id: task.id,
    user_id: userId,
    title: task.title,
    subject: task.subject,
    due_at: task.dueAt,
    priority: task.priority,
    done: task.done,
    done_at: task.doneAt,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    revision: task.revision,
    deleted_at: deletedAt,
  };
}

export type ParsedRow = { task: Task; deletedAt: string | null };

/**
 * Remote row -> local task, through the SAME Zod schema the import funnel uses.
 * A malformed or hostile remote row is skipped (returns null) instead of
 * poisoning IndexedDB — the remote is not a trusted source just because it is
 * ours.
 */
export function rowToTask(row: unknown): ParsedRow | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;

  const candidate = {
    id: r.id,
    title: r.title,
    subject: r.subject ?? '',
    dueAt: nullableIso(r.due_at),
    priority: r.priority ?? 'normal',
    done: r.done ?? false,
    doneAt: nullableIso(r.done_at),
    createdAt: nullableIso(r.created_at),
    updatedAt: nullableIso(r.updated_at),
    revision: typeof r.revision === 'number' ? r.revision : 0,
  };

  const parsed = TaskSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return { task: parsed.data, deletedAt: nullableIso(r.deleted_at) };
}
