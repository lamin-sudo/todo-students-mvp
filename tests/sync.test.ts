/**
 * Phase 2 sync — the decisions live in `planPush` / `planPull`, which are pure.
 * This suite drives them with a fake transport and a real (isolated) IndexedDB,
 * so no network is involved and every conflict case is reproducible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.hoisted(() => {
  (globalThis as unknown as { __TODO_DB_NAME__?: string }).__TODO_DB_NAME__ =
    `todo-sync-test-${Math.random().toString(36).slice(2)}`;
});

import { db, newTask, type TaskInput } from '../src/lib/db';
import type { Task } from '../src/lib/schemas';
import { isNewer } from '../src/lib/backup';
import { ROW_COLUMNS, canonIso, rowToTask, taskToRow } from '../src/lib/sync/rows';
import { toBatch, type PullPage, type PushItem, type PushResult, type SyncTransport } from '../src/lib/sync/transport';
import { planPull, planPush, flushOutbox, pullOnce, bootstrapRemote } from '../src/lib/sync/engine';
import {
  MAX_ATTEMPTS,
  armSync,
  backoffMs,
  disarmSync,
  dueOps,
  enqueue,
  enqueueDelete,
  isArmed,
  outboxStats,
  parkedOps,
  retryAllNow,
  setLastSyncAt,
  getLastSyncAt,
} from '../src/lib/sync/outbox';

const mk = (over: Partial<TaskInput> = {}) => newTask({ title: 'مهمة', ...over });
/**
 * Deterministic clock. `at(n)` must return the SAME string every call — an
 * earlier version built it from `Date.now()` at call time, so `expect(x).toBe(at(5))`
 * compared two different millisecond values and failed on correct code.
 */
const BASE = Date.parse('2026-10-11T12:00:00.000Z');
const at = (hours: number) => new Date(BASE + hours * 3600_000).toISOString();
/** A real v4 UUID — `TaskSchema` types `id` as `uuid()`, so 'same'/'gone' would
 *  be rejected by the funnel and make a test pass for the wrong reason. */
const uid = () => crypto.randomUUID();

/** The server row shape, as PostgREST would return it. */
const row = (t: Task, extra: Record<string, unknown> = {}) => ({
  id: t.id,
  user_id: 'user-1',
  title: t.title,
  subject: t.subject,
  due_at: t.dueAt,
  priority: t.priority,
  done: t.done,
  done_at: t.doneAt,
  created_at: t.createdAt,
  updated_at: t.updatedAt,
  revision: t.revision,
  deleted_at: null,
  ...extra,
});

type FakeOptions = {
  /** what push returns; default = the honest echo (accepted, server-stamped) */
  pushImpl?: (items: PushItem[]) => PushResult[] | Promise<PushResult[]>;
  pages?: PullPage[];
};

function fakeTransport(opts: FakeOptions = {}): SyncTransport & { pushedBatches: PushItem[][]; deleted: string[] } {
  const pushedBatches: PushItem[][] = [];
  const deleted: string[] = [];
  let page = 0;
  return {
    pushedBatches,
    deleted,
    async push(items) {
      pushedBatches.push(items);
      if (opts.pushImpl) return opts.pushImpl(items);
      // honest default: everything accepted, stamped by the "server" clock
      return items.map((i) => ({
        id: i.task.id,
        updatedAt: canonIso(new Date(Date.now() + 5000).toISOString()),
        revision: i.task.revision,
        applied: true,
      }));
    },
    async pull() {
      const p = opts.pages?.[page] ?? { rows: [], maxUpdatedAt: null };
      page += 1;
      return p;
    },
    async hardDelete(id) {
      deleted.push(id);
    },
  };
}

beforeEach(async () => {
  await Promise.all([
    db.tasks.clear(),
    db.backups.clear(),
    db.meta.clear(),
    db.outbox.clear(),
    db.tombstones.clear(),
  ]);
});

afterEach(() => vi.restoreAllMocks());

/* ================================================================== *
 * 1. Zod parity — local <-> remote
 * ================================================================== */

