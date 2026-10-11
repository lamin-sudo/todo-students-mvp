import { db } from '../db';
import { isNewer } from '../backup';
import type { OutboxRecord, Task } from '../schemas';
import { canonIso, rowToTask } from './rows';
import {
  PULL_PAGE_SIZE,
  type PullPage,
  type PushItem,
  type PushResult,
  type SyncTransport,
} from './transport';
import { dueOps, markFailed, parkedOps, removeOp, setLastSyncAt, getLastSyncAt } from './outbox';

/* ------------------------------------------------------------------ *
 * PURE planning — everything that decides what happens lives here,
 * where a test can drive it with a fake transport and no network.
 * ------------------------------------------------------------------ */

export type PushPlan = {
  /** outbox seqs that are finished and can be dropped */
  settled: number[];
  /**
   * Local rows to rewrite with the SERVER's stamped updated_at/revision.
   *
   * Without this the client keeps its own clock's value, the server keeps its
   * own, they disagree for the same row forever, and every pull sees "remote is
   * newer" and re-applies the edit. The server timestamp is the truth.
   */
  corrections: Task[];
  /** ids the server refused — the client must pull and reconcile */
  conflicts: string[];
};

/**
 * Interpret `push_tasks` results against the ops that produced them.
 *
 * A missing result is treated as a REFUSAL, not as success: assuming success
 * would drop a write we were never told landed.
 */
export function planPush(ops: OutboxRecord[], results: PushResult[]): PushPlan {
  const byId = new Map(results.map((r) => [r.id, r]));
  const plan: PushPlan = { settled: [], corrections: [], conflicts: [] };

  for (const op of ops) {
    if (op.seq === undefined) continue;
    const res = byId.get(op.taskId);

    if (!res || !res.applied) {
      plan.conflicts.push(op.taskId);
      continue; // stays queued: the pull brings the winner, then it settles
    }

    plan.settled.push(op.seq);
    const serverUpdatedAt = canonIso(res.updatedAt);
    if (serverUpdatedAt && serverUpdatedAt !== op.payload.updatedAt) {
      plan.corrections.push({
        ...op.payload,
        updatedAt: serverUpdatedAt,
        revision: res.revision ?? op.payload.revision,
      });
    }
  }

  return plan;
}

export type PullPlan = {
  toPut: Task[];
  toDelete: string[];
  /** ids of rows the server holds as deleted — remembered so they cannot return */
  tombstoned: { id: string; deletedAt: string }[];
  cursor: string | null;
  hasMore: boolean;
  /** rows rejected by the Zod funnel — reported, never written */
  rejected: number;
};

/**
 * Decide what a pulled page means locally.
 *
 * Local tombstones win over remote rows: the user deleted the task on this
 * device and the outbox delete may still be in flight. Letting the remote copy
 * win here would make the task reappear — the single most infuriating possible
 * sync bug.
 */
export function planPull(
  page: PullPage,
  local: Map<string, Task>,
  localTombstones: Map<string, string>,
  limit = PULL_PAGE_SIZE,
): PullPlan {
  const plan: PullPlan = {
    toPut: [],
    toDelete: [],
    tombstoned: [],
    cursor: null,
    hasMore: page.rows.length >= limit,
    rejected: 0,
  };

  for (const raw of page.rows) {
    const parsed = rowToTask(raw);
    if (!parsed) {
      plan.rejected += 1;
      continue;
    }
    const { task: remote, deletedAt } = parsed;

    if (deletedAt) {
      const already = localTombstones.get(remote.id);
      // the pull cursor must still move past a row we ignore, or we re-read it
      // forever
      if (!already) plan.tombstoned.push({ id: remote.id, deletedAt });
      if (local.has(remote.id)) plan.toDelete.push(remote.id);
      continue;
    }

    if (localTombstones.has(remote.id)) continue; // deleted here, stays deleted

    const mine = local.get(remote.id);
    if (!mine || isNewer(remote, mine)) plan.toPut.push(remote);
  }

  plan.cursor = canonIso(page.maxUpdatedAt);
  return plan;
}

/* ------------------------------------------------------------------ *
 * IMPURE drivers — thin wrappers, no decisions of their own
 * ------------------------------------------------------------------ */

export type FlushResult = { pushed: number; settled: number; conflicts: string[]; failed: number };

/**
 * Push every eligible op once; retry/backoff bookkeeping is the outbox's job.
 *
 * Deletes are NOT special-cased into a DELETE statement. They go through the
 * same `push_tasks` batch as edits, carrying `deleted_at`, because the server
 * row must survive as a tombstone for the other devices to pull. A hard delete
 * here would hide the removal from every device the user did not delete it on.
 */
