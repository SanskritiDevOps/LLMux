import { formatMs, formatNumber, formatUsd } from "../lib/format.js";
import { ErrorNotice } from "./ErrorNotice.jsx";
import { ProviderBadge } from "./ProviderBadge.jsx";
import { StatusBadge } from "./StatusBadge.jsx";

function Figure({ label, value }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-sm font-medium text-slate-100 tabular-nums">{value}</dd>
    </div>
  );
}

const FINISH_LABELS = {
  stop: null,
  length: "Cut off at max tokens",
  content_filter: "Declined by the provider",
  error: "Ended unexpectedly",
};

/**
 * A live answer: text as it arrives (announced politely to screen readers), a blinking
 * cursor while streaming, then provider, time to first token, latency, tokens and cost.
 *
 * @param {{ title: string, stream: ReturnType<typeof import("../features/playground/usePlaygroundStream.js").usePlaygroundStream> }} props
 */
export function StreamOutput({ title, stream }) {
  const { status, text, provider, ttftMs, end, error } = stream;
  const live = status === "waiting" || status === "streaming";
  const finishNote = end && FINISH_LABELS[end.finishReason];

  return (
    <section className="flex min-h-64 flex-col rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-slate-300">{title}</h2>
        {provider && <ProviderBadge provider={provider} />}
      </div>

      <div
        aria-live="polite"
        aria-busy={live}
        className="flex-1 text-sm leading-relaxed whitespace-pre-wrap text-slate-100"
      >
        {status === "idle" && <p className="text-slate-500">The answer appears here.</p>}
        {text}
        {live && (
          <span
            aria-hidden="true"
            className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-indigo-400 align-text-bottom motion-reduce:animate-none"
          />
        )}
        {status === "stopped" && <p className="mt-2 text-xs text-slate-400">Stopped.</p>}
      </div>

      {error && <ErrorNotice error={error} title="The chat failed" className="mt-3" />}
      {finishNote && (
        <div className="mt-3">
          <StatusBadge status="fallback" label={finishNote} />
        </div>
      )}

      {(ttftMs !== null || end) && (
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-800 pt-3 sm:grid-cols-4">
          <Figure label="First token" value={formatMs(ttftMs)} />
          <Figure label="Total" value={end ? formatMs(end.latencyMs) : "…"} />
          <Figure
            label={end?.usageEstimated ? "Tokens (estimated)" : "Tokens in / out"}
            value={
              end
                ? `${formatNumber(end.usage.inputTokens)} / ${formatNumber(end.usage.outputTokens)}`
                : "…"
            }
          />
          <Figure label="Cost" value={end ? formatUsd(end.costUsd) : "…"} />
        </dl>
      )}
    </section>
  );
}
