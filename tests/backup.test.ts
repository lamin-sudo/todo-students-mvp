/**
 * Run with vitest. Each suite imports the data layer under its own
 * IndexedDB name so tests stay isolated (see __TODO_DB_NAME__ in src/lib/db.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

// isolate this file's IndexedDB database from any other suite
vi.hoisted(() => {
  (globalThis as unknown as { __TODO_DB_NAME__?: string }).__TODO_DB_NAME__ =
    `todo-test-${Math.random().toString(36).slice(2)}`;
});

import { setMeta, db, newTask, type TaskInput } from '../src/lib/db';
import {
  MAX_BACKUPS,
  backupTasks,
  exportTasks,
  importTasks,
  listBackups,
  maybeAutoBackup,
  parseEnvelope,
  pruneBackups,
  restoreFromBackup,
  validateTasks,
} from '../src/lib/backup';

const mk = (over: Partial<TaskInput> = {}) => newTask({ title: 'مهمة', ...over });

beforeEach(async () => {
  await Promise.all([db.tasks.clear(), db.backups.clear(), db.meta.clear()]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('schema funnel (Zod, .strict())', () => {
  it('accepts valid tasks and reports why each bad record was skipped', () => {
    const good = mk({ title: 'حل تمارين الفصل 3' });
    const report = validateTasks([
      good,
      { id: 'not-a-uuid', title: '' },
      { ...mk(), evil: 'extra-field' },
      null,
    ]);

    expect(report.total).toBe(4);
    expect(report.accepted).toHaveLength(1);
    expect(report.accepted[0].title).toBe('حل تمارين الفصل 3');
    expect(report.skipped).toHaveLength(3);
    expect(report.skipped[1].reason).toMatch(/unrecognized key/i);
    expect(report.skipped[0].reason).toMatch(/id/);
  });

  it('rejects a malformed envelope instead of throwing', () => {
    expect(parseEnvelope('{not json').skipped[0].reason).toBe('not valid JSON');
    expect(parseEnvelope(JSON.stringify({ version: 2, tasks: [] })).skipped[0].reason).toMatch(
      /envelope/,
    );
    expect(parseEnvelope(JSON.stringify({ version: 1, exported_at: 'x', tasks: [] })).skipped).toHaveLength(1);
  });

  it('fills defaults for omitted optional fields', () => {
    const bare = {
      id: crypto.randomUUID(),
      title: 'no extras',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const r = validateTasks([bare]);
    expect(r.accepted[0]).toMatchObject({ subject: '', dueAt: null, priority: 'normal', done: false, revision: 0 });
  });
});

describe('prune policy (dual cap)', () => {
  async function seed(n: number, size = 10) {
    for (let i = 0; i < n; i++) {
      await db.backups.put({
        id: crypto.randomUUID(),
        createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        reason: 'on-open',
        count: 1,
        size,
        version: 1,
        payload: '{}',
      });
    }
  }

  it(`keeps at most ${MAX_BACKUPS} newest snapshots`, async () => {
    await seed(MAX_BACKUPS + 4);
    const { removed } = await pruneBackups();
    const left = await listBackups();
    expect(left).toHaveLength(MAX_BACKUPS);
    expect(removed).toBe(4);
    expect(left[0].createdAt > left[left.length - 1].createdAt).toBe(true);
    expect(left.some((b) => b.createdAt === new Date(Date.UTC(2026, 0, 1)).toISOString())).toBe(false);
  });

  it('also caps cumulative bytes at 2 MB, always keeping the newest', async () => {
    await seed(3, 1_300_000); // 3 x 1.3MB > 2MB cap
    const { removed } = await pruneBackups();
    const left = await listBackups();
    expect(removed).toBe(2);
    expect(left).toHaveLength(1);
    expect(left[0].size).toBe(1_300_000); // the newest snapshot survived
  });
});

describe('backup / restore', () => {
  it('restore is destructive-safe: snapshots the current state and never blanks your data', async () => {
    const t1 = mk({ title: 'قديم' });
    await db.tasks.put(t1);
    const { id, count, size } = await backupTasks('manual');
    expect(count).toBe(1);
    expect(size).toBeGreaterThan(60);

    // state drifts after the snapshot: one task deleted, one new task added
    const t2 = mk({ title: 'جديد' });
    await db.tasks.put(t2);
    await db.tasks.delete(t1.id);

    const res = await restoreFromBackup(id!);

    expect(res.imported).toBe(1); // t1 is back…
    expect((await db.tasks.get(t1.id))?.title).toBe('قديم');
    expect(await db.tasks.get(t2.id)).toBeTruthy(); // …and t2 survived

    const after = await listBackups();
    expect(after.some((b) => b.reason === 'pre-restore')).toBe(true);
    expect(after.some((b) => b.reason === 'manual')).toBe(true);
  });

  it('restore refuses an unknown snapshot id', async () => {
    await expect(restoreFromBackup('does-not-exist')).rejects.toThrow(/not found/);
  });

  it('never overwrites a newer local copy with an older import (LWW + revision)', async () => {
    const id = crypto.randomUUID();
    const newer = mk({ id, title: 'newer', updatedAt: '2026-02-02T00:00:00.000Z' });
    const older = mk({ id, title: 'older', updatedAt: '2026-01-01T00:00:00.000Z' });
    await db.tasks.put(newer);

    const res = await importTasks(
      JSON.stringify({ version: 1, exported_at: older.updatedAt, tasks: [older] }),
    );

    expect(res.imported).toBe(0);
    expect(res.skipped).toHaveLength(1);
    expect((await db.tasks.get(id))?.title).toBe('newer');
  });

  it('breaks timestamp ties with revision, not insertion order', async () => {
    const id = crypto.randomUUID();
    const at = '2026-03-03T00:00:00.000Z';
    await db.tasks.put(mk({ id, title: 'v1', updatedAt: at, revision: 1 }));
    const res = await importTasks(
      JSON.stringify({
        version: 1,
        exported_at: at,
        tasks: [mk({ id, title: 'v2', updatedAt: at, revision: 2 })],
      }),
    );
    expect(res.imported).toBe(1);
    expect((await db.tasks.get(id))?.title).toBe('v2');
  });

  it('an import never deletes local tasks that are absent from the file', async () => {
    const local = mk({ title: 'محلي فقط' });
    await db.tasks.put(local);
    await importTasks(JSON.stringify({ version: 1, exported_at: new Date().toISOString(), tasks: [mk()] }));
    expect(await db.tasks.get(local.id)).toBeTruthy();
    expect(await db.tasks.count()).toBe(2);
  });
});

describe('on-open weekly trigger', () => {
  it('fires once per week, not on every launch', async () => {
    await db.tasks.put(mk());
    expect(await maybeAutoBackup()).toBe(true);
    expect(await maybeAutoBackup()).toBe(false); // same week: no new snapshot

    // simulate an 8-day-old snapshot
    await setMeta('lastBackupAt', new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString());
    expect(await maybeAutoBackup()).toBe(true);
    expect(await listBackups()).toHaveLength(2);
  });

  it('does nothing (and does not stamp meta) when there is nothing to back up', async () => {
    expect(await maybeAutoBackup()).toBe(false);
    expect(await db.backups.count()).toBe(0);
  });
});

describe('export → wipe → import round-trip', () => {
  it('loses nothing through the file envelope', async () => {
    await db.tasks.bulkPut([mk({ title: 'أ' }), mk({ title: 'ب', priority: 'high' })]);
    const { json, count } = await exportTasks();
    expect(count).toBe(2);
    expect(JSON.parse(json)).toMatchObject({ version: 1 });

    await db.tasks.clear();
    const back = await importTasks(json);
    expect(back.imported).toBe(2);
    expect((await db.tasks.toArray()).map((t) => t.title).sort()).toEqual(['أ', 'ب']);
  });

  /**
   * Importing onto a fresh device is the same hole as "first task": boot found
   * an empty table, so nothing was snapshotted. The imported rows must get one.
   */
  it('importing onto a fresh device snapshots the imported rows immediately', async () => {
    await db.tasks.bulkPut([mk({ title: 'من الملف' })]);
    const { json } = await exportTasks();

    // a genuinely fresh device: no tasks, no snapshots, no lastBackupAt
    await db.tasks.clear();
    await db.backups.clear();
    await db.meta.clear();
    expect(await listBackups()).toHaveLength(0);

    const res = await importTasks(json);

    expect(res.imported).toBe(1);
    const snaps = await listBackups();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].count).toBe(1);
    expect(await db.meta.get('lastBackupAt')).toBeTruthy();

    // and a second import in the same window must not pile on another snapshot
    await importTasks(json);
    expect(await listBackups()).toHaveLength(1);
  });

  /** The exact acceptance case: 3 tasks imported into an empty database. */
  it('importing 3 tasks into an empty database leaves exactly 1 snapshot', async () => {
    await db.tasks.bulkPut([mk({ title: 'أ' }), mk({ title: 'ب' }), mk({ title: 'ج' })]);
    const { json, count } = await exportTasks();
    expect(count).toBe(3);

    await db.tasks.clear();
    await db.backups.clear();
    await db.meta.clear();
    expect(await db.backups.count()).toBe(0);

    const res = await importTasks(json);

    expect(res.imported).toBe(3);
    expect(await db.tasks.count()).toBe(3);
    expect(await db.backups.count()).toBe(1);
    const snap = (await listBackups())[0];
    expect(snap.count).toBe(3);
  });

  /**
   * Restore is the other entry point into `applyTasks`. Note that a pre-restore
   * snapshot is skipped when the table is empty (`backupTasks` refuses to write
   * an empty envelope), and `lastBackupAt` is already stamped, so the
   * fresh-device hook must stay out of the way entirely: no extra snapshot.
   */
  it('restore adds no extra snapshot beyond pre-restore', async () => {
    await db.tasks.bulkPut([mk({ title: 'محفوظة' }), mk({ title: 'محفوظة 2', priority: 'high' })]);
    const { id } = await backupTasks('manual');
    expect(id).not.toBeNull();
    expect(await listBackups()).toHaveLength(1);

    // the user then deletes everything by hand
    await db.tasks.clear();
    expect(await db.tasks.count()).toBe(0);

    const res = await restoreFromBackup(id!);

    expect(res.imported).toBe(2);
    expect(await db.tasks.count()).toBe(2);
    // still just the manual snapshot: pre-restore was skipped (empty table) and
    // the fresh-device hook no-opped on the already-stamped lastBackupAt
    const snaps = await listBackups();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].id).toBe(id);
  });
});
