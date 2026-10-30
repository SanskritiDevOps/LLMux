/**
 * A state shown as colour plus text, never colour alone. `cancelled` is neutral: the
 * client chose to stop, so it isn't a failure.
 */
const STYLES = {
  success: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30",
  closed: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30",
  cached: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30",
  error: "bg-rose-400/10 text-rose-300 ring-rose-400/30",
  open: "bg-rose-400/10 text-rose-300 ring-rose-400/30",
  fallback: "bg-amber-400/10 text-amber-300 ring-amber-400/30",
  estimated: "bg-amber-400/10 text-amber-300 ring-amber-400/30",
  "half-open": "bg-amber-400/10 text-amber-300 ring-amber-400/30",
  cancelled: "bg-slate-400/10 text-slate-300 ring-slate-400/30",
  revoked: "bg-slate-400/10 text-slate-400 ring-slate-400/30",
  "not configured": "bg-slate-400/10 text-slate-400 ring-slate-400/30",
};

const LABELS = { closed: "circuit closed", open: "circuit open", "half-open": "half-open" };

export function StatusBadge({ status, label }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STYLES[status] ?? STYLES.cancelled}`}
    >
      {label ?? LABELS[status] ?? status}
    </span>
  );
}