describe('schema parity (local <-> remote)', () => {
  it('taskToRow emits exactly the columns declared in schema.sql', () => {
    const sql = readFileSync(
      fileURLToPath(new URL('../supabase/schema.sql', import.meta.url)),
      'utf8',
    );
    // the CREATE TABLE block only
    const block = sql.slice(sql.indexOf('create table if not exists public.tasks'));
    const body = block.slice(block.indexOf('(') + 1, block.indexOf('\n);'));
    const declared = body
      .split('\n')
      .map((l) => l.trim())
      // keep column definitions, drop comments/constraints
      .filter((l) => l && !l.startsWith('--') && !l.startsWith('unique') && !l.startsWith('primary'))
      .map((l) => l.split(/\s+/)[0])
      .filter((c) => /^[a-z_]+$/.test(c));

    expect(declared.length).toBeGreaterThan(8);
    expect(new Set(declared)).toEqual(new Set(ROW_COLUMNS));
    // and taskToRow must actually emit them
    const emitted = Object.keys(taskToRow(mk(), 'user-1'));
    expect(new Set(emitted)).toEqual(new Set(ROW_COLUMNS));
  });

  it('round-trips a task through row -> task unchanged', () => {
    const original = mk({ title: 'رياضيات', subject: 'maths', dueAt: at(3), priority: 'high', revision: 4 });
    const parsed = rowToTask(row(original));
    expect(parsed).not.toBeNull();
    expect(parsed!.task).toEqual(original);
    expect(parsed!.deletedAt).toBeNull();
  });

  it('ignores unknown remote keys instead of smuggling them into IndexedDB', () => {
    // We build the candidate from a WHITELIST of the fields we read, so a new
    // column on the server does not break an older client. The Zod funnel still
    // validates every field that IS read.
    const parsed = rowToTask({ ...row(mk()), evil: 'payload', future_column: 1 });
    expect(parsed).not.toBeNull();
    expect(parsed!.task).not.toHaveProperty('evil');
    expect(parsed!.task).not.toHaveProperty('future_column');
  });

  it('rejects a remote row that is missing or malformed', () => {
    expect(rowToTask({ id: 'nope' })).toBeNull(); // no title, id not a uuid
    expect(rowToTask({ id: uid(), title: '' })).toBeNull(); // title must be non-empty
    expect(rowToTask({ id: uid(), title: 'x'.repeat(500) })).toBeNull(); // over the 200 cap
    expect(rowToTask({ id: uid(), title: 'ok', priority: 'URGENT' })).toBeNull(); // outside the enum
    expect(rowToTask(null)).toBeNull();
    expect(rowToTask('a string')).toBeNull();
  });

  it('treats an empty-string timestamp as null, not as the epoch', () => {
    const t = mk({ dueAt: null });
    const parsed = rowToTask(row(t, { due_at: '' }));
    expect(parsed!.task.dueAt).toBeNull();
  });
});

/* ================================================================== *
 * 2. canonIso — the string-comparison bug this prevents
 * ================================================================== */

describe('timestamp canonicalisation', () => {
  it('collapses Postgres microseconds and client milliseconds to one shape', () => {
    // character-for-character the two formats the two sides actually produce
    expect(canonIso('2026-10-11T22:43:07.637547+00:00')).toBe('2026-10-11T22:43:07.637Z');
    expect(canonIso('2026-10-11T22:43:07.637Z')).toBe('2026-10-11T22:43:07.637Z');
  });

  it('is what stops a newer server copy from sorting as older', () => {
    const server = '2026-10-11T22:43:07.637547+00:00'; // 547µs LATER
    const client = '2026-10-11T22:43:07.637Z';
    // raw: the string compare says the server copy is OLDER ('5' < 'Z') -- wrong
    expect(server > client).toBe(false);
    // canonicalised: the tie is a tie, and revision decides
    expect(canonIso(server)).toBe(canonIso(client));
    const a = mk({ id: 'x', updatedAt: canonIso(client)!, revision: 1 });
    const b = mk({ id: 'x', updatedAt: canonIso(server)!, revision: 2 });
    expect(isNewer(b, a)).toBe(true);
  });

  it('is idempotent and rejects garbage', () => {
    expect(canonIso('2026-10-11T22:43:07.637Z')).toBe(canonIso('2026-10-11T22:43:07.637Z'));
    expect(canonIso('not a date')).toBeNull();
    expect(canonIso(null)).toBeNull();
  });
});

