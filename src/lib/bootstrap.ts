/**
 * One-time app bootstrap for the storage layer. Kept out of React so it can be
 * unit-tested and so it runs exactly once, before the first paint.
 *
 * Order:
 *  1. `maybeAutoBackup()` — guaranteed weekly snapshot (all browsers, no perms).
 *  2. `requestPersistentStorage()` — Chromium may say yes; Safari returns false
 *     silently and MUST NOT be presented as "press here to retry".
 *  3. `registerPeriodicBackup()` — bonus for installed Chromium PWAs only.
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

export async function bootstrapStorage(): Promise<BootstrapResult> {
  const result: BootstrapResult = { backedUp: false, persistent: false, periodic: false, usage: 0, quota: 0 };

  try {
    result.backedUp = await maybeAutoBackup();
  } catch {
    /* a failed snapshot must never break the app; Settings surfaces it later */
  }

  try {
    result.persistent = await requestPersistentStorage();
  } catch {
    /* ignore */
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

/** Wipe everything (Settings → "حذف كل الداتا"). */
export async function wipeAllData(): Promise<void> {
  await db.transaction('rw', db.tasks, db.backups, db.meta, async () => {
    await Promise.all([db.tasks.clear(), db.backups.clear(), db.meta.clear()]);
  });
}
