/**
 * Notifications — feature-detected, never assumed.
 *
 * The guard is deliberately the full triple check: `Notification` alone is
 * not enough (some embedded webviews expose it without a usable
 * serviceWorker/PushManager pair), and asking for permission on a browser
 * that cannot deliver it produces a dead "granted" state.
 */
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

/** Show a reminder. Prefers the SW registration (works when the tab is hidden). */
export async function showReminder(title: string, body: string, tag: string): Promise<boolean> {
  if (!notificationsSupported() || Notification.permission !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, { body, tag, dir: 'rtl', lang: 'ar', icon: '/icons/icon-192.png' });
    return true;
  } catch {
    try {
      new Notification(title, { body, dir: 'rtl', lang: 'ar' });
      return true;
    } catch {
      return false;
    }
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
