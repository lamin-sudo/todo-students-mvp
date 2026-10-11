import type { SupabaseClient } from '@supabase/supabase-js';
import { PULL_PAGE_SIZE, toBatch, type PullPage, type PushItem, type PushResult, type SyncTransport } from './transport';

/**
 * Whether sync is even configured.
 *
 * Empty string is a valid "not configured" value, NOT a missing variable: a
 * missing `import.meta.env` key in a build would otherwise make the module
 * explode at import time. Everything downstream checks this first, so a build
 * with no Supabase env stays a pure offline app.
 */
export const SUPABASE_URL: string = import.meta.env?.VITE_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY: string = import.meta.env?.VITE_SUPABASE_ANON_KEY ?? '';

export function syncConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}

let client: SupabaseClient | null = null;

/**
 * Lazy, and loaded with a dynamic `import()` so `@supabase/supabase-js` is a
 * SEPARATE chunk: without env vars it is never downloaded, and the offline
 * bundle and its 45 tests are untouched. (A static import would put ~40 kB of
 * auth client into the critical path of an app whose whole point is offline.)
 */
export async function getClient(): Promise<SupabaseClient | null> {
  if (!syncConfigured()) return null;
  if (client) return client;
  const { createClient } = await import('@supabase/supabase-js');
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true, // magic-link redirect lands back here
    },
  });
  return client;
}

/** The only implementation of `SyncTransport` that touches the network. */
export function remoteTransport(get: () => Promise<SupabaseClient | null>): SyncTransport {
  return {
    async push(items: PushItem[], userId: string): Promise<PushResult[]> {
      const sb = await get();
      if (!sb) return [];
      const { data, error } = await sb.rpc('push_tasks', { batch: toBatch(items, userId) });
      if (error) throw new Error(`push_tasks: ${error.message}`);
      return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        updatedAt: (r.updated_at as string | null) ?? null,
        revision: (r.revision as number | null) ?? null,
        applied: Boolean(r.applied),
      }));
    },

    async pull(since: string | null, limit = PULL_PAGE_SIZE): Promise<PullPage> {
      const sb = await get();
      if (!sb) return { rows: [], maxUpdatedAt: null };
      let q = sb
        .from('tasks')
        .select('*')
        .order('updated_at', { ascending: true })
        .limit(limit);
      if (since) q = q.gt('updated_at', since);
      const { data, error } = await q;
      if (error) throw new Error(`pull: ${error.message}`);
      const rows = (data ?? []) as unknown[];
      const times = rows
        .map((r) => (r as Record<string, unknown>).updated_at)
        .filter((v): v is string => typeof v === 'string');
      return { rows, maxUpdatedAt: times.length ? times.reduce((a, b) => (a > b ? a : b)) : null };
    },

    async hardDelete(id: string): Promise<void> {
      const sb = await get();
      if (!sb) return;
      const { error } = await sb.from('tasks').delete().eq('id', id);
      // A 0-row delete is not an error: RLS filtered it because it was never
      // there (already deleted, or created on a device that never pushed it).
      if (error) throw new Error(`delete: ${error.message}`);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

export async function sendMagicLink(email: string): Promise<{ ok: boolean; message?: string }> {
  const sb = await getClient();
  if (!sb) return { ok: false, message: 'المزامنة ماشي مفعّلة' };
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${window.location.origin}/settings` },
  });
  return error ? { ok: false, message: error.message } : { ok: true };
}

export async function signOut(): Promise<void> {
  const sb = await getClient();
  // Session only. IndexedDB is NEVER wiped on sign-out — the local data is the
  // user's, and losing it because they logged out would be unforgivable.
  await sb?.auth.signOut();
}

export async function currentUserId(): Promise<string | null> {
  const sb = await getClient();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.user.id ?? null;
}

export async function currentEmail(): Promise<string | null> {
  const sb = await getClient();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.user.email ?? null;
}

export async function onAuthChange(cb: () => void): Promise<() => void> {
  const sb = await getClient();
  if (!sb) return () => {};
  const { data } = sb.auth.onAuthStateChange(() => cb());
  return () => data.subscription.unsubscribe();
}
