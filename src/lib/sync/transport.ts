import type { Task } from '../schemas';
import { taskToRow } from './rows';

/**
 * Push result per id, as `push_tasks` returns it.
 *
 * `applied: false` means "the server did not take your copy" — the client must
 * pull and reconcile. `updatedAt`/`revision` are null only when the row is not
 * visible to this user at all, which happens across users, never across two
 * devices of one account.
 */
export type PushResult = {
  id: string;
  updatedAt: string | null;
  revision: number | null;
  applied: boolean;
};

export type PushItem = { task: Task; op: 'upsert' | 'delete' };

export type PullPage = {
  /** raw rows as PostgREST returns them — parsed by `rowToTask`, never trusted */
  rows: unknown[];
  /** highest `updated_at` in this page; null when the page is empty */
  maxUpdatedAt: string | null;
};

/**
 * The network boundary, behind an interface.
 *
 * This exists so the engine can be tested with a fake transport: the merge,
 * backoff and conflict logic is where the bugs live, and none of it needs a
 * socket. `remoteTransport()` is the only implementation that talks to Supabase.
 */
export interface SyncTransport {
  push(items: PushItem[], userId: string): Promise<PushResult[]>;
  pull(since: string | null, limit: number): Promise<PullPage>;
  hardDelete(id: string): Promise<void>;
}

/** PostgREST caps a response; 500 keeps each round-trip small and resumable. */
export const PULL_PAGE_SIZE = 500;

/** Build the JSON payload `push_tasks(batch)` expects. */
export function toBatch(items: PushItem[], userId: string): Record<string, unknown>[] {
  return items.map(({ task, op }) => {
    const row = taskToRow(task, userId, op === 'delete' ? task.updatedAt : null);
    // `user_id` is intentionally NOT sent: the RPC stamps auth.uid(), and the
    // WITH CHECK policy would reject a foreign value anyway.
    const { user_id: _ignored, ...rest } = row;
    return rest;
  });
}
