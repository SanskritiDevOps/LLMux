import { Button } from "./Button.jsx";

/**
 * An API error as the user sees it: what went wrong, the error code, and the requestId
 * to look up in the server logs.
 *
 * @param {{ error: Error & { code?: string, requestId?: string }, title?: string,
 *   onRetry?: () => void, className?: string }} props
 */
export function ErrorNotice({ error, title = "Something went wrong", onRetry, className = "" }) {
  return (
    <div
      role="alert"
      className={`rounded-lg border border-rose-400/40 bg-rose-950/30 p-4 text-sm ${className}`}
    >
      <p className="font-medium text-rose-300">{title}</p>
      <p className="mt-1 text-slate-200">{error?.message ?? "Unknown error"}</p>
      <p className="mt-2 text-xs text-slate-400">
        {error?.code && <span className="font-mono">{error.code}</span>}
        {error?.requestId && (
          <>
            {" · request "}
            <span className="font-mono select-all">{error.requestId}</span>
          </>
        )}
      </p>
      {onRetry && (
        <Button variant="secondary" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
