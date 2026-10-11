import { useEffect, useRef } from 'react';
import type { Settings } from '../lib/schemas';
import { useTaskStore } from '../stores/tasks';
import { dueReminders, notifyTask, notificationsSupported, setBadge } from '../lib/notifications';
import { selectTasks } from '../lib/stats';

/**
 * How often we re-check while the app is open. A `setInterval` in the page is
 * safe — unlike one inside the service worker, which the browser kills after
 * ~30s of inactivity. The periodic-sync path (backup) is separate and optional.
 */
const CHECK_EVERY_MS = 60_000;

/**
 * Deadline reminders + overdue badge for the tab bar / app icon.
 *
 * Both are feature-detected: on a browser without the triple Notification
 * support nothing is asked and nothing is shown, the badge silently no-ops.
 */
export function useReminders(settings: Settings): void {
  const tasks = useTaskStore((s) => s.tasks);
  const reminded = useRef<Set<string>>(new Set());

  // App icon badge = number of overdue tasks (Chromium; no-op elsewhere).
  useEffect(() => {
    void setBadge(selectTasks(tasks, 'overdue', '').length);
  }, [tasks]);

  useEffect(() => {
    if (!settings.remindersEnabled || !notificationsSupported()) return;

    const check = async () => {
      const due = dueReminders(tasks, new Date(), settings.reminderLeadMinutes, reminded.current);
      if (due.length === 0) return;
      // Mark BEFORE awaiting: a slow notification must not cause a double fire
      // on the next tick.
      for (const task of due) reminded.current.add(task.id);
      // Concurrently, not in a loop: one task whose notification stalls must
      // not block the reminders queued behind it.
      await Promise.all(due.map((task) => notifyTask(task)));
    };

    void check();
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [tasks, settings.remindersEnabled, settings.reminderLeadMinutes]);
}
