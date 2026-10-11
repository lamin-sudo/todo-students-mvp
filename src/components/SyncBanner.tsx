import { useSync } from '../hooks/useSync';

const dtf = new Intl.DateTimeFormat('ar', { dateStyle: 'short', timeStyle: 'short' });

/**
 * The one honest signal about sync state.
 *
 * It shows nothing at all while everything is settled — a permanent "synced ✓"
 * badge is noise that trains people to ignore the bar. It only appears when
 * there is something the user should know: work waiting, work stuck, or a
 * connection problem.
 */
export default function SyncBanner() {
  const { state, syncNow } = useSync();
  if (!state.configured || !state.connected) return null;

  const waiting = state.pending > 0;
  const stuck = state.parked > 0;
  const offline = !state.online;
  if (!waiting && !stuck && !offline) return null;

  const tone = stuck
    ? 'border-red-500/40 bg-red-500/10 text-red-100'
    : offline || waiting
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
      : 'border-surface-line';

  return (
    <div className={`card mb-4 flex flex-wrap items-center justify-between gap-2 text-xs ${tone}`} role="status">
      <span>
        {stuck ? `${state.parked} عملية عالقة` : offline ? 'بلا أنترنيت' : 'غير متزامن'}
        {waiting && ` — ${state.pending} ${state.pending === 1 ? 'عملية' : 'عمليات'} في الانتظار`}
        {state.lastSyncAt && ` · آخر مزامنة ${dtf.format(new Date(state.lastSyncAt))}`}
      </span>
      <button
        type="button"
        className="btn-ghost px-2 py-1"
        disabled={state.syncing || offline}
        onClick={() => void syncNow()}
      >
        {state.syncing ? 'كنزامن…' : 'زامن دابا'}
      </button>
    </div>
  );
}
