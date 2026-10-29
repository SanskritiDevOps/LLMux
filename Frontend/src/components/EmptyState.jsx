/** What a view shows when there is nothing yet: a title, a sentence, and what to do next. */
export function EmptyState({ title, children, action, className = "" }) {
  return (
    <div
      className={`rounded-lg border border-dashed border-slate-700 p-8 text-center ${className}`}
    >
      <p className="text-lg font-medium text-slate-100">{title}</p>
      {children && <div className="mx-auto mt-2 max-w-xl text-sm text-slate-400">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
