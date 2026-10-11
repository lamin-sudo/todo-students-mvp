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
import { listBackups } from '../src/lib/backup';

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
});