/* ================================================================== *
 * 3. planPush — what a push result means
 * ================================================================== */

describe('planPush', () => {
  const op = (task: Task, seq: number) => ({
    seq,
    taskId: task.id,
    op: 'upsert' as const,
    revision: task.revision,
    payload: task,
    queuedAt: at(-1),
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
  });

  it('settles an accepted op and adopts the SERVER updated_at', () => {
    const t = mk({ revision: 1, updatedAt: at(-5) });
    const serverAt = at(0);
    const plan = planPush([op(t, 1)], [{ id: t.id, updatedAt: serverAt, revision: 1, applied: true }]);
    expect(plan.settled).toEqual([1]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.corrections).toHaveLength(1);
    // the correction must carry the server stamp, not the local one — this is
    // what stops the push/pull churn loop
    expect(plan.corrections[0].updatedAt).toBe(serverAt);
  });

  it('never drops an op the server refused', () => {
    const t = mk({ revision: 1 });
    const plan = planPush([op(t, 7)], [{ id: t.id, updatedAt: at(1), revision: 3, applied: false }]);
    expect(plan.settled).toEqual([]);
    expect(plan.conflicts).toEqual([t.id]);
  });

  it('treats a MISSING result as a refusal, not as success', () => {
    const t = mk({ revision: 1 });
    const plan = planPush([op(t, 2)], []);
    expect(plan.settled).toEqual([]);
    expect(plan.conflicts).toEqual([t.id]);
  });

  it('emits no correction when the server agrees with the local stamp', () => {
    const t = mk({ revision: 1 });
    const plan = planPush([op(t, 1)], [{ id: t.id, updatedAt: t.updatedAt, revision: 1, applied: true }]);
    expect(plan.corrections).toEqual([]);
  });
});

/* ================================================================== *
 * 4. planPull — merge with mocked delta
 * ================================================================== */

