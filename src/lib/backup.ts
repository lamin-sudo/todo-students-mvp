import { db, newId, nowIso, setMeta, getMeta, StorageWriteError } from './db';
import {
  ImportEnvelopeSchema,
  TaskSchema,
  type BackupRecord,
  type Task,
  type ValidationReport,
} from './schemas';

/** Hard ceiling on how many snapshots we keep. */
export const MAX_BACKUPS = 8;
/** Hard ceiling on the cumulative byte size of all snapshots (2 MiB). */
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
/** How stale the newest snapshot may get before an on-open backup fires. */
export const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const LAST_BACKUP_KEY = 'lastBackupAt';

/* ------------------------------------------------------------------ *
 * Validation — one funnel for form input, JSON files and stored snapshots
 * ------------------------------------------------------------------ */

/**
 * Validate a list of unknown records. Invalid entries are skipped, never
 * coerced, and reported back with the reason + index.
 */
export function validateTasks(raw: unknown): ValidationReport {
  const list = Array.isArray(raw) ? raw : [];
  const accepted: Task[] = [];
  const skipped: ValidationReport['skipped'] = [];

  list.forEach((item, index) => {
    const parsed = TaskSchema.safeParse(item);
    if (parsed.success) {
      accepted.push(parsed.data);
    } else {
      const first = parsed.error.issues[0];
      skipped.push({
        index,
        reason: first ? `${first.path.join('.') || '<root>'}: ${first.message}` : 'invalid',
      });
    }
  });

  return { total: list.length, accepted, skipped, applied: 0 };
}

/** Parse + validate an exported envelope (from a file or a backup payload). */
export function parseEnvelope(text: string): ValidationReport & { exportedAt: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      total: 0,
      accepted: [],
      applied: 0,
      skipped: [{ index: -1, reason: 'not valid JSON' }],
      exportedAt: null,
    };
  }
  const env = ImportEnvelopeSchema.safeParse(raw);
  if (!env.success) {
    return {
      total: 0,
      accepted: [],
      applied: 0,
      skipped: [{ index: -1, reason: `envelope: ${env.error.issues[0]?.message ?? 'invalid'}` }],
      exportedAt: null,
    };
  }
  return { ...validateTasks(env.data.tasks), exportedAt: env.data.exported_at };
}

/* ------------------------------------------------------------------ *
 * Merge — last-write-wins on updatedAt, revision as tie-breaker
 * ------------------------------------------------------------------ */

export function buildEnvelope(tasks: Task[], exportedAt = nowIso()): string {
  return JSON.stringify({ version: 1, exported_at: exportedAt, tasks });
}

function isNewer(incoming: Task, current: Task): boolean {
  if (incoming.updatedAt !== current.updatedAt) return incoming.updatedAt > current.updatedAt;
  return incoming.revision > current.revision;
}

/**
 * Non-destructive merge: nothing is ever removed by an import. An older
 * incoming copy of an existing task is ignored (reported as skipped).
 */
export function mergeTasks(current: Task[], incoming: Task[]): ValidationReport {
  const byId = new Map(current.map((t) => [t.id, t]));
  const skipped: ValidationReport['skipped'] = [];
  let applied = 0;

  incoming.forEach((task, index) => {
    const existing = byId.get(task.id);
    if (!existing || isNewer(task, existing)) {
      byId.set(task.id, task);
      applied += 1;
    } else {
      skipped.push({ index, reason: 'older or identical copy (kept local)' });
    }
  });

  return { total: incoming.length, accepted: [...byId.values()], skipped, applied };
}

/** Merge a validated batch into the live table inside one transaction. */
async function applyTasks(incoming: Task[]): Promise<ValidationReport> {
  return db.transaction('rw', db.tasks, async () => {
    const current = await db.tasks.toArray();
    const byId = new Map(current.map((t) => [t.id, t]));
    const changed: Task[] = [];
    const skipped: ValidationReport['skipped'] = [];

    incoming.forEach((task, index) => {
      const existing = byId.get(task.id);
      if (!existing || isNewer(task, existing)) {
        byId.set(task.id, task);
        changed.push(task);
      } else {
        skipped.push({ index, reason: 'older or identical copy (kept local)' });
      }
    });

    if (changed.length) await db.tasks.bulkPut(changed);
    const result: ValidationReport = {
      total: incoming.length,
      accepted: [...byId.values()],
      skipped,
      applied: changed.length,
    };
    return result;
  });
}

/* ------------------------------------------------------------------ *
 * Snapshots
 * ------------------------------------------------------------------ */

export async function backupTasks(
  reason: BackupRecord['reason'] = 'manual',
): Promise<{ count: number; size: number; id: string | null }> {
  return db.transaction('rw', db.tasks, db.backups, db.meta, async () => {
    const tasks = await db.tasks.toArray();
    if (tasks.length === 0) return { count: 0, size: 0, id: null };

    const payload = buildEnvelope(tasks);
    const record: BackupRecord = {
      id: newId(),
      createdAt: nowIso(),
      reason,
      count: tasks.length,
      size: byteLength(payload),
      version: 1,
      payload,
    };

    try {
      await db.backups.put(record);
      await pruneBackups();
      await db.meta.put({ key: LAST_BACKUP_KEY, value: record.createdAt });
    } catch (err) {
      throw new StorageWriteError('backupTasks failed', err);
    }

    return { count: record.count, size: record.size, id: record.id };
  });
}

