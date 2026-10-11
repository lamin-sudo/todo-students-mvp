/**
 * Notifications — feature-detected, never assumed.
 *
 * The guard is deliberately the full triple check: `Notification` alone is
 * not enough (some embedded webviews expose it without a usable
 * serviceWorker/PushManager pair), and asking for permission on a browser
 * that cannot deliver it produces a dead "granted" state.
 */
import type { Task } from './schemas';

export function notificationsSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

/** `Notification.permission` when supported, else 'unsupported'. */
export function permissionState(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

/** Ask once. Returns the resulting state; never throws. */
export async function ensurePermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** How long to wait for an active service worker before using the fallback. */
export const SW_READY_TIMEOUT_MS = 1500;

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Show a reminder. Prefers the SW registration (works when the tab is hidden),
 * but `navigator.serviceWorker.ready` NEVER settles when no worker is
 * registered — a dev server, or a browser that blocked registration — so it is
 * bounded by a timeout instead of awaited blindly. Without the bound the
 * promise hangs forever and the constructor fallback never gets a chance.
 */
export async function showReminder(title: string, body: string, tag: string): Promise<boolean> {
  if (!notificationsSupported() || Notification.permission !== 'granted') return false;
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    const reg = await settleWithin(navigator.serviceWorker.ready, SW_READY_TIMEOUT_MS);
    if (reg) {
      try {
        await reg.showNotification(title, { body, tag, dir: 'rtl', lang: 'ar', icon: '/icons/icon-192.png' });
        return true;
      } catch {
        /* fall through to the constructor form */
      }
    }
  }
  try {
    new Notification(title, { body, dir: 'rtl', lang: 'ar' });
    return true;
  } catch {
    return false;
  }
}

/** Overdue count for the app badge (Chromium only, silent no-op elsewhere). */
export async function setBadge(count: number): Promise<boolean> {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    if (count > 0 && nav.setAppBadge) {
      await nav.setAppBadge(count);
      return true;
    }
    if (count === 0 && nav.clearAppBadge) {
      await nav.clearAppBadge();
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * True only when the app is (or can be) installed. On iOS this is the ONLY
 * real mitigation against ITP's 7-day storage wipe, so Settings shows an
 * A2HS hint instead of a fake "retry persist()" button.
 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (
    navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
  );
}

/**
 * Reminders that are due now: open, has a deadline, inside the lead window
 * (`dueAt - now <= leadMinutes`) and not stale.
 *
 * The lower bound matters: on a first open after a long absence every ancient
 * overdue task would otherwise fire at once. Anything older than
 * `REMINDER_GRACE_MS` is left to the badge + the "متأخرة" tab instead of
 * becoming a notification storm. Pure — the caller owns `alreadyReminded`,
 * which is what makes it testable.
 */
export const REMINDER_GRACE_MS = 24 * 60 * 60 * 1000;

export function dueReminders(
  tasks: Task[],
  now: Date,
  leadMinutes: number,
  alreadyReminded: ReadonlySet<string>,
): Task[] {
  const leadMs = Math.max(0, leadMinutes) * 60_000;
  const t = now.getTime();
  return tasks.filter((task) => {
    if (task.done || task.dueAt === null) return false;
    if (alreadyReminded.has(task.id)) return false;
    const due = Date.parse(task.dueAt);
    if (Number.isNaN(due)) return false;
    return due - t <= leadMs && due >= t - REMINDER_GRACE_MS;
  });
}

const reminderDtf = new Intl.DateTimeFormat('ar', { dateStyle: 'short', timeStyle: 'short' });

/** One reminder for one task, rendered through the service worker. */
export async function notifyTask(task: Task): Promise<boolean> {
  const when = task.dueAt ? reminderDtf.format(new Date(task.dueAt)) : '';
  const body = when ? `التسليم: ${when}` : 'بلا تاريخ تسليم';
  return showReminder(`تذكير: ${task.title}`, body, `task-${task.id}`);
}
