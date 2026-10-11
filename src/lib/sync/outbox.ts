import { db, getMeta, setMeta } from '../db';
import type { OutboxRecord, Task, TombstoneRecord } from '../schemas';

/** How many failed attempts before an op is parked instead of retried. */
export const MAX_ATTEMPTS = 3;
/** Backoff ceiling — 2^attempts seconds, capped. */
export const MAX_BACKOFF_MS = 60_000;
const LAST_SYNC_KEY = 'lastSyncAt';
const SYNC_USER_KEY = 'syncUserId';

export const backoffMs = (attempts: number): number =>
  Math.min(MAX_BACKOFF_MS, 2 ** Math.max(attempts, 1) * 1000);

/* ------------------------------------------------------------------ *
 * Armed / disarmed
 * ------------------------------------------------------------------ */

/**
 * Sync is only "armed" once an account has signed in on this device, and the
 * flag is PERSISTED — a reload must not silently stop queueing edits the user
 * already made expecting them to sync.
 *
 * A signed-out, never-signed-in app queues nothing: an unbounded local queue
 * that can never be flushed is not a feature. Nothing is lost by that, because
 * the first sign-in pushes the whole local history (`bootstrapRemote`).
 */
export async function armSync(userId: string): Promise<void> {
  await setMeta(SYNC_USER_KEY, userId);
}

export async function disarmSync(): Promise<void> {
  // The queue is intentionally NOT cleared on sign-out: those are the user's
  // edits and they flush when the account comes back.
  await setMeta(SYNC_USER_KEY, null);
}

export async function armedUserId(): Promise<string | null> {
  return getMeta<string | null>(SYNC_USER_KEY, null);
}

export async function isArmed(): Promise<boolean> {
  return (await armedUserId()) !== null;
}

/* ------------------------------------------------------------------ *
 * Enqueue — called from the ONE place tasks change (lib/backup.ts)
 * ------------------------------------------------------------------ */

/**
 * Coalesce by `taskId`: only the newest state of a task ever needs to reach the
 * server, so a task edited ten times offline queues ONE row, not ten. Without
 * this the outbox grows without bound and a flaky connection replays stale
 * intermediate states.
 *
 * `seq` is deliberately preserved on coalesce: the op keeps its original place
 * in the FIFO line rather than jumping the queue.
 */
export async function enqueue(task: Task, op: OutboxRecord['op'] = 'upsert'): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.outbox, async () => {
    const existing = await db.outbox.where('taskId').equals(task.id).first();
    const record: OutboxRecord = {
      seq: existing?.seq,
      taskId: task.id,
      op,
      revision: task.revision,
      payload: task,
      queuedAt: existing?.queuedAt ?? new Date(now).toISOString(),
      // a fresh edit deserves a fresh retry budget: the previous failure was
      // about the OLD payload, and punishing the edit for it strands it forever
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
    };
    await db.outbox.put(record);
  });
}

export async function enqueueMany(tasks: Task[]): Promise<void> {
  for (const task of tasks) await enqueue(task);
}

/**
 * Queue a hard delete, and remember the id so a later pull of an older remote
 * copy cannot resurrect the task. (See TombstoneRecord for why a plain DELETE
 * is not enough.)
 */
export async function enqueueDelete(id: string): Promise<void> {
  const deletedAt = new Date().toISOString();
  const tomb: TombstoneRecord = { id, deletedAt };
  await db.transaction('rw', db.outbox, db.tombstones, db.tasks, async () => {
    await db.outbox.where('taskId').equals(id).delete();
    const current = await db.tasks.get(id);
    if (!current) {
      // never synced: nothing to tell the server, the tombstone is enough
      await db.tombstones.put(tomb);
      return;
    }
    const record: OutboxRecord = {
      taskId: id,
      op: 'delete',
      revision: current.revision + 1,
      payload: { ...current, revision: current.revision + 1 },
      queuedAt: deletedAt,
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastError: null,
    };
    await db.outbox.put(record);
    await db.tombstones.put(tomb);
  });
}

/* ------------------------------------------------------------------ *
 * Observation for the UI banner
 * ------------------------------------------------------------------ */

export type OutboxStats = { pending: number; parked: number; oldestQueuedAt: string | null };

export async function outboxStats(): Promise<OutboxStats> {
  const all = await db.outbox.toArray();
  const parked = all.filter((o) => o.attempts >= MAX_ATTEMPTS).length;
  const oldest = all.reduce<string | null>(
    (min, o) => (min === null || o.queuedAt < min ? o.queuedAt : min),
    null,
  );
  return { pending: all.length, parked, oldestQueuedAt: oldest };
}

/** Ops eligible for a push right now (backoff expired, retry budget left). */
export async function dueOps(now = Date.now()): Promise<OutboxRecord[]> {
  const all = await db.outbox.orderBy('seq').toArray();
  return all.filter((o) => o.attempts < MAX_ATTEMPTS && o.nextAttemptAt <= now);
}

/** Ops that burned their retry budget. Surfaced, never silently dropped. */
export async function parkedOps(): Promise<OutboxRecord[]> {
  const all = await db.outbox.toArray();
  return all.filter((o) => o.attempts >= MAX_ATTEMPTS);
}

export async function markFailed(seq: number, error: string): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    const row = await db.outbox.get(seq);
    if (!row) return;
    const attempts = row.attempts + 1;
    await db.outbox.put({
      ...row,
      attempts,
      nextAttemptAt: Date.now() + backoffMs(attempts),
      lastError: error,
    });
  });
}

export async function removeOp(seq: number): Promise<void> {
  await db.outbox.delete(seq);
}

/** Give every parked/backed-off op a clean slate ("زامن دابا"). */
export async function retryAllNow(): Promise<number> {
  const affected = await db.transaction('rw', db.outbox, async () => {
    const all = await db.outbox.toArray();
    for (const row of all) {
      await db.outbox.put({ ...row, attempts: 0, nextAttemptAt: Date.now(), lastError: null });
    }
    return all.length;
  });
  return affected;
}

/* ------------------------------------------------------------------ *
 * Pull cursor
 * ------------------------------------------------------------------ */

export async function getLastSyncAt(): Promise<string | null> {
  return getMeta<string | null>(LAST_SYNC_KEY, null);
}

/**
 * Only ever moves forward. A stale response (or a clock that jumped back)
 * must not rewind the cursor, or the next pull re-delivers rows the user
 * already has and the merge has to do the same work twice.
 */
export async function setLastSyncAt(iso: string): Promise<void> {
  const current = await getLastSyncAt();
  if (current && current >= iso) return;
  await setMeta(LAST_SYNC_KEY, iso);
}
