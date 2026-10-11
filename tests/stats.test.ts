/**
 * Pure logic tests for the stats/filter layer — no IndexedDB involved.
 * These guard the tab semantics (today / week / overdue) and the streak math,
 * which are the parts most likely to silently drift.
 */
import { describe, expect, it } from 'vitest';
import {
  bucket,
  doneThisWeek,
  progressBySubject,
  selectTasks,
  sortTasks,
  streakDays,
} from '../src/lib/stats';
import type { Task } from '../src/lib/schemas';

const iso = (d: Date) => d.toISOString();
const base = new Date('2026-03-10T12:00:00.000Z'); // a Tuesday, local noon-ish

function mk(over: Partial<Task> = {}): Task {
  return {
    id: crypto.randomUUID(),
    title: 'مهمة',
    subject: 'رياضيات',
    dueAt: null,
    priority: 'normal',
    done: false,
    doneAt: null,
    createdAt: iso(base),
    updatedAt: iso(base),
    revision: 0,
    ...over,
  };
}

const at = (days: number, hour = 10) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return iso(d);
};

describe('tabs', () => {
  const tasks = [
    mk({ title: 'متأخرة', dueAt: at(-2) }),
    mk({ title: 'اليوم', dueAt: at(0, 23) }),
    mk({ title: 'هاد الأسبوع', dueAt: at(3) }),
    mk({ title: 'بعيدة', dueAt: at(30) }),
    mk({ title: 'بلا تاريخ' }),
    mk({ title: 'منجزة', dueAt: at(1), done: true, doneAt: at(-1) }),
  ];

  it('overdue excludes tasks due later today', () => {
    const overdue = selectTasks(tasks, 'overdue', '', base).map((t) => t.title);
    expect(overdue).toEqual(['متأخرة']);
  });

  it('today includes anything due before end of today, done ones excluded', () => {
    const today = selectTasks(tasks, 'today', '', base).map((t) => t.title);
    expect(today.sort()).toEqual(['اليوم', 'متأخرة'].sort());
  });

  it('week only holds the remainder of the next 7 days', () => {
    const week = selectTasks(tasks, 'week', '', base).map((t) => t.title);
    expect(week).toEqual(['هاد الأسبوع']);
  });

  /**
   * The `done` row deliberately carries NO due date: a weak fixture that gives
   * it a deadline still passes when the implementation forgets `!t.done`,
   * because the deadline alone keeps it out. Only a done task that is ALSO
   * undated can catch that bug.
   */
  it('undated holds open tasks without a due date only', () => {
    const list = [
      mk({ title: 'بلا تاريخ' }),
      mk({ title: 'منجزة بلا تاريخ', done: true, doneAt: at(-1) }),
      mk({ title: 'بكرة', dueAt: at(1) }),
    ];
    expect(bucket(list, base).undated.map((t) => t.title)).toEqual(['بلا تاريخ']);
  });

  it('undated is a subset of open — it never steals from today/week/overdue', () => {
    const b = bucket(tasks, base);
    const openTitles = [...b.today, ...b.week, ...b.overdue].map((t) => t.title);
    expect(openTitles).not.toContain('بلا تاريخ');
    expect(b.undated.map((t) => t.title)).toEqual(['بلا تاريخ']);
    // and the tab is reachable through the same selector the UI uses
    expect(selectTasks(tasks, 'undated', '', base).map((t) => t.title)).toEqual(['بلا تاريخ']);
  });

  it('undated respects the subject filter', () => {
    const list = [mk({ title: 'بلا تاريخ', subject: 'رياضيات' }), mk({ title: 'بلا تاريخ', subject: 'فيزيك' })];
    expect(selectTasks(list, 'undated', 'فيزيك', base).map((t) => t.title)).toEqual(['بلا تاريخ']);
  });

  /**
   * The other direction: a done task that is re-opened must come BACK to
   * `undated`. Guards against a one-way filter that drops dateless tasks
   * permanently once they have been checked off.
   */
  it('re-opening a dateless task returns it to undated', () => {
    const finished = mk({ title: 'رجعت', done: true, doneAt: at(-1), dueAt: null });
    expect(bucket([finished], base).undated).toHaveLength(0);

    const reopened: Task = { ...finished, done: false, doneAt: null };
    expect(bucket([reopened], base).undated.map((t) => t.title)).toEqual(['رجعت']);
  });

  it('filters by subject without dropping the tab semantics', () => {
    const onlyArabic = mk({ title: 'إنجليزي', subject: 'إنجليزية', dueAt: at(0, 20) });
    const list = [...tasks, onlyArabic];
    expect(selectTasks(list, 'today', 'إنجليزية', base).map((t) => t.title)).toEqual(['إنجليزي']);
  });

  it('sorts undone before done, then by due date', () => {
    const sorted = sortTasks([mk({ done: true, dueAt: at(-9) }), mk({ title: 'ب', dueAt: at(9) }), mk({ title: 'أ', dueAt: at(1) })]);
    expect(sorted.map((t) => t.title)).toEqual(['أ', 'ب', 'مهمة']);
  });
});

describe('progress + streak', () => {
  it('computes per-subject progress and labels the subject-less bucket', () => {
    const rows = progressBySubject([
      mk({ subject: 'رياضيات', done: true }),
      mk({ subject: 'رياضيات' }),
      mk({ subject: '' }),
    ]);
    expect(rows).toEqual([
      { subject: 'رياضيات', done: 1, total: 2 },
      { subject: 'بلا مادة', done: 0, total: 1 },
    ]);
  });

  it('counts only completions since the start of the current week', () => {
    expect(doneThisWeek([mk({ done: true, doneAt: at(0) }), mk({ done: true, doneAt: at(-30) })], base)).toBe(1);
  });

  it('a streak survives a day that is not over yet, and breaks on a gap', () => {
    const t = (days: number) => mk({ done: true, doneAt: at(days) });
    expect(streakDays([t(0), t(-1), t(-2)], base)).toBe(3);
    // nothing done today, but yesterday+2 days before → streak still counts as of yesterday
    expect(streakDays([t(-1), t(-2)], base)).toBe(2);
    // a gap kills it
    expect(streakDays([t(-2), t(-3)], base)).toBe(0);
    expect(streakDays([], base)).toBe(0);
  });

  it('bucket() keeps the raw list intact for the "all" tab', () => {
    const list = [mk({ dueAt: at(-1) }), mk({ done: true })];
    expect(bucket(list, base).all).toHaveLength(2);
  });
});
