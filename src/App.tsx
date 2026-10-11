import { useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useTaskStore } from './stores/tasks';
import { useSettings } from './hooks/useSettings';
import TaskList from './components/TaskList';
import TaskForm from './components/TaskForm';
import Settings from './components/Settings';
import Stats from './components/Stats';

export type Tab = 'today' | 'week' | 'overdue' | 'done' | 'all';

const TABS: { key: Tab; label: string }[] = [
  { key: 'today', label: 'اليوم' },
  { key: 'week', label: 'هذا الأسبوع' },
  { key: 'overdue', label: 'متأخرة' },
  { key: 'done', label: 'منجزة' },
  { key: 'all', label: 'الكل' },
];

export default function App() {
  const load = useTaskStore((s) => s.load);
  const tasks = useTaskStore((s) => s.tasks);
  const { settings, setSettings } = useSettings();
  const [tab, setTab] = useState<Tab>('today');
  const [subject, setSubject] = useState<string>('');
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings.theme !== 'light');
  }, [settings.theme]);

  const subjects = useMemo(
    () => [...new Set(tasks.map((t) => t.subject).filter(Boolean))].sort(),
    [tasks],
  );

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-24 pt-6">
      <header className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">مهامي</h1>
          <p className="text-xs text-slate-400">تطبيق المهام للطلاب — خدام بلا أنترنيت</p>
        </div>
        <nav className="flex items-center gap-2">
          <NavLink to="/" className="btn-ghost">
            المهام
          </NavLink>
          <NavLink to="/stats" className="btn-ghost">
            إحصائيات
          </NavLink>
          <NavLink to="/settings" className="btn-ghost">
            الإعدادات
          </NavLink>
        </nav>
      </header>

      <Routes>
        <Route
          path="/"
          element={
            <>
              <div className="mb-3 flex flex-wrap gap-2">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={`btn ${tab === t.key ? 'bg-violet-600 text-white' : 'btn-ghost'}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {subjects.length > 0 && (
                <select
                  className="mb-4 w-full rounded-xl border border-surface-line bg-surface-soft px-3 py-2 text-sm"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                >
                  <option value="">كل المواد</option>
                  {subjects.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              )}

              <TaskList tab={tab} subject={subject} />

              <button type="button" className="btn-primary fixed bottom-6 left-1/2 -translate-x-1/2" onClick={() => setFormOpen(true)}>
                + مهمة جديدة
              </button>

              {formOpen && <TaskForm onClose={() => setFormOpen(false)} />}
            </>
          }
        />
        <Route path="/stats" element={<Stats />} />
        <Route
          path="/settings"
          element={<Settings settings={settings} onChange={setSettings} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
