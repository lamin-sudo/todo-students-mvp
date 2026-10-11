import { useState } from 'react';
import { useTaskStore } from '../stores/tasks';
import { TaskDraftSchema, type TaskDraft } from '../lib/schemas';

type Props = { onClose: () => void };

export default function TaskForm({ onClose }: Props) {
  const create = useTaskStore((s) => s.create);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const draft: TaskDraft = {
      title: String(fd.get('title') ?? ''),
      subject: String(fd.get('subject') ?? '') || undefined,
      dueAt: (String(fd.get('dueAt') ?? '') || undefined) as TaskDraft['dueAt'],
      priority: (String(fd.get('priority') ?? 'normal') as TaskDraft['priority']),
    };
    const parsed = TaskDraftSchema.safeParse(draft);
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((i) => i.message));
      return;
    }
    setErrors([]);
    setSubmitting(true);
    try {
      await create(parsed.data);
      form.reset();
      onClose();
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <form className="card w-full max-w-md space-y-4 animate-fade-up" onSubmit={handleSubmit}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">مهمة جديدة</h2>
          <button type="button" className="btn-ghost" onClick={onClose} aria-label="إغلاق">
            ✕
          </button>
        </div>

        <label className="block">
          <span className="mb-1 block text-sm">العنوان *</span>
          <input name="title" className="w-full rounded-xl border border-surface-line bg-surface px-3 py-2" placeholder="مثال: حل واجب الرياضيات" required />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm">المادة</span>
          <input name="subject" className="w-full rounded-xl border border-surface-line bg-surface px-3 py-2" placeholder="الرياضيات" />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm">تاريخ التسليم</span>
            <input name="dueAt" type="datetime-local" className="w-full rounded-xl border border-surface-line bg-surface px-3 py-2" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm">الأولوية</span>
            <select name="priority" defaultValue="normal" className="w-full rounded-xl border border-surface-line bg-surface px-3 py-2">
              <option value="high">عالية</option>
              <option value="medium">متوسطة</option>
              <option value="normal">عادية</option>
            </select>
          </label>
        </div>

        {errors.length > 0 && (
          <ul className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            إلغاء
          </button>
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? 'جاري الإضافة...' : 'إضافة'}
          </button>
        </div>
      </form>
    </div>
  );
}