/** Keep the newest snapshots only: <= MAX_BACKUPS and <= MAX_BACKUP_BYTES. */
export async function pruneBackups(): Promise<{ removed: number }> {
  const all = await db.backups.orderBy('createdAt').toArray(); // oldest first
  if (all.length === 0) return { removed: 0 };

  // newest first for accounting, always keeping at least the newest one
  const newestFirst = [...all].reverse();
  const keep = new Set<string>();
  let bytes = 0;
  for (const snap of newestFirst) {
    const withinCount = keep.size < MAX_BACKUPS;
    const withinBytes = keep.size === 0 || bytes + snap.size <= MAX_BACKUP_BYTES;
    if (!withinCount || !withinBytes) break;
    keep.add(snap.id);
    bytes += snap.size;
  }

  const doomed = all.filter((s) => !keep.has(s.id)).map((s) => s.id);
  if (doomed.length) await db.backups.bulkDelete(doomed);
  return { removed: doomed.length };
}

/** Metadata list for the Settings screen — payloads are not loaded. */
export async function listBackups(): Promise<
  { id: string; createdAt: string; reason: BackupRecord['reason']; count: number; size: number }[]
> {
  const rows = await db.backups.orderBy('createdAt').reverse().toArray();
  return rows.map(({ id, createdAt, reason, count, size }) => ({ id, createdAt, reason, count, size }));
}

/**
 * Restore is destructive: snapshot the CURRENT state first (reason
 * 'pre-restore'), then merge the chosen snapshot with the same Zod funnel.
 */
export async function restoreFromBackup(
  id: string,
): Promise<{ imported: number; skipped: ValidationReport['skipped']; keptLocal: number }> {
  const snap = await db.backups.get(id);
  if (!snap) throw new Error(`backup ${id} not found`);

  await backupTasks('pre-restore');

  const report = parseEnvelope(snap.payload);
  const result = await applyTasks(report.accepted);
  return { imported: result.applied, skipped: report.skipped, keptLocal: result.skipped.length };
}

/* ------------------------------------------------------------------ *
 * Files (manual export / import)
 * ------------------------------------------------------------------ */

export async function exportTasks(): Promise<{ json: string; count: number; size: number }> {
  const tasks = await db.tasks.toArray();
  const json = buildEnvelope(tasks);
  return { json, count: tasks.length, size: byteLength(json) };
}

export async function importTasks(text: string): Promise<{
  imported: number;
  /** records the merge refused to apply (older/identical copy kept local) */
  skipped: ValidationReport['skipped'];
  /** records the Zod funnel rejected outright */
  invalid: ValidationReport['skipped'];
  exportedAt: string | null;
}> {
  const report = parseEnvelope(text);
  const result = await applyTasks(report.accepted);
  return {
    imported: result.applied,
    skipped: result.skipped,
    invalid: report.skipped,
    exportedAt: report.exportedAt,
  };
}

/* ------------------------------------------------------------------ *
 * On-open weekly backup (guaranteed) + optional periodicSync (bonus)
 * ------------------------------------------------------------------ */

export async function maybeAutoBackup(intervalMs = BACKUP_INTERVAL_MS): Promise<boolean> {
  const last = await getMeta<string | null>(LAST_BACKUP_KEY, null);
  if (last && Date.now() - Date.parse(last) < intervalMs) return false;
  const { id } = await backupTasks('on-open');
  return id !== null;
}

/**
 * Snapshot taken at the moment the first task is created.
 *
 * `maybeAutoBackup()` alone leaves a brand-new install unprotected: it runs at
 * boot, finds an empty table, writes nothing (and does not stamp `lastBackupAt`),
 * so the first task a student adds is not snapshotted until the NEXT visit —
 * exactly the data most likely to be lost. Called after the task is persisted,
 * so the snapshot contains it.
 *
 * The `lastBackupAt` gate is the double-backup guard: if boot already
 * snapshotted during this session, this is a no-op. Returns true only when a
 * new snapshot was actually written.
 */
export async function maybeSnapshotFirstTask(intervalMs = BACKUP_INTERVAL_MS): Promise<boolean> {
  return maybeAutoBackup(intervalMs);
}

/**
 * Bonus only: Chromium + installed PWA. Never the sole mechanism — the SW is
 * killed after ~30s idle so setInterval inside it is useless.
 */
export async function registerPeriodicBackup(): Promise<boolean> {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  const anyReg = sw?.ready as unknown as { periodicSync?: { register: (tag: string, o: { minInterval: number }) => Promise<void> } };
  if (!anyReg?.periodicSync?.register) return false;
  try {
    await anyReg.periodicSync.register('weekly-backup', { minInterval: BACKUP_INTERVAL_MS });
    return true;
  } catch {
    return false; // permission denied / not installed / engagement too low
  }
}

export async function setLastBackupAtForTest(iso: string): Promise<void> {
  await setMeta(LAST_BACKUP_KEY, iso);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
