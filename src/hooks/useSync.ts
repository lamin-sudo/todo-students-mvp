import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  armSync,
  disarmSync,
  isArmed,
  outboxStats,
  retryAllNow,
  getLastSyncAt,
} from '../lib/sync/outbox';
import { bootstrapRemote, syncNow as runSyncNow } from '../lib/sync/engine';
import {
  currentEmail,
  currentUserId,
  getClient,
  onAuthChange,
  remoteTransport,
  sendMagicLink,
  signOut as authSignOut,
  syncConfigured,
} from '../lib/sync/client';

export type SyncState = {
  /** false = the build had no VITE_SUPABASE_*: the feature is ABSENT, not broken */
  configured: boolean;
  email: string | null;
  connected: boolean;
  online: boolean;
  pending: number;
  parked: number;
  lastSyncAt: string | null;
  syncing: boolean;
  message: string | null;
  error: string | null;
  booted: boolean;
};

/**
 * Module-level store, not per-component state.
 *
 * `Settings` and `SyncBanner` both want this, and two hook instances would mean
 * two auth listeners and two syncs racing on the same outbox. One store, one
 * subscription, one sync at a time.
 */
let state: SyncState = {
  configured: syncConfigured(),
  email: null,
  connected: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pending: 0,
  parked: 0,
  lastSyncAt: null,
  syncing: false,
  message: null,
  error: null,
  booted: false,
};

const listeners = new Set<() => void>();

function set(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const snapshot = () => state;

let inFlight = false;
let started = false;

async function refreshCounters() {
  const [stats, last, armed, uid] = await Promise.all([
    outboxStats(),
    getLastSyncAt(),
    isArmed(),
    currentUserId(),
  ]);
  set({
    connected: armed && uid !== null,
    // only ask the auth client for the email when there is actually a session
    email: uid ? await currentEmail() : null,
    pending: stats.pending,
    parked: stats.parked,
    lastSyncAt: last,
  });
}

async function run({ quiet = false }: { quiet?: boolean } = {}) {
  if (!state.configured || inFlight) return;
  const uid = await currentUserId();
  if (!uid) return;
  inFlight = true;
  set({ syncing: true, error: null });
  try {
    const res = await runSyncNow(remoteTransport(getClient), uid);
    const written = res.pulled.reduce((n, p) => n + p.written, 0);
    const removed = res.pulled.reduce((n, p) => n + p.removed, 0);
    set({
      syncing: false,
      message: quiet
        ? state.message
        : `زامن: ${res.flush.settled} مصيفّط · ${written} تنزّل · ${removed} تحيّد` +
          (res.flush.conflicts.length ? ` · ${res.flush.conflicts.length} صراع` : ''),
      // only a TOTAL failure is worth alarming about; a partial one retries
      error: res.flush.failed > 0 && res.flush.settled === 0 ? 'المزامنة فشلت — غادي نعاودو' : null,
    });
  } catch (e) {
    set({ syncing: false, error: e instanceof Error ? e.message : String(e) });
  } finally {
    inFlight = false;
    try {
      await refreshCounters();
    } catch {
      /* a status read must never break the settings screen */
    }
  }
}

/**
 * Runs once per page load. Everything is inert without env vars:
 * `syncConfigured()` is false, `getClient()` returns null before importing
 * anything, and `@supabase/supabase-js` is never downloaded.
 */
function boot() {
  if (started) return;
  started = true;
  if (!state.configured) {
    set({ booted: true });
    return;
  }

  window.addEventListener('online', () => {
    set({ online: true });
    void run();
  });
  window.addEventListener('offline', () => set({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void run();
  });

  void (async () => {
    try {
      const uid = await currentUserId();
      if (uid) {
        if (!(await isArmed())) {
          await armSync(uid);
          // the remote decides: an account that already has rows wins (pull),
          // an empty one takes this device's history (push)
          await bootstrapRemote(remoteTransport(getClient), uid);
        }
        await run({ quiet: true });
      }
      await refreshCounters();
      await onAuthChange(() => {
        // the magic-link redirect lands here: arm, bootstrap, then sync
        void (async () => {
          try {
            const id = await currentUserId();
            if (id && !(await isArmed())) {
              await armSync(id);
              await bootstrapRemote(remoteTransport(getClient), id);
            }
            await refreshCounters();
            await run({ quiet: true });
          } catch {
            /* the next trigger retries */
          }
        })();
      });
    } catch {
      /* being offline at boot is normal, not an error worth showing */
    } finally {
      set({ booted: true });
    }
  })();
}

/** Debounce a queued edit into a push, without polling on a timer. */
let debounce: ReturnType<typeof setTimeout> | null = null;
function scheduleFlush() {
  if (!state.configured || state.pending === 0 || state.syncing) return;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => void run({ quiet: true }), 2500);
}

export function useSync() {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    boot();
  }, []);

  useEffect(() => {
    scheduleFlush();
    return () => {
      if (debounce) clearTimeout(debounce);
    };
  }, [s.pending, s.syncing]);

  const signIn = useCallback(async (email: string) => {
    const res = await sendMagicLink(email);
    set(
      res.ok
        ? { message: 'صيفطنا ليك رابط الدخول — شوف الإيميل.', error: null }
        : { error: res.message ?? 'فشل', message: null },
    );
    return res;
  }, []);

  /**
   * Session only. IndexedDB — tasks AND the pending outbox — is deliberately
   * kept: it is the user's data, and signing out must not lose a single task.
   * Disarming only stops new ops from being queued.
   */
  const signOut = useCallback(async () => {
    await authSignOut();
    await disarmSync();
    set({ connected: false, email: null, message: 'خارج. الداتا المحلية والعمليات المعلّقة بقاو.' });
    await refreshCounters();
  }, []);

  /** A manual press also clears the backoff: "I know, try again now". */
  const syncNow = useCallback(async () => {
    await retryAllNow();
    await run();
  }, []);

  const refresh = useCallback(async () => {
    await refreshCounters();
  }, []);

  return { state: s, signIn, signOut, syncNow, refresh };
}
