import { useEffect, useMemo, useState } from 'react';
import { useTaskStore } from '../stores/tasks';
import { doneThisWeek, progressBySubject, streakDays } from '../lib/stats';

export default function Stats() {
  const tasks = useTaskStore((s) => s.tasks);
  const [week, setWeek] = useState(0);
  const [streak, setStreak] = useState(0);

  const subjects = useMemo(() => progressBySubject(tasks), [tasks]);
  const overall = useMemo(() => {
    const done = tasks.filter((t) => t.done).length;
    return { done, total: tasks.length, pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0 };
  }, [tasks]);

  useEffect(() => {
    setWeek(doneThisWeek(tasks));
    setStreak(streakDays(tasks));
  }, [tasks]);

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="card text-center">
          <p className="text-2xl font-bold">{overall.done}</p>
          <p className="text-xs text-slate-400">منجزة</p>
        </div>
        <div className="card text-center">
          <p className="text-2xl font-bold">{week}</p>
          <p className="text-xs text-slate-400">هاد الأسبوع</p>
        </div>
        <div className="card text-center">
          <p className="text-2xl font-bold">🔥 {streak}</p>
          <p className="text-xs text-slate-400">أيام متتالية</p>
        </div>
      </div>

      <div className="card">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span>التقدم العام</span>
          <span className="text-slate-400">
            {overall.done}/{overall.total} ({overall.pct}%)
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface-line">
          <div className="h-full rounded-full bg-violet-500 transition-all" style={{ width: `${overall.pct}%` }} />
        </div>
      </div>

      <div className="card space-y-3">
        <h2 className="text-sm font-semibold">التقدم حسب المادة</h2>
        {subjects.length === 0 && <p className="text-sm text-slate-400">ما كاين حتى مادة بعد.</p>}
        {subjects.map((s) => {
          const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
          return (
            <div key={s.subject}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span>{s.subject}</span>
                <span className="text-slate-400">
                  {s.done}/{s.total}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-surface-line">
                <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
