/**
 * Reminder selection is pure on purpose: the fire-once bookkeeping lives in the
 * caller, so the "who gets a notification, and when" rule can be tested without
 * a browser, a service worker, or fake timers.
 */
import { describe, expect, it } from 'vitest';
import { dueReminders, REMINDER_GRACE_MS } from '../src/lib/notifications';
import type { Task } from '../src/lib/schemas';

const base = new Date('2026-03-10T12:00:00.000Z');
const iso = (msFromBase: number) => new Date(base.getTime() + msFromBase).toISOString();

const MIN = 60_000;
const HOUR = 60 * MIN;

function mk(over: Partial<Task> = {}): Task {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'مهمة',
    subject: '',
    dueAt: null,
    priority: 'normal',
    done: false,
    doneAt: null,
    createdAt: base.toISOString(),
    updatedAt: base.toISOString(),
    revision: 0,
    ...over,
  };
}

const noOne = new Set<string>();
const titles = (t: Task[]) => t.map((x) => x.title);

describe('dueReminders', () => {
  it('fires inside the lead window and not before it', () => {
    const soon = mk({ title: 'قريبة', dueAt: iso(90 * MIN) });
    const far = mk({ title: 'بعيدة', dueAt: iso(48 * HOUR) });
    expect(titles(dueReminders([soon, far], base, 120, noOne))).toEqual(['قريبة']);
    // tighten the lead to 60 minutes → the 90-minute task drops out
    expect(dueReminders([soon], base, 60, noOne)).toHaveLength(0);
  });

  it('still fires for a task whose deadline just passed (inside the grace window)', () => {
    const justMissed = mk({ title: 'فاتت', dueAt: iso(-2 * HOUR) });
    expect(titles(dueReminders([justMissed], base, 120, noOne))).toEqual(['فاتت']);
  });

  it('does not fire a storm of ancient overdue tasks on the first open', () => {
    const ancient = mk({ title: 'قديمة', dueAt: iso(-(REMINDER_GRACE_MS + HOUR)) });
    expect(dueReminders([ancient], base, 120, noOne)).toHaveLength(0);
    // exactly at the grace edge still counts
    const edge = mk({ title: 'على الحد', dueAt: iso(-REMINDER_GRACE_MS) });
    expect(titles(dueReminders([edge], base, 120, noOne))).toEqual(['على الحد']);
  });

  it('skips done, dateless, and already-reminded tasks', () => {
    const done = mk({ title: 'منجزة', dueAt: iso(10 * MIN), done: true, doneAt: base.toISOString() });
    const undated = mk({ title: 'بلا تاريخ' });
    const reminded = mk({ title: 'تنبّهت', dueAt: iso(10 * MIN) });
    const picked = dueReminders([done, undated, reminded], base, 120, new Set([reminded.id]));
    expect(picked).toHaveLength(0);
  });

  it('a zero lead still catches a task that is due right now', () => {
    const now = mk({ title: 'ضركا', dueAt: iso(0) });
    expect(titles(dueReminders([now], base, 0, noOne))).toEqual(['ضركا']);
  });

  it('ignores an unparseable date instead of throwing', () => {
    const broken = mk({ title: 'خايب', dueAt: 'ماشي تاريخ' });
    expect(dueReminders([broken], base, 120, noOne)).toHaveLength(0);
  });
});
