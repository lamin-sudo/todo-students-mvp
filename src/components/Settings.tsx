import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Settings as SettingsType } from '../lib/schemas';
import type { ValidationReport } from '../lib/schemas';
import { exportTasks, importTasks, listBackups, backupTasks, restoreFromBackup } from '../lib/backup';
import { storageEstimate, requestPersistentStorage } from '../lib/db';
import { wipeAllData } from '../lib/bootstrap';
import { useTaskStore } from '../stores/tasks';
import {
  ensurePermission,
  isIos,
  isStandalone,
  notificationsSupported,
  permissionState,
} from '../lib/notifications';
import { useSync } from '../hooks/useSync';
import { MAX_ATTEMPTS } from '../lib/sync/outbox';

type Props = {
  settings: SettingsType;
  onChange: (patch: Partial<SettingsType>) => Promise<void> | void;
};

type Snap = Awaited<ReturnType<typeof listBackups>>[number];

const dtf = new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' });
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

export default function Settings({ settings, onChange }: Props) {
  const load = useTaskStore((s) => s.load);
  const tasks = useTaskStore((s) => s.tasks);
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<ValidationReport['skipped']>([]);
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(() => permissionState());
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const { state: sync, signIn, signOut, syncNow } = useSync();

  const refresh = useCallback(async () => {
    setEst(await storageEstimate());
    setSnaps(await listBackups());
    setPersistent(
      typeof navigator !== 'undefined' && navigator.storage?.persisted
        ? await navigator.storage.persisted()
        : null,
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const standalone = useMemo(() => isStandalone(), []);
  const ios = useMemo(() => isIos(), []);

  async function doExport() {
    setBusy(true);
    try {
      const { json, count, size } = await exportTasks();
      // no server anywhere: the file leaves the browser as a plain download
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mahami-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(`تصدّر ${count} مهمة (${mb(size)}).`);
    } finally {
      setBusy(false);
    }
  }

  async function doImport(file: File) {
    setBusy(true);
    try {
      const text = await file.text();
      const res = await importTasks(text);
      setInvalid(res.invalid);
      setNotice(
        `تستوردو ${res.imported} مهمة · تعتلو ${res.skipped.length} (نسخة محلية أحدث) · ترفض ${res.invalid.length}.`,
      );
      await load();
      await refresh();
    } catch (e) {
      setNotice(`فشل الاستيراد: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function doBackupNow() {
    setBusy(true);
    try {
      const { count, size, id } = await backupTasks('manual');
      setNotice(id ? `تدارت نسخة: ${count} مهمة (${mb(size)}).` : 'ما كاين ما ينسخ.');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function doRestore(id: string) {
    if (!confirm('الاسترجاع كيعاود يدمج النسخة مع الداتا الحالية. متأكد؟')) return;
    setBusy(true);
    try {
      const res = await restoreFromBackup(id);
      setNotice(`ترجعو ${res.imported} مهمة · ${res.keptLocal} بقاو محليين.`);
      await load();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function doWipe() {
    if (!confirm('غادي يتحيد كلشي (المهام + النسخ). ما كاينش رجوع. متأكد؟')) return;
    await wipeAllData();
    await load();
    await refresh();
    setNotice('تحيد كلشي.');
  }

  return (
    <section className="space-y-4">
      {notice && (
        <p className="card border-violet-500/40 bg-violet-500/10 text-sm" role="status">
          {notice}
        </p>
      )}

      {/* sync results surface here: same slot as every other action's feedback */}
      {(sync.error || sync.message) && (
        <p
          className={`card text-sm ${
            sync.error ? 'border-red-500/40 bg-red-500/10 text-red-100' : 'border-surface-line'
          }`}
          role="status"
        >
          {sync.error ?? sync.message}
        </p>
      )}

      {/* ---------- storage ---------- */}
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold">التخزين</h2>
        <p className="text-sm text-slate-300">
          {est ? `مستعمل: ${mb(est.usage)} من ${mb(est.quota)}` : 'التقدير ماشي متوفر فهاد المتصفح.'}
        </p>
        <p className="text-xs text-slate-400">
          الحفظ الدائم: {persistent === null ? 'ماشي مدعوم' : persistent ? 'مفعّل ✓' : 'ماشي مفعّل'}
        </p>

        {persistent === false && ios && !standalone && (
          <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
            فـ iPhone/iPad، Safari كيقدر يمسح داتا الموقع من بعد 7 أيام بلا استعمال — و`persist()`
            ما كيسولاش على الإذن أصلاً. الحل الوحيد: <strong>شارك ← إضافة إلى الشاشة الرئيسية</strong>{' '}
            (التطبيق المثبّت معفي من هاد القاعدة).
          </p>
        )}

        {persistent === false && !ios && (
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={async () => {
              const ok = await requestPersistentStorage();
              setPersistent(ok);
              setNotice(ok ? 'تفعّل الحفظ الدائم.' : 'المتصفح رفض الحفظ الدائم — التصدير اليدوي هو الأمان.');
            }}
          >
            طلب الحفظ الدائم
          </button>
        )}

        <p className="text-xs text-slate-400">
          آخر نسخة داخلية: {snaps.length ? dtf.format(new Date(snaps[0].createdAt)) : 'ما كايناش'}
        </p>
      </div>

      {/* ---------- backup / restore ---------- */}
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold">النسخ الاحتياطي</h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" onClick={() => void doExport()} disabled={busy}>
            تصدير JSON
          </button>
          <label className="btn-ghost cursor-pointer">
            استيراد JSON
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void doImport(f);
                e.target.value = '';
              }}
            />
          </label>
          <button type="button" className="btn-ghost" onClick={() => void doBackupNow()} disabled={busy}>
            نسخة دابا
          </button>
        </div>

        {invalid.length > 0 && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
            <p className="mb-1 font-medium">{invalid.length} سجل ترفض (Zod):</p>
            <ul className="space-y-0.5">
              {invalid.slice(0, 5).map((s) => (
                <li key={`${s.index}-${s.reason}`}>
                  #{s.index}: {s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        <ul className="space-y-2">
          {snaps.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 rounded-xl bg-surface-line/30 px-3 py-2 text-xs">
              <span>
                {dtf.format(new Date(s.createdAt))} · {s.count} مهمة · {mb(s.size)} · {s.reason}
              </span>
              <button type="button" className="btn-ghost px-2 py-1" onClick={() => void doRestore(s.id)} disabled={busy}>
                استرجاع
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* ---------- sync (Phase 2) ---------- */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">المزامنة</h2>
          <span className="text-xs text-slate-400">
            {!sync.configured
              ? 'غير مفعّلة'
              : !sync.connected
                ? 'غير متصل'
                : sync.syncing
                  ? 'كنزامن…'
                  : sync.online
                    ? 'متصل'
                    : 'بلا أنترنيت'}
          </span>
        </div>

        {!sync.configured ? (
          <p className="text-xs text-slate-400">
            هاد النسخة مبنية بلا إعدادات Supabase، إذن المزامنة <strong>ما كايناش</strong> — ماشي معطّلة.
            التطبيق كامل خدّام محلياً فـIndexedDB كيما قبل.
          </p>
        ) : !sync.connected ? (
          <>
            <p className="text-xs text-slate-400">
              دخل بالإيميل باش تلقى مهامك فكل أجهزتك. <strong>بلا كلمة سر</strong> — كنصيفطو ليك رابط.
              داتاك المحلية ما كتتمسحش: إلا كان الحساب خاوي، كنرفعو المهام ديالك ليه. إلا كان فيه داتا،
              كنزلوها هي (الحساب كيغلب).
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                type="email"
                dir="ltr"
                placeholder="name@example.com"
                className="min-w-[14rem] flex-1 rounded-xl border border-surface-line bg-surface px-3 py-2 text-sm"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button
                type="button"
                className="btn-primary"
                disabled={busy || !email.includes('@')}
                onClick={async () => {
                  setBusy(true);
                  await signIn(email.trim());
                  setBusy(false);
                }}
              >
                صيفط رابط الدخول
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-300" dir="ltr">
              {sync.email}
            </p>
            <ul className="space-y-1 text-xs text-slate-400">
              <li>
                آخر مزامنة:{' '}
                {sync.lastSyncAt ? dtf.format(new Date(sync.lastSyncAt)) : 'مازال ما تزامناش'}
              </li>
              <li>
                عمليات في الانتظار: {sync.pending}
                {sync.parked > 0 && ` · عالقة: ${sync.parked}`}
              </li>
            </ul>

            {sync.parked > 0 && (
              <p className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
                {sync.parked} عملية فشلت {MAX_ATTEMPTS} مرات وتوقّفت. اضغط «زامن دابا» باش تعاود من الصفر.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-ghost"
                disabled={sync.syncing}
                onClick={() => void syncNow()}
              >
                {sync.syncing ? 'كنزامن…' : 'زامن دابا'}
              </button>
              <button type="button" className="btn-ghost" onClick={() => void signOut()}>
                خروج
              </button>
            </div>
            <p className="text-xs text-slate-400">
              الخروج كيحيّد الجلسة فقط. <strong>المهام والعمليات المعلّقة كيبقاو محليين</strong> — ما
              كيتحيدش والو من IndexedDB.
            </p>
          </>
        )}
      </div>

      {/* ---------- preferences ---------- */}
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold">التفضيلات</h2>
        <label className="flex items-center justify-between text-sm">
          <span>الثيم</span>
          <select
            className="rounded-xl border border-surface-line bg-surface px-3 py-2"
            value={settings.theme}
            onChange={(e) => void onChange({ theme: e.target.value as SettingsType['theme'] })}
          >
            <option value="dark">غامق</option>
            <option value="light">فاتح</option>
            <option value="system">حسب النظام</option>
          </select>
        </label>

        <label className="flex items-center justify-between text-sm">
          <span>تنبيهات قبل التسليم</span>
          {notificationsSupported() ? (
            <input
              type="checkbox"
              className="h-5 w-5 accent-violet-600"
              checked={settings.remindersEnabled && perm === 'granted'}
              onChange={async (e) => {
                if (e.target.checked) {
                  const state = await ensurePermission();
                  setPerm(state);
                  await onChange({ remindersEnabled: state === 'granted' });
                  if (state !== 'granted') setNotice('المتصفح رفض إذن التنبيهات.');
                } else {
                  await onChange({ remindersEnabled: false });
                }
              }}
            />
          ) : (
            <span className="text-xs text-slate-400">ماشي مدعوم فهاد المتصفح</span>
          )}
        </label>

        <label className="flex items-center justify-between text-sm">
          <span>التنبيه قبل (دقايق)</span>
          <input
            type="number"
            min={0}
            max={1440}
            className="w-24 rounded-xl border border-surface-line bg-surface px-3 py-2"
            value={settings.reminderLeadMinutes}
            onChange={(e) => void onChange({ reminderLeadMinutes: Number(e.target.value) })}
          />
        </label>
      </div>

      {/* ---------- danger ---------- */}
      <div className="card border-red-500/30">
        <h2 className="mb-2 text-sm font-semibold text-red-300">منطقة الخطر</h2>
        <p className="mb-3 text-xs text-slate-400">
          {tasks.length} مهمة مخزّنة محلياً. صدّر JSON قبل ما تمسح.
        </p>
        <button type="button" className="btn-ghost border-red-500/40 text-red-200" onClick={() => void doWipe()}>
          حذف كل الداتا
        </button>
      </div>
    </section>
  );
}
