import { z } from 'zod';

/**
 * Every task — whether it comes from a form, an imported JSON file, or the
 * internal `backups` store — MUST pass this schema. `.strict()` rejects
 * unknown keys so a tampered/foreign file cannot smuggle extra fields into
 * IndexedDB.
 */
export const PrioritySchema = z.enum(['high', 'medium', 'normal']);
export type Priority = z.infer<typeof PrioritySchema>;

/** An ISO-8601 timestamp (with offset or Z). */
export const IsoDateTime = z.string().datetime({ offset: true });

/** ISO-8601 string, or null when no due date is set. */
const IsoDate = IsoDateTime.nullable();

export const TaskSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    subject: z.string().trim().max(60).default(''),
    dueAt: IsoDate.default(null),
    priority: PrioritySchema.default('normal'),
    done: z.boolean().default(false),
    doneAt: IsoDate.default(null),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    /** monotonic counter, breaks ties when two devices share a timestamp */
    revision: z.number().int().nonnegative().default(0),
  })
  .strict();

export type Task = z.infer<typeof TaskSchema>;

/**
 * What a caller may hand in when creating a task: only `title` is mandatory,
 * everything else is filled in by `newTask()`. Optional/due-less fields accept
 * `undefined` so forms can pass partial state directly.
 */
export type TaskInput = Partial<Omit<Task, 'title'>> & { title: string };

/** What the *form* collects — the data layer fills the rest in. */
export const TaskDraftSchema = z
  .object({
    title: z.string().trim().min(1, 'العنوان خاصو ما يكونش خاوي').max(200, 'العنوان طويل بزاف'),
    subject: z.string().trim().max(60).optional(),
    /** `datetime-local` value (no timezone) or '' */
    dueAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, 'تاريخ غير صالح')
      .or(z.literal(''))
      .optional(),
    priority: PrioritySchema,
  })
  .strict();

export type TaskDraft = z.infer<typeof TaskDraftSchema>;

export const ImportEnvelopeSchema = z
  .object({
    version: z.literal(1),
    exported_at: IsoDateTime,
    tasks: z.array(z.unknown()).default([]),
  })
  .strict();

export type ImportEnvelope = z.infer<typeof ImportEnvelopeSchema>;

/** Settings persisted in the `meta` store. */
export const SettingsSchema = z
  .object({
    theme: z.enum(['dark', 'light', 'system']).default('dark'),
    remindersEnabled: z.boolean().default(false),
    /** minutes before the due time to fire a reminder */
    reminderLeadMinutes: z.number().int().min(0).max(24 * 60).default(120),
    installedHintDismissed: z.boolean().default(false),
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/** Snapshot row inside the `backups` store. */
export interface BackupRecord {
  id: string; // uuid
  createdAt: string; // ISO
  reason: 'on-open' | 'pre-restore' | 'manual';
  count: number;
  /** JSON byte length of `payload` — drives the 2 MB cumulative cap. */
  size: number;
  version: 1;
  payload: string; // serialized ImportEnvelope
}

export interface MetaRecord {
  key: string;
  value: unknown;
}

/* ------------------------------------------------------------------ *
 * Phase 2 — sync
 * ------------------------------------------------------------------ */

/**
 * One pending mutation. The queue lives in IndexedDB on purpose: it has to be
 * writable exactly when the network is not.
 *
 * A `delete` is carried as an upsert with `deletedAt` set (a tombstone), because
 * a hard DELETE cannot propagate — the other device either never learns about it
 * or re-pushes the copy it still holds.
 */
export interface OutboxRecord {
  /** auto-increment, doubles as the FIFO ordering */
  seq?: number;
  taskId: string;
  /** `upsert` covers create/update/soft-delete; `delete` is a hard delete of a row the server already knows about */
  op: 'upsert' | 'delete';
  /** the task's revision at enqueue time — LAST-write-wins needs it */
  revision: number;
  /** the full task row as it must be written remotely (always the newest local copy) */
  payload: Task;
  queuedAt: string;
  attempts: number;
  /** exponential backoff cursor; the op is skipped before this instant */
  nextAttemptAt: number;
  lastError: string | null;
}

/** Remembers a locally-deleted id so an older remote copy cannot resurrect it. */
export interface TombstoneRecord {
  id: string;
  deletedAt: string;
}

export type ValidationReport = {
  total: number;
  accepted: Task[];
  skipped: { index: number; reason: string }[];
  /** how many records actually changed the stored state */
  applied: number;
};
