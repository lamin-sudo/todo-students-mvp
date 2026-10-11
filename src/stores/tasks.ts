import { create } from 'zustand';
import { db, newTask, type TaskInput } from '../lib/db';
import type { Task, TaskDraft } from '../lib/schemas';
import { maybeSnapshotFirstTask, mergeTasks } from '../lib/backup';
import { enqueue, enqueueDelete, isArmed } from '../lib/sync/outbox';

/**
 * Queue a sync op without ever letting sync break the local write.
 *
 * The user's save already happened against IndexedDB; if the queue write fails
 * the task is still safe, and the next sign-in pushes the whole local history.
 */
async function queue(task: Task, op: 'upsert' | 'delete' = 'upsert'): Promise<void> {
  try {
    if (!(await isArmed())) return;
    if (op === 'delete') await enqueueDelete(task.id);
    else await enqueue(task);
  } catch {
    /* sync is optional; the local write is not */
  }
}

/**
 * Task store. Every mutation writes to IndexedDB then re-reads the affected
 * slice — IndexedDB is the source of truth, the store is a cache. Never derive
 * durable state from React memory alone (a closed tab would lose it).
 */
type State = {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  create: (draft: TaskDraft) => Promise<Task>;
  update: (id: string, patch: Partial<TaskInput>) => Promise<void>;
  toggleDone: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  replaceAll: (tasks: Task[]) => void;
};

/** `datetime-local` → ISO, or null when empty. */
export function draftToDueIso(dueAt: string | undefined): string | null {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const useTaskStore = create<State>((set, get) => ({
  tasks: [],
  loading: true,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const tasks = await db.tasks.toArray();
      set({ tasks, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  create: async (draft) => {
    const task = newTask({
      title: draft.title,
      subject: draft.subject ?? '',
      dueAt: draftToDueIso(draft.dueAt),
      priority: draft.priority,
    });
    await db.putTask(task);
    try {
      // First task of a fresh install: snapshot it now instead of on the next
      // visit. No-ops when boot (or a periodic ping) already snapshotted.
      await maybeSnapshotFirstTask();
    } catch {
      // a failed snapshot must never fail the save the user asked for
    }
    await queue(task);
    await get().load();
    return task;
  },

  update: async (id, patch) => {
    const current = await db.tasks.get(id);
    if (!current) return;
    const next: Task = {
      ...current,
      ...patch,
      id: current.id,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await db.putTask(next);
    await queue(next);
    await get().load();
  },

  toggleDone: async (id) => {
    const current = await db.tasks.get(id);
    if (!current) return;
    const done = !current.done;
    await get().update(id, { done, doneAt: done ? new Date().toISOString() : null });
  },

  remove: async (id) => {
    // read the row BEFORE deleting it: `enqueueDelete` needs the last synced
    // revision to build a tombstone the server will accept
    const current = await db.tasks.get(id);
    await db.tasks.delete(id);
    if (current) await queue(current, 'delete');
    await get().load();
  },

  /** Used after import/restore: recompute the cache from what the merge kept. */
  replaceAll: (tasks) => {
    const merged = mergeTasks(get().tasks, tasks);
    set({ tasks: merged.accepted });
  },
}));