export async function flushOutbox(
  transport: SyncTransport,
  userId: string,
  now = Date.now(),
): Promise<FlushResult> {
  const ops = await dueOps(now);
  const result: FlushResult = { pushed: 0, settled: 0, conflicts: [], failed: 0 };
  if (ops.length === 0) return result;

  try {
    const items: PushItem[] = ops.map((o) => ({ task: o.payload, op: o.op }));
    const results = await transport.push(items, userId);
    result.pushed = ops.length;

    const plan = planPush(ops, results);
    for (const seq of plan.settled) await removeOp(seq);
    result.settled += plan.settled.length;
    result.conflicts = plan.conflicts;

    // correct local rows with the server's stamps, via the shared merge rule
    await applyCorrections(plan.corrections);

    // refusals keep their op but record the failure, so backoff applies and a
    // permanently-rejected op ends up parked and VISIBLE instead of looping
    for (const op of ops) {
      if (op.seq === undefined) continue;
      if (plan.conflicts.includes(op.taskId)) {
        await markFailed(op.seq, 'server refused (stale revision) — pull to reconcile');
        result.failed += 1;
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    for (const op of ops) {
      if (op.seq !== undefined) await markFailed(op.seq, message);
    }
    result.failed += ops.length;
  }

  return result;
}

async function applyCorrections(corrections: Task[]): Promise<void> {
  if (corrections.length === 0) return;
  await db.transaction('rw', db.tasks, async () => {
    for (const incoming of corrections) {
      const current = await db.tasks.get(incoming.id);
      if (!current) continue;
      /*
       * A newer local edit landed while the push was in flight, so this stamp
       * belongs to the copy we already replaced. Writing it would rewind the
       * row the user is looking at. Equal revisions are fine — that is our own
       * push coming back stamped.
       */
      if (current.revision > incoming.revision) continue;
      await db.tasks.put(incoming);
    }
  });
}

export type PullResult = { written: number; removed: number; hasMore: boolean; cursor: string | null };

/** One pull page: read, plan, apply. Repeated by the caller until `!hasMore`. */
export async function pullOnce(
  transport: SyncTransport,
  limit = PULL_PAGE_SIZE,
): Promise<PullResult> {
  const since = await getLastSyncAt();
  const page = await transport.pull(since, limit);

  const local = new Map((await db.tasks.toArray()).map((t) => [t.id, t] as const));
  const tombs = new Map((await db.tombstones.toArray()).map((t) => [t.id, t.deletedAt] as const));
  const plan = planPull(page, local, tombs, limit);

  await db.transaction('rw', db.tasks, db.tombstones, async () => {
    if (plan.toPut.length) await db.tasks.bulkPut(plan.toPut);
    if (plan.toDelete.length) await db.tasks.bulkDelete(plan.toDelete);
    for (const t of plan.tombstoned) {
      // keep the EARLIEST delete we know about; a later duplicate must not
      // extend it and let an older copy back in
      const existing = await db.tombstones.get(t.id);
      if (!existing) await db.tombstones.put(t);
    }
  });

  if (plan.cursor) await setLastSyncAt(plan.cursor);

  return {
    written: plan.toPut.length,
    removed: plan.toDelete.length,
    hasMore: plan.hasMore,
    cursor: plan.cursor,
  };
}

/** Push then pull, bounded. Returns what the banner should show. */
export async function syncNow(transport: SyncTransport, userId: string): Promise<{
  flush: FlushResult;
  pulled: PullResult[];
  parked: number;
}> {
  const flush = await flushOutbox(transport, userId);
  const pulled: PullResult[] = [];
  // Bounded on purpose: a broken cursor must not become an infinite loop that
  // pins the tab. The next sync continues where this one stopped.
  for (let i = 0; i < 20; i += 1) {
    const page = await pullOnce(transport);
    pulled.push(page);
    if (!page.hasMore || page.cursor === null) break;
  }
  return { flush, pulled, parked: (await parkedOps()).length };
}

/**
 * First sign-in on this device.
 *
 * The remote decides: if the account already has rows, the local device is the
 * newcomer and must PULL (pushing first would clobber the account with this
 * device's handful of tasks). If the account is empty, this device is the
 * origin and its whole history goes up. Keyed on the remote count, so running
 * it twice changes nothing.
 */
export async function bootstrapRemote(transport: SyncTransport, userId: string): Promise<{
  mode: 'push-local' | 'pull-remote' | 'empty';
  pushed: number;
}> {
  const first = await transport.pull(null, 1);
  const remoteHasRows = first.rows.length > 0;

  if (remoteHasRows) {
    await syncNow(transport, userId);
    return { mode: 'pull-remote', pushed: 0 };
  }

  const local = await db.tasks.toArray();
  if (local.length === 0) {
    await setLastSyncAt(new Date().toISOString());
    return { mode: 'empty', pushed: 0 };
  }
  const { enqueueMany } = await import('./outbox');
  await enqueueMany(local);
  const flush = await flushOutbox(transport, userId);
  return { mode: 'push-local', pushed: flush.settled };
}
