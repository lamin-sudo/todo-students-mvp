/**
 * Settings + notification feature-detect.
 *
 * The notification guard is the contract that keeps us from showing a
 * "permission granted" switch on a browser that can never deliver a
 * notification — so it is asserted here explicitly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.hoisted(() => {
  (globalThis as unknown as { __TODO_DB_NAME__?: string }).__TODO_DB_NAME__ =
    `todo-settings-${Math.random().toString(36).slice(2)}`;
});

import { db } from '../src/lib/db';
import { getSettings, setSettings } from '../src/lib/settings';
import { DEFAULT_SETTINGS } from '../src/lib/schemas';
import { notificationsSupported, permissionState } from '../src/lib/notifications';

beforeEach(async () => {
  await db.meta.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('settings (Zod-validated, defaults on corruption)', () => {
  it('returns defaults on a fresh database', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('persists a patch and ignores unknown keys', async () => {
    await setSettings({ theme: 'light', reminderLeadMinutes: 30 });
    const s = await getSettings();
    expect(s.theme).toBe('light');
    expect(s.reminderLeadMinutes).toBe(30);

    // a corrupted row (extra key / bad enum) must fall back to defaults
    await db.meta.put({ key: 'settings', value: { theme: 'neon', evil: true } });
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps out-of-range values back to the stored state', async () => {
    await setSettings({ reminderLeadMinutes: 120 });
    const next = await setSettings({ reminderLeadMinutes: 99999 });
    expect(next.reminderLeadMinutes).toBe(120);
  });
});

describe('notification feature-detect', () => {
  it('is false when any leg of the triple check is missing', () => {
    vi.stubGlobal('window', {});
    expect(notificationsSupported()).toBe(false);
    expect(permissionState()).toBe('unsupported');
  });

  it('requires Notification + serviceWorker + PushManager together', () => {
    vi.stubGlobal('window', { Notification: class {} });
    vi.stubGlobal('navigator', { serviceWorker: {} });
    // window.Notification + navigator.serviceWorker present, PushManager absent → still false
    expect(notificationsSupported()).toBe(false);

    // PushManager lives on `window` (not navigator) in every real browser
    vi.stubGlobal('window', { Notification: class {}, PushManager: class {} });
    vi.stubGlobal('navigator', { serviceWorker: {} });
    expect(notificationsSupported()).toBe(true);
  });
});
