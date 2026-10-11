import { useCallback, useEffect, useState } from 'react';
import { getSettings, setSettings } from '../lib/settings';
import { DEFAULT_SETTINGS, type Settings } from '../lib/schemas';

/** Load persisted settings once, then keep them in sync on every change. */
export function useSettings() {
  const [settings, setState] = useState<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void getSettings().then((s) => {
      setState(s);
      setReady(true);
    });
  }, []);

  const update = useCallback(async (patch: Partial<Settings>) => {
    const next = await setSettings(patch);
    setState(next);
  }, []);

  return { settings, setSettings: update, ready };
}
