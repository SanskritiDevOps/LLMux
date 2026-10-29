import { Skeleton } from "./Skeleton.jsx";

/** One headline number with its label, and an optional caption under it. */
export function StatTile({ label, value, caption, loading = false }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <p className="text-sm text-slate-400">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-9 w-24" />
      ) : (
        <p className="mt-1 text-3xl font-semibold text-slate-100 tabular-nums">{value}</p>
      )}
      {caption && !loading && <p className="mt-1 text-xs text-slate-400">{caption}</p>}
    </div>
  );
}
