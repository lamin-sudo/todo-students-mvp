import type { Task } from './schemas';
import type { Tab } from '../App';

export type Buckets = {
  today: Task[];
  week: Task[];
  overdue: Task[];
  done: Task[];
  all: Task[];
};

/** Local midnight boundaries — "today" is the user's day, not UTC. */
export function startOfToday(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfToday(now = new Date()): Date {
  const d = startOfToday(now);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function endOfWeek(now = new Date()): Date {
  const d = endOfToday(now);
  d.setDate(d.getDate() + 7);
  return d;
}

const PRIORITY_WEIGHT: Record<Task['priority'], number> = { high: 0, medium: 1, normal: 2 };

/** Open tasks first, then by due date, then by priority. */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ad = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
    const bd = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
  });
}

export function bucket(tasks: Task[], now = new Date()): Buckets {
  const todayEnd = endOfToday(now).getTime();
  const weekEnd = endOfWeek(now).getTime();
  const open = tasks.filter((t) => !t.done);

  return {
    today: open.filter((t) => t.dueAt !== null && Date.parse(t.dueAt) <= todayEnd),
    week: open.filter((t) => t.dueAt !== null && Date.parse(t.dueAt) > todayEnd && Date.parse(t.dueAt) <= weekEnd),
    overdue: open.filter((t) => t.dueAt !== null && Date.parse(t.dueAt) < startOfToday(now).getTime()),
    done: tasks.filter((t) => t.done),
    all: tasks,
  };
}

export function selectTasks(tasks: Task[], tab: Tab, subject: string, now = new Date()): Task[] {
  const filtered = subject ? tasks.filter((t) => t.subject === subject) : tasks;
  const buckets = bucket(filtered, now);
  if (tab === 'overdue') return sortTasks(buckets.overdue);
  return sortTasks(buckets[tab]);
}

/** Per-subject progress: done / (done + open). */
export function progressBySubject(tasks: Task[]): { subject: string; done: number; total: number }[] {
  const map = new Map<string, { done: number; total: number }>();
  for (const t of tasks) {
    const key = t.subject.trim() || 'بلا مادة';
    const cur = map.get(key) ?? { done: 0, total: 0 };
    cur.total += 1;
    if (t.done) cur.done += 1;
    map.set(key, cur);
  }
  return [...map.entries()]
    .map(([subject, v]) => ({ subject, ...v }))
    .sort((a, b) => b.total - a.total);
}

/** How many tasks were completed since the start of the current week. */
export function doneThisWeek(tasks: Task[], now = new Date()): number {
  const from = startOfToday(now);
  from.setDate(from.getDate() - from.getDay());
  return tasks.filter((t) => t.doneAt !== null && Date.parse(t.doneAt) >= from.getTime()).length;
}

/**
 * Daily streak: consecutive days (ending today or yesterday) with >=1 task
 * completed. Uses LOCAL dates so a task finished at 23:30 counts for that day.
 */
export function streakDays(tasks: Task[], now = new Date()): number {
  const days = new Set(
    tasks
      .filter((t) => t.doneAt !== null)
      .map((t) => {
        const d = new Date(t.doneAt as string);
        return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      }),
  );
  if (days.size === 0) return 0;

  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const cursor = startOfToday(now);
  if (!days.has(key(cursor))) {
    // the streak is allowed to be "as of yesterday" until today ends
    cursor.setDate(cursor.getDate() - 1);
    if (!days.has(key(cursor))) return 0;
  }

  let streak = 0;
  while (days.has(key(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
