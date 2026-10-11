/**
 * Bootstrap contract: `persist()` is asked for BEFORE the first snapshot (so the
 * snapshot lands in protected storage) and a hanging `persist()` may never cost
 * us that snapshot. Both are asserted here because they are the two ways this
 * function can silently regress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.hoisted(() => {
  (globalThis as unknown as { __TODO_DB_NAME__?: string }).__TODO_DB_NAME__ =
    `todo-bootstrap-${Math.random().toString(36).slice(2)}`;
});

import { db, newTask } from '../src/lib/db';
import { bootstrapStorage } from '../src/lib/bootstrap';
import { backupTasks, listBackups } from '../src/lib/backup';

const seedTask = () =>
  db.tasks.put(newTask({ title: 'مراجعة الفيزياء', subject: 'فيزيك', dueAt: null }));

beforeEach(async () => {
  await Promise.all([db.tasks.clear(), db.backups.clear(), db.meta.clear()]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bootstrapStorage', () => {
  it('asks persist() first and snapshots into already-protected storage', async () => {
    const calls: string[] = [];
    let snapshotsWhenPersistRan = -1;

    vi.stubGlobal('navigator', {
      storage: {
        persisted: async () => false,
        persist: async () => {
          calls.push('persist');
          snapshotsWhenPersistRan = await db.backups.count();
          return true;
        },
        estimate: async () => ({ usage: 1234, quota: 5678 }),
      },
    });

    await seedTask();
    const result = await bootstrapStorage();

    expect(calls[0]).toBe('persist');
    expect(snapshotsWhenPersistRan).toBe(0); // no snapshot written before persist()
    expect(result.persistent).toBe(true);
    expect(result.backedUp).toBe(true);
    expect(result.usage).toBe(1234);
    expect(result.quota).toBe(5678);
    expect(await listBackups()).toHaveLength(1);
  });

  it('still snapshots when persist() never settles (timeout guard)', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persisted: async () => false,
        persist: () => new Promise<boolean>(() => {}), // hangs forever
        estimate: async () => ({ usage: 0, quota: 0 }),
      },
    });

    await seedTask();
    const result = await bootstrapStorage({ persistTimeoutMs: 5 });

    expect(result.persistent).toBe(false);
    expect(result.backedUp).toBe(true); // the snapshot was not held hostage
    expect(await listBackups()).toHaveLength(1);
  });

  it('reports usage 0/0 and still backs up when navigator.storage is absent', async () => {
    vi.stubGlobal('navigator', {});
    await seedTask();

    const result = await bootstrapStorage();

    expect(result).toEqual({
      backedUp: true,
      persistent: false,
      periodic: false,
      usage: 0,
      quota: 0,
    });
  });

  /**
   * A fresh install has an empty table at boot, so boot writes no snapshot and
   * (critically) does NOT stamp lastBackupAt. Without the first-task snapshot the
   * very first task a student types is unprotected until the next visit.
   */
  it('first task on a fresh install gets snapshotted immediately, exactly once', async () => {
    vi.stubGlobal('navigator', {}); // storage unsupported: worst case, no persist()

    // boot with an empty database — the real first-run situation
    const boot = await bootstrapStorage();
    expect(boot.backedUp).toBe(false);
    expect(await listBackups()).toHaveLength(0);

    const store = await import('../src/stores/tasks');
    const task = await store.useTaskStore.getState().create({ title: 'أول مهمة', priority: 'normal' });

    const snaps = await listBackups();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].count).toBe(1);
    // the snapshot must actually contain the task, not an empty envelope
    expect(await db.backups.get(snaps[0].id)).toMatchObject({ reason: 'on-open' });
    expect(task.title).toBe('أول مهمة');

    // a second create inside the same window must NOT pile on another snapshot
    await store.useTaskStore.getState().create({ title: 'ثاني مهمة', priority: 'normal' });
    expect(await listBackups()).toHaveLength(1);

    // an explicit "نسخة دابا" still works (manual is not interval-gated)
    expect((await backupTasks('manual')).id).not.toBeNull();
    expect(await listBackups()).toHaveLength(2);
  });

  it('a boot that already snapshotted makes the first-task hook a no-op', async () => {
    vi.stubGlobal('navigator', {});
    await seedTask();
    const boot = await bootstrapStorage();
    expect(boot.backedUp).toBe(true);
    expect(await listBackups()).toHaveLength(1);

    const store = await import('../src/stores/tasks');
    await store.useTaskStore.getState().create({ title: 'مهمة زيادة', priority: 'high' });

    // no second snapshot, and the live table really does hold both tasks — the
    // snapshot still reflects the moment it was taken, which is the contract.
    expect(await listBackups()).toHaveLength(1);
    expect(await db.tasks.count()).toBe(2);
    expect((await listBackups())[0].count).toBe(1);
  });
});