describe('planPull (delta merge)', () => {
  it('writes a remote row we have never seen', () => {
    const remote = mk({ title: 'من الجهاز الآخر' });
    const plan = planPull({ rows: [row(remote)], maxUpdatedAt: remote.updatedAt }, new Map(), new Map());
    expect(plan.toPut.map((t) => t.title)).toEqual(['من الجهاز الآخر']);
    expect(plan.cursor).toBe(remote.updatedAt);
  });

  it('keeps the local copy when it is newer (LWW)', () => {
    const id = uid();
    const local = mk({ id, title: 'local newer', updatedAt: at(2), revision: 1 });
    const remote = mk({ id, title: 'remote older', updatedAt: at(-2), revision: 5 });
    const plan = planPull(
      { rows: [row(remote)], maxUpdatedAt: remote.updatedAt },
      new Map([[local.id, local]]),
      new Map(),
    );
    expect(plan.toPut).toEqual([]);
    expect(plan.rejected).toBe(0);
  });

  it('breaks a timestamp tie with revision, not with arrival order', () => {
    const id = uid();
    const stamp = at(1);
    const local = mk({ id, title: 'local', updatedAt: stamp, revision: 2 });
    const remote = mk({ id, title: 'remote', updatedAt: stamp, revision: 3 });
    const plan = planPull(
      { rows: [row(remote)], maxUpdatedAt: stamp },
      new Map([[local.id, local]]),
      new Map(),
    );
    expect(plan.toPut.map((t) => t.title)).toEqual(['remote']);
  });

  it('takes the local copy when the tie-break revision is lower', () => {
    const id = uid();
    const stamp = at(1);
    const local = mk({ id, title: 'local wins', updatedAt: stamp, revision: 9 });
    const remote = mk({ id, title: 'remote loses', updatedAt: stamp, revision: 3 });
    const plan = planPull(
      { rows: [row(remote)], maxUpdatedAt: stamp },
      new Map([[local.id, local]]),
      new Map(),
    );
    expect(plan.toPut).toEqual([]);
  });

  it('does NOT resurrect a task deleted on this device', () => {
    const id = uid();
    const remote = mk({ id, updatedAt: at(9), revision: 99 });
    const plan = planPull(
      { rows: [row(remote)], maxUpdatedAt: remote.updatedAt },
      new Map(),
      new Map([[id, at(-1)]]),
    );
    expect(plan.toPut).toEqual([]);
  });

  it('applies a remote tombstone by deleting the local row', () => {
    const local = mk({ id: uid() });
    const plan = planPull(
      { rows: [row(local, { deleted_at: at(0) })], maxUpdatedAt: local.updatedAt },
      new Map([[local.id, local]]),
      new Map(),
    );
    expect(plan.toDelete).toEqual([local.id]);
    expect(plan.tombstoned.map((t) => t.id)).toEqual([local.id]);
    // the cursor must still advance past an ignored row, or we re-read it forever
    expect(plan.cursor).toBe(local.updatedAt);
  });

  it('records a tombstone for a row it never had, without deleting anything', () => {
    const remote = mk({ id: uid() });
    const plan = planPull(
      { rows: [row(remote, { deleted_at: at(0) })], maxUpdatedAt: remote.updatedAt },
      new Map(),
      new Map(),
    );
    expect(plan.toDelete).toEqual([]);
    expect(plan.tombstoned.map((t) => t.id)).toEqual([remote.id]);
  });

  it('reports rows the Zod funnel rejected without writing them', () => {
    const plan = planPull(
      { rows: [{ id: 'broken' }, row(mk())], maxUpdatedAt: at(1) },
      new Map(),
      new Map(),
    );
    expect(plan.rejected).toBe(1);
    expect(plan.toPut).toHaveLength(1);
  });
});

/* ================================================================== *
 * 5. outbox — coalescing, backoff, never dropping
 * ================================================================== */

