/**
 * Install prompt — `beforeinstallprompt` is a one-shot event: if it fires
 * before we start listening, it is gone for that page load. So the listener is
 * registered at module load (imported from `main.tsx`) and the UI only reads the
 * captured event. iOS never fires it — that platform needs the manual A2HS hint.
 */
type BipEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let captured: BipEvent | null = null;
const listeners = new Set<(available: boolean) => void>();

function emit() {
  for (const fn of listeners) fn(captured !== null);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Stop Chrome's own mini-infobar; Settings/the hint drives the install.
    e.preventDefault();
    captured = e as BipEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    captured = null;
    emit();
  });
}

/** True when the browser handed us a prompt we can actually show. */
export function canPromptInstall(): boolean {
  return captured !== null;
}

export function subscribeInstall(fn: (available: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Show the real browser prompt. Never invent one when the event is absent. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!captured) return 'unavailable';
  const event = captured;
  captured = null; // the event is single-use
  emit();
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  } catch {
    return 'dismissed';
  }
}
