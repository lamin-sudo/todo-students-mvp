import { useEffect, useMemo } from 'react';
import { useTaskStore } from '../stores/tasks';
import { selectTasks } from '../lib/stats';
import { setBadge } from '../lib/notifications';
import type { Tab } from '../App';

const PRIORITY_LABEL = { high: 'عالية', medium: 'متوسطة', normal: 'عادية' } as const;
const PRIORITY_CLASS = {
  high: 'bg-red-500/15 text-red-300 border-red-500/40',
  medium: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  normal: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
} as const;

const dtf = new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' });

export default function TaskList({ tab, subject }: { tab: Tab; subject: string }) {
  const tasks = useTaskStore((s) => s.tasks);
  const loading = useTaskStore((s) => s.loading);
  const error = useTaskStore((s) => s.error);
  const toggleDone = useTaskStore((s) => s.toggleDone);
  const remove = useTaskStore((s) => s.remove);

  const visible = useMemo(() => selectTasks(tasks, tab, subject), [tasks, tab, subject]);
  const overdueCount = useMemo(() => selectTasks(tasks, 'overdue', '').length, [tasks]);

  useEffect(() => {
    void setBadge(overdueCount);
  }, [overdueCount]);

  if (loading) return <p className="py-10 text-center text-slate-400">جاري التحميل…</p>;
  if (error) return <p className="card border-red-500/40 text-red-200">مشكل فالتخزين: {error}</p>;

  if (visible.length === 0) {
    return (
      <div className="card py-10 text-center text-slate-400">
        <p className="text-base">ما كاين حتى مهمة هنا</p>
        <p className="mt-1 text-sm">زيد مهمة جديدة بالزر اللي تحت 👇</p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {visible.map((t) => (
        <li key={t.id} className="card flex items-start gap-3 animate-fade-up">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5 accent-violet-600"
            checked={t.done}
            onChange={() => void toggleDone(t.id)}
            aria-label={`تمّت: ${t.title}`}
          />
          <div className="min-w-0 flex-1">
            <p className={`font-medium ${t.done ? 'text-slate-400 line-through' : ''}`}>{t.title}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              {t.subject && <span className="rounded-lg bg-surface-line/50 px-2 py-0.5">{t.subject}</span>}
              <span className={`rounded-lg border px-2 py-0.5 ${PRIORITY_CLASS[t.priority]}`}>
                {PRIORITY_LABEL[t.priority]}
              </span>
              {t.dueAt && <span className="text-slate-400">{dtf.format(new Date(t.dueAt))}</span>}
            </div>
          </div>
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-xs"
            onClick={() => void remove(t.id)}
            aria-label={`حذف: ${t.title}`}
          >
            حذف
          </button>
        </li>
      ))}
    </ul>
  );
}