describe('outbox', () => {
  it('coalesces edits to one task into a single queued op', async () => {
    const t = mk({ revision: 1 });
    await enqueue(t);
    await enqueue({ ...t, revision: 2, title: 'v2' });
    await enqueue({ ...t, revision: 3, title: 'v3' });
    const rows = await db.outbox.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.title).toBe('v3');
    expect(rows[0].revision).toBe(3);
  });

  it('keeps its place in the FIFO line when coalescing', async () => {
    const a = mk({ id: 'a' });
    const b = mk({ id: 'b' });
    await enqueue(a);
    await enqueue(b);
    const first = (await db.outbox.where('taskId').equals('a').first())!.seq;
    await enqueue({ ...a, revision: 9 });
    const stillA = (await db.outbox.where('taskId').equals('a').first())!.seq;
    expect(stillA).toBe(first);
  });

  it('grows the backoff and parks an op after MAX_ATTEMPTS instead of dropping it', async () => {
    await enqueue(mk({ id: 'flaky' }));
    const seq = (await db.outbox.toArray())[0].seq!;
    const { markFailed } = await import('../src/lib/sync/outbox');

    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      await markFailed(seq, 'boom');
      const row = (await db.outbox.get(seq))!;
      expect(row.attempts).toBe(i);
      expect(row.lastError).toBe('boom');
      expect(row.nextAttemptAt).toBeGreaterThan(Date.now() - 1000);
    }

    // parked, NOT deleted -- a dropped op is silent data loss
    expect((await db.outbox.get(seq))).toBeDefined();
    expect((await parkedOps()).map((o) => o.taskId)).toEqual(['flaky']);
    expect(await dueOps()).toHaveLength(0); // no longer retried automatically

    const stats = await outboxStats();
    expect(stats).toMatchObject({ pending: 1, parked: 1 });
  });

  it('backs off exponentially, capped', () => {
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(99)).toBe(60_000);
  });

  it('a fresh edit resets the retry budget so the new payload is not punished', async () => {
    const t = mk({ id: 't', revision: 1 });
    await enqueue(t);
    const seq = (await db.outbox.toArray())[0].seq!;
    const { markFailed } = await import('../src/lib/sync/outbox');
    await markFailed(seq, 'old payload failed');
    await enqueue({ ...t, revision: 2, title: 'edited' });
    const row = (await db.outbox.toArray())[0];
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
  });

  it('retryAllNow revives every parked op', async () => {
    await enqueue(mk({ id: 'p' }));
    const seq = (await db.outbox.toArray())[0].seq!;
    const { markFailed } = await import('../src/lib/sync/outbox');
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await markFailed(seq, 'x');
    expect(await dueOps()).toHaveLength(0);
    await retryAllNow();
    expect(await dueOps()).toHaveLength(1);
  });

  it('remembering a delete stops a later pull from resurrecting the task', async () => {
    const t = mk({ id: 'deleted', revision: 1 });
    await db.tasks.put(t);
    await enqueueDelete(t.id);
    const tombs = await db.tombstones.toArray();
    expect(tombs.map((x) => x.id)).toEqual(['deleted']);
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('delete');
  });

  it('a delete of a never-synced task needs no server call', async () => {
    await enqueueDelete('never-pushed');
    expect(await db.outbox.toArray()).toHaveLength(0);
    expect((await db.tombstones.toArray()).map((x) => x.id)).toEqual(['never-pushed']);
  });

  it('the pull cursor only moves forward', async () => {
    const five = at(5);
    await setLastSyncAt(five);
    await setLastSyncAt(at(-5)); // a stale response must not rewind it
    expect(await getLastSyncAt()).toBe(five);
    const nine = at(9);
    await setLastSyncAt(nine);
    expect(await getLastSyncAt()).toBe(nine);
  });

  it('is disarmed until a user signs in', async () => {
    expect(await isArmed()).toBe(false);
    await armSync('user-1');
    expect(await isArmed()).toBe(true);
    await disarmSync();
    expect(await isArmed()).toBe(false);
  });
});

/* ================================================================== *
 * 6. flushOutbox / pullOnce — the drivers
 * ================================================================== */

describe('flushOutbox', () => {
  it('settles accepted ops and rewrites the local row with the server stamp', async () => {
    const t = mk({ revision: 1, updatedAt: at(-5) });
    await db.tasks.put(t);
    await enqueue(t);
    const transport = fakeTransport();
    const res = await flushOutbox(transport, 'user-1');

    expect(res.settled).toBe(1);
    expect(await db.outbox.count()).toBe(0);
    const local = (await db.tasks.get(t.id))!;
    expect(local.updatedAt).not.toBe(t.updatedAt); // adopted the server stamp
    expect(transport.pushedBatches[0][0].task.id).toBe(t.id);
  });

  it('sends user_id nowhere — the RPC stamps auth.uid()', async () => {
    const t = mk();
    await enqueue(t);
    const transport = fakeTransport();
    await flushOutbox(transport, 'user-1');
    const payload = toBatch(transport.pushedBatches[0], 'user-1')[0];
    expect(payload).not.toHaveProperty('user_id');
    expect(payload).toMatchObject({ id: t.id, title: t.title });
  });

  it('keeps a refused op queued and records the failure', async () => {
    const t = mk({ revision: 1 });
    await enqueue(t);
    const transport = fakeTransport({
      pushImpl: (items) =>
        items.map((i) => ({ id: i.task.id, updatedAt: at(1), revision: 99, applied: false })),
    });
    const res = await flushOutbox(transport, 'user-1');
    expect(res.conflicts).toEqual([t.id]);
    expect(res.failed).toBe(1);
    const row = (await db.outbox.toArray())[0];
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('refused');
  });

  it('backs off every op when the transport itself throws', async () => {
    await enqueue(mk({ id: 'x' }));
    await enqueue(mk({ id: 'y' }));
    const transport = fakeTransport({
      pushImpl: () => {
        throw new Error('offline');
      },
    });
    const res = await flushOutbox(transport, 'user-1');
    expect(res.failed).toBe(2);
    const rows = await db.outbox.toArray();
    expect(rows.every((r) => r.lastError === 'offline' && r.attempts === 1)).toBe(true);
    expect(await db.outbox.count()).toBe(2); // nothing lost
  });

  it('does nothing at all when there is no work', async () => {
    const transport = fakeTransport();
    const res = await flushOutbox(transport, 'user-1');
    expect(res).toMatchObject({ pushed: 0, settled: 0, failed: 0 });
    expect(transport.pushedBatches).toHaveLength(0);
  });

  it('hard-deletes a queued delete op rather than upserting a tombstone', async () => {
    const t = mk({ id: 'doomed' });
    await db.tasks.put(t);
    await enqueueDelete(t.id);
    const transport = fakeTransport();
    await flushOutbox(transport, 'user-1');
    expect(transport.deleted).toEqual(['doomed']);
    expect(await db.outbox.count()).toBe(0);
  });

  it('a newer local edit is not rewound by a late stamp', async () => {
    const t = mk({ id: 'r', revision: 1, updatedAt: at(-9) });
    await db.tasks.put(t);
    await enqueue(t);

    // simulate: the user edits again while the push is in flight
    const transport = fakeTransport({
      pushImpl: async (items) => {
        await db.tasks.put({ ...t, revision: 5, title: 'newest', updatedAt: at(3) });
        return items.map((i) => ({
          id: i.task.id,
          updatedAt: canonIso(new Date().toISOString()),
          revision: 1,
          applied: true,
        }));
      },
    });
    await flushOutbox(transport, 'user-1');
    const local = (await db.tasks.get('r'))!;
    expect(local.title).toBe('newest');
    expect(local.revision).toBe(5);
  });
});

