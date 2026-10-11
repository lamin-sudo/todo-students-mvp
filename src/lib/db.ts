import Dexie, { type Table } from 'dexie';
import type { BackupRecord, MetaRecord, Task, TaskInput } from './schemas';

export type { BackupRecord, MetaRecord, Task, TaskInput, Priority, ValidationReport } from './schemas';

export class TodoDB extends Dexie {
  tasks!: Table<Task, string>;
  backups!: Table<BackupRecord, string>;
  meta!: Table<MetaRecord, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      // index what we filter/sort by; title/subject are searched client-side
      tasks: 'id, dueAt, subject, priority, done, updatedAt, createdAt',
      backups: 'id, createdAt, reason',
      meta: 'key',
    });
  }

  /**
   * Guarantee that a failed write never masquerades as a successful one.
   * QuotaExceededError is surfaced to the caller so the UI can prune or warn.
   */
  async putTask(task: Task): Promise<Task> {
    try {
      await this.tasks.put(task);
      return task;
    } catch (err) {
      throw new StorageWriteError('putTask failed', err);
    }
  }
}

export class StorageWriteError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'StorageWriteError';
    this.cause = cause;
  }
  get isQuota(): boolean {
    return (
      this.cause instanceof DOMException &&
      (this.cause.name === 'QuotaExceededError' || this.cause.name === 'NS_ERROR_DOM_QUOTA_REACHED')
    );
  }
}

/**
 * Tests set `globalThis.__TODO_DB_NAME__` BEFORE importing this module so each
 * test file gets an isolated database; production always uses 'todo-students'.
 */
const DB_NAME: string =
  (globalThis as unknown as { __TODO_DB_NAME__?: string }).__TODO_DB_NAME__ ?? 'todo-students';
export const db = new TodoDB(DB_NAME);

export const nowIso = (): string => new Date().toISOString();
export const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : // deterministic-enough fallback for very old runtimes / test doubles
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });

/** Build a complete, schema-shaped task from partial input. Pure — no writes. */
export function newTask(input: TaskInput): Task {
  const t = nowIso();
  return {
    id: input.id ?? newId(),
    title: input.title,
    subject: input.subject ?? '',
    dueAt: input.dueAt ?? null,
    priority: input.priority ?? 'normal',
    done: input.done ?? false,
    doneAt: input.doneAt ?? null,
    createdAt: input.createdAt ?? t,
    updatedAt: input.updatedAt ?? t,
    revision: input.revision ?? 0,
  };
}

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key);
  return row === undefined ? fallback : (row.value as T);
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

/**
 * Ask the browser to make this origin persistent. Chromium may silently
 * return false; Safari/WebKit returns false with no prompt at all, so callers
 * must NOT tell the user "press here to retry" — see the Settings note.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
