/**
 * Settings live in the `meta` store (key = 'settings') and are validated by
 * the same Zod funnel as everything else. Unknown keys are rejected, so a
 * corrupted row falls back to defaults instead of leaking into the UI.
 */
import { getMeta, setMeta } from './db';
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from './schemas';

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const raw = await getMeta<unknown>(KEY, DEFAULT_SETTINGS);
  const parsed = SettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const merged = SettingsSchema.safeParse({ ...current, ...patch });
  const next = merged.success ? merged.data : current;
  await setMeta(KEY, next);
  return next;
}