describe('pullOnce', () => {
  it('applies a page, advances the cursor and reports rejection counts', async () => {
    const remote = mk({ title: 'من الجهاز الآخر' });
    const transport = fakeTransport({ pages: [{ rows: [row(remote)], maxUpdatedAt: remote.updatedAt }] });
    const res = await pullOnce(transport);
    expect(res.written).toBe(1);
    expect((await db.tasks.toArray()).map((t) => t.title)).toEqual(['من الجهاز الآخر']);
    expect(await getLastSyncAt()).toBe(remote.updatedAt);
  });

  it('deletes locally a task the server tombstoned', async () => {
    const local = mk({ id: uid() });
    await db.tasks.put(local);
    const transport = fakeTransport({
      pages: [{ rows: [row(local, { deleted_at: at(0) })], maxUpdatedAt: local.updatedAt }],
    });
    await pullOnce(transport);
    expect(await db.tasks.get(local.id)).toBeUndefined();
    expect((await db.tombstones.toArray()).map((t) => t.id)).toEqual([local.id]);
  });

  it('requests only the delta when a cursor exists', async () => {
    const cursor = at(-1);
    await setLastSyncAt(cursor);
    const seen: (string | null)[] = [];
    const transport = fakeTransport();
    const spy: SyncTransport = {
      ...transport,
      async pull(since, _limit) {
        seen.push(since);
        return { rows: [], maxUpdatedAt: null };
      },
    };
    await pullOnce(spy);
    expect(seen).toEqual([cursor]);
  });
});

/* ================================================================== *
 * 7. first sign-in — which side is the source of truth
 * ================================================================== */

