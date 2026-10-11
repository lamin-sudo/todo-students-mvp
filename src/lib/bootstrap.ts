/**
 * One-time app bootstrap for the storage layer. Kept out of React so it can be
 * unit-tested and so it runs exactly once, before the first paint.
 *
 * Order:
 *  1. `requestPersistentStorage()` — asked FIRST so the very first snapshot is
 *     written into storage the browser has already been told not to evict.
 *     Bounded by a timeout: some engines never settle the promise, and a
 *     hanging `persist()` must never cost us the snapshot. Safari returns false
 *     silently and MUST NOT be presented as "press here to retry".
 *  2. `maybeAutoBackup()` — guaranteed weekly snapshot (all browsers, no perms).
 *  3. `registerPeriodicBackup()` — bonus for installed Chromium PWAs only.
 *
 * `main.tsx` calls this fire-and-forget (`void bootstrapStorage()`), so none of
 * it sits on the critical path: the first paint never waits for IndexedDB.
 */
import { db, requestPersistentStorage, storageEstimate } from './db';
import { maybeAutoBackup, registerPeriodicBackup } from './backup';

export type BootstrapResult = {
  backedUp: boolean;
  persistent: boolean;
  periodic: boolean;
  usage: number;
  quota: number;
};

/** How long we are willing to wait for `persist()` before snapshotting anyway. */
export const PERSIST_TIMEOUT_MS = 1500;

export type BootstrapOptions = {
  /** Override the `persist()` grace period (ms). Tests pass a tiny value. */
  persistTimeoutMs?: number;
};

function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export async function bootstrapStorage(opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  const result: BootstrapResult = { backedUp: false, persistent: false, periodic: false, usage: 0, quota: 0 };
  const persistTimeoutMs = opts.persistTimeoutMs ?? PERSIST_TIMEOUT_MS;

  try {
    result.persistent = await settleWithin(requestPersistentStorage(), persistTimeoutMs, false);
  } catch {
    /* ignore */
  }

  try {
    result.backedUp = await maybeAutoBackup();
  } catch {
    /* a failed snapshot must never break the app; Settings surfaces it later */
  }

  try {
    result.periodic = await registerPeriodicBackup();
  } catch {
    /* ignore */
  }

  const est = await storageEstimate();
  if (est) {
    result.usage = est.usage;
    result.quota = est.quota;
  }

  return result;
}

/**
 * The service worker cannot own the backup — it is killed after ~30s idle and
 * has no access to the app's Dexie instance. So on a periodic-sync ping it asks
 * an open client to do the snapshot; without this listener that ping is a dead
 * end. Safe to call more than once and harmless when the ping never arrives.
 */
export function listenForBackupRequests(): () => void {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return () => {};
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string } | null;
    if (data?.type !== 'BACKUP_NOW') return;
    // gated by lastBackupAt inside, so a ping storm cannot duplicate snapshots
    void maybeAutoBackup();
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}

/** Wipe everything (Settings → "حذف كل الداتا"). */
export async function wipeAllData(): Promise<void> {
  await db.transaction('rw', db.tasks, db.backups, db.meta, async () => {
    await Promise.all([db.tasks.clear(), db.backups.clear(), db.meta.clear()]);
  });
}
