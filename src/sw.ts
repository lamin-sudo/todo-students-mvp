/// <reference lib="webworker" />
/**
 * Custom service worker (injectManifest strategy).
 *
 * Two jobs:
 *  1. Precache the app shell so the whole app works with zero network.
 *  2. Optionally receive a Periodic Background Sync ping ('weekly-backup') and
 *     ask open clients to trigger the internal snapshot.
 *
 * IMPORTANT: there is deliberately NO `setInterval` here. A service worker is
 * killed after ~30s idle, so any timer inside it dies with it and would give
 * the illusion of a working scheduler. The guaranteed trigger is the on-open
 * check in `lib/backup.ts`; this ping is a bonus for installed Chromium PWAs.
 */
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & {
  registration: ServiceWorkerRegistration & {
    periodicSync?: { getTags(): Promise<string[]>; register(tag: string, o: { minInterval: number }): Promise<void> };
  };
};

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

const BACKUP_TAG = 'weekly-backup';
const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

interface PeriodicSyncEvent extends ExtendableEvent {
  readonly tag: string;
}

self.addEventListener('periodicsync', (event: Event) => {
  const e = event as PeriodicSyncEvent;
  if (e.tag !== BACKUP_TAG) return;
  e.waitUntil(askClientsToBackup());
});

/** Ask every open client to run the (IndexedDB) backup; the SW cannot do it itself. */
async function askClientsToBackup(): Promise<void> {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clients) client.postMessage({ type: 'BACKUP_NOW', reason: 'periodic' });
}

/**
 * Tapping a reminder focuses an existing window instead of opening a second
 * one — on a phone that is the difference between "back to my tasks" and
 * "why do I have five copies of the app".
 */
self.addEventListener('notificationclick', (event: Event) => {
  const e = event as NotificationEvent;
  e.notification.close();
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      const existing = all[0];
      if (existing) return existing.focus();
      return self.clients.openWindow('/');
    })(),
  );
});

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event: Event) => {
  const e = event as ExtendableEvent;
  e.waitUntil(
    (async () => {
      // register the daily/periodic hint only if the API exists (Chromium, installed)
      try {
        const reg = self.registration;
        if (reg.periodicSync?.register) {
          const tags = await reg.periodicSync.getTags();
          if (!tags.includes(BACKUP_TAG)) {
            await reg.periodicSync.register(BACKUP_TAG, { minInterval: BACKUP_INTERVAL_MS });
          }
        }
      } catch {
        /* not installed / denied / low engagement — the on-open check covers it */
      }
      await self.clients.claim();
    })(),
  );
});