describe('bootstrapRemote (first sign-in)', () => {
  it('pushes the whole local history when the account is empty', async () => {
    await db.tasks.put(mk({ title: 'محلي 1' }));
    await db.tasks.put(mk({ title: 'محلي 2' }));
    const transport = fakeTransport();
    const res = await bootstrapRemote(transport, 'user-1');
    expect(res.mode).toBe('push-local');
    expect(res.pushed).toBe(2);
    expect(transport.pushedBatches[0]).toHaveLength(2);
  });

  it('PULLS instead when the account already has rows (never clobber the account)', async () => {
    await db.tasks.put(mk({ id: 'local-only', title: 'محلي' }));
    const remote = mk({ title: 'من الحساب' });
    const transport = fakeTransport({
      pages: [
        { rows: [row(remote)], maxUpdatedAt: remote.updatedAt }, // the probe
        { rows: [row(remote)], maxUpdatedAt: remote.updatedAt }, // the pull
      ],
    });
    const res = await bootstrapRemote(transport, 'user-1');
    expect(res.mode).toBe('pull-remote');
    expect(res.pushed).toBe(0);
    expect(transport.pushedBatches).toHaveLength(0);
    // the account's row landed, and the local-only row was NOT destroyed
    expect((await db.tasks.get(remote.id))).toBeDefined();
    expect((await db.tasks.get('local-only'))).toBeDefined();
  });

  it('is idempotent on an empty account with no local data', async () => {
    const transport = fakeTransport();
    const first = await bootstrapRemote(transport, 'user-1');
    const second = await bootstrapRemote(transport, 'user-1');
    expect(first.mode).toBe('empty');
    expect(second.mode).toBe('empty');
    expect(transport.pushedBatches).toHaveLength(0);
  });
});

/* ================================================================== *
 * 8. the offline promise — no Supabase without env vars
 * ================================================================== */

describe('offline bundle stays offline', () => {
  it('reports sync as unconfigured when the env vars are empty', async () => {
    const mod = await import('../src/lib/sync/client');
    // the test env defines no VITE_SUPABASE_* -> must degrade, not explode
    expect(typeof mod.syncConfigured()).toBe('boolean');
    if (!mod.SUPABASE_URL) {
      expect(mod.syncConfigured()).toBe(false);
      expect(await mod.getClient()).toBeNull();
      expect(await mod.sendMagicLink('a@b.c')).toMatchObject({ ok: false });
      expect(await mod.currentUserId()).toBeNull();
    }
  });

  it('keeps the Supabase chunk OUT of the service-worker precache', () => {
    // Without this, every visitor — including the ones who never sign in —
    // downloads ~230 kB of auth client when the PWA installs. It regresses
    // silently (the app still works), so it is pinned here.
    const cfg = readFileSync(fileURLToPath(new URL('../vite.config.ts', import.meta.url)), 'utf8');
    expect(cfg).toMatch(/globIgnores:\s*\[[^\]]*supabase/);
    // ...which only works if the chunk has a stable, matchable name
    expect(cfg).toMatch(/manualChunks[\s\S]{0,200}supabase/);
  });

  it('the sync client is imported dynamically, never statically', () => {
    const engine = readFileSync(fileURLToPath(new URL('../src/lib/sync/engine.ts', import.meta.url)), 'utf8');
    // a static import of supabase-js anywhere in the sync path would drag the
    // whole auth client into the offline bundle
    expect(engine).not.toMatch(/^import .*@supabase\/supabase-js/m);
    const client = readFileSync(fileURLToPath(new URL('../src/lib/sync/client.ts', import.meta.url)), 'utf8');
    expect(client).toMatch(/await import\('@supabase\/supabase-js'\)/);
  });
});

/* ================================================================== *
 * 9. D5 — import/restore feeds the outbox
 * ================================================================== */

describe('import feeds the outbox (D5)', () => {
  it('queues imported rows so they are not invisible to sync', async () => {
    const { importTasks, buildEnvelope } = await import('../src/lib/backup');
    const m = await import('../src/lib/sync/outbox');
    await m.armSync('user-1');

    const tasks: Task[] = [mk({ title: 'مستورد 1' }), mk({ title: 'مستورد 2' })];
    await importTasks(buildEnvelope(tasks));

    const queued = await db.outbox.toArray();
    expect(queued.map((o) => o.payload.title).sort()).toEqual(['مستورد 1', 'مستورد 2']);
  });

  it('queues nothing when sync was never armed', async () => {
    const { importTasks, buildEnvelope } = await import('../src/lib/backup');
    await importTasks(buildEnvelope([mk({ title: 'بلا مزامنة' })]));
    expect(await db.outbox.count()).toBe(0);
  });
});
