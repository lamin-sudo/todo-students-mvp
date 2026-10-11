import { useEffect, useState } from 'react';
import type { Settings } from '../lib/schemas';
import { canPromptInstall, promptInstall, subscribeInstall } from '../lib/install';
import { isIos, isStandalone } from '../lib/notifications';

type Props = {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => Promise<void> | void;
};

/**
 * Install hint.
 *
 * Two different realities, never mixed up:
 *  - Chromium fires `beforeinstallprompt` → we offer a button that opens the
 *    REAL prompt (the event is single-use, so it is consumed on click).
 *  - iOS never fires it, and `persist()` there returns false without asking, so
 *    the only real protection against ITP's 7-day wipe is Add-to-Home-Screen.
 *    We therefore show instructions — never a button that pretends to "retry".
 */
export default function InstallBanner({ settings, onChange }: Props) {
  const [available, setAvailable] = useState(() => canPromptInstall());
  const [installed] = useState(() => isStandalone());
  const [ios] = useState(() => isIos());
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => subscribeInstall(setAvailable), []);

  if (installed || settings.installedHintDismissed) return null;
  if (!available && !ios) return null;

  async function dismiss() {
    await onChange({ installedHintDismissed: true });
  }

  return (
    <div className="card mb-4 flex items-start gap-3 border-violet-500/40 bg-violet-500/10 text-sm animate-fade-up">
      <div className="min-w-0 flex-1">
        {available ? (
          <>
            <p className="font-medium">ثبّت «مهامي» على جهازك</p>
            <p className="mt-1 text-xs text-slate-300">
              التطبيق المثبّت كيخدم بلا أنترنيت وكيحفظ الداتا بلا ما يمسحها المتصفح تلقائياً.
            </p>
            <button
              type="button"
              className="btn-primary mt-2"
              onClick={async () => {
                const outcome = await promptInstall();
                if (outcome === 'accepted') {
                  await onChange({ installedHintDismissed: true });
                } else {
                  setNotice('ما تمّش التثبيت — تقدر تعاود من قائمة المتصفح.');
                }
              }}
            >
              تثبيت التطبيق
            </button>
          </>
        ) : (
          <>
            <p className="font-medium">ثبّت «مهامي» على الشاشة الرئيسية</p>
            <p className="mt-1 text-xs text-slate-300">
              فـ iPhone/iPad: <strong>شارك ⤴ ← إضافة إلى الشاشة الرئيسية</strong>. بلا هاد الخطوة،
              Safari كيقدر يمسح المهام من بعد 7 أيام بلا استعمال.
            </p>
          </>
        )}
        {notice && <p className="mt-2 text-xs text-amber-300">{notice}</p>}
      </div>
      <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => void dismiss()}>
        خفي
      </button>
    </div>
  );
}
